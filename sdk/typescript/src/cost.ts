import { parseJson } from "./value.js";
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "./record.js";
import {
  estimateScanCost,
  tokenUsage,
  type ScanCost,
  type ScanTokenUsage,
} from "./cost-model.js";
import {
  scanActivityFromSessionEvent,
  type ScanActivity,
} from "./scan-activity.js";
import {
  isScanArtifactDirectory,
  sessionOwnsTurn,
  sessionParentThreadId,
  sessionStartedAt,
} from "./scan-sessions.js";
import {
  scanProgressUpdatesFromText,
  type ScanProgress,
} from "./worker-progress.js";

export { estimateScanCost, formatUsd, type ScanCost } from "./cost-model.js";

/** A persisted worker session discovered during this run. Contains no model text. */
export interface ScanWorkerEvent {
  kind: "observed";
  /** Scan-local number shared with activity and session observers. */
  worker: number;
}

export interface ScanSessionEvent {
  threadId: string;
  parentThreadId: string | null;
  worker?: number;
  event: Record<string, unknown>;
}

interface SessionReasoning {
  id: string;
  text: string;
  raw: boolean;
  activity: ScanActivity | null;
}

interface SessionProgress {
  update: ScanProgress;
  order?: number;
  position: number;
  completion: boolean;
  markerIndex: number;
  receipt: boolean;
  duplicate: boolean;
  unresolvedProjection?: boolean;
}

interface ProgressItem {
  kind: "message" | "command";
  outputDigest: string;
  persistedOutputDigest: string;
  commandDigest?: string;
}

type ProgressOccurrenceQueues = Map<
  string,
  { indexes: number[]; next: number }
>;

interface NativeProgressItem extends ProgressItem {
  updates: ScanProgress[];
}

interface SessionCompletion {
  position: number;
  item: ProgressItem | null;
}

interface UnresolvedParentCommand {
  live: StreamedProgressItem;
  completion: SessionCompletion;
  truncated: boolean;
}

export type ParentProgressSource =
  | {
      event: Readonly<Record<string, unknown>>;
      reconciled?: false;
      inventory?: never;
    }
  | { reconciled: true; inventory?: true };

interface ParentProgressMarker {
  progress: ScanProgress;
  index: number;
  order: number;
  accepted: boolean;
}

interface ProgressOrder {
  order: number;
  position?: number;
  markerIndex?: number;
}

interface OrderedProgress extends ProgressOrder {
  progress: ScanProgress;
}

// Positions compare phases from the same parent source. Observation order is
// the fallback for missing provenance and independent worker receipts.
function compareProgressOrder(
  left: ProgressOrder,
  right: ProgressOrder,
): number {
  if (left.position !== undefined && right.position !== undefined)
    return (
      left.position - right.position ||
      (left.markerIndex ?? 0) - (right.markerIndex ?? 0)
    );
  return left.order - right.order;
}

interface StreamedProgressItem {
  markers: ParentProgressMarker[];
  item: ProgressItem | null;
  position: number | null;
}

interface SessionUsage {
  offset: number;
  decoder: StringDecoder;
  pendingLine: string[];
  unreadable: boolean;
  threadId: string | null;
  parentThreadId: string | null;
  workingDirectory: string | null;
  startedAt: number | null;
  inheritedUsage: ScanTokenUsage | null;
  replaying: boolean;
  usage: ScanTokenUsage | null;
  calls: Map<string, ScanActivity>;
  activities: ScanActivity[];
  progress: SessionProgress[];
  position: number;
  completions: SessionCompletion[];
  latestWorkerProgress: OrderedProgress | null;
  pendingWorkerProgress: Map<number, { progress: ScanProgress; order: number }>;
  messageProjections: Map<
    string,
    { native: number; event: number; response: number }
  >;
  filesCompleted: number;
  filesTotal: number | null;
  prose: Set<string>;
  reasoning: SessionReasoning | null;
  reasoningCount: number;
  events?: Record<string, unknown>[];
}

interface ScanCostTrackerOptions {
  codexHome: string;
  model: string;
  repository?: string;
  scanDirectory?: string;
  maxCostUsd?: number;
  expectedFilesTotal?: number;
  onCost?: (cost: Readonly<ScanCost>) => void;
  onUsage?: (usage: Readonly<ScanTokenUsage>) => void;
  onActivity?: (activity: ScanActivity) => void;
  onProgress?: (progress: ScanProgress, source?: ParentProgressSource) => void;
  onSessionEvent?: (event: ScanSessionEvent) => void;
  onWorkerEvent?: (event: ScanWorkerEvent) => void;
  onError?: (error: unknown) => void;
}

interface ScanCostSnapshot {
  usage: unknown;
  cost: ScanCost | null;
}

const COST_POLL_INTERVAL_MS = 100;
const SESSION_READ_SIZE = 64 * 1_024;

function createSessionUsage(): SessionUsage {
  return {
    offset: 0,
    decoder: new StringDecoder("utf8"),
    pendingLine: [],
    unreadable: false,
    threadId: null,
    parentThreadId: null,
    workingDirectory: null,
    startedAt: null,
    inheritedUsage: null,
    replaying: false,
    usage: null,
    calls: new Map(),
    activities: [],
    progress: [],
    position: 0,
    completions: [],
    latestWorkerProgress: null,
    pendingWorkerProgress: new Map(),
    messageProjections: new Map(),
    filesCompleted: 0,
    filesTotal: null,
    prose: new Set(),
    reasoning: null,
    reasoningCount: 0,
  };
}

export class ScanCostTracker {
  readonly #options: ScanCostTrackerOptions;
  readonly #sessions = new Map<string, SessionUsage>();
  readonly #receipts = new Map<string, ScanTokenUsage | null>();
  readonly #workers = new Map<string, number>();
  readonly #workerProgress = new Map<string, number>();
  readonly #liveParentProgress = new Set<string>();
  readonly #liveParentItems: StreamedProgressItem[] = [];
  #liveParentEvents = new WeakMap<
    Readonly<Record<string, unknown>>,
    StreamedProgressItem
  >();
  #acceptedParent: StreamedProgressItem | null = null;
  // Global coverage admitted from either the live or saved parent projection.
  #parentProgress: OrderedProgress | null = null;
  readonly #parentFacts = new Map<number, OrderedProgress>();
  #parentInventory: ParentProgressMarker | null = null;
  #parentReviewStart: { position: number; markerIndex: number } | null = null;
  readonly #readyParentMarkers = new Map<
    ParentProgressMarker,
    StreamedProgressItem
  >();
  #inventoryFrontier = {
    position: 0,
    markerIndex: -1,
    filesTotal: undefined as number | undefined,
  };
  #progressOrder = 0;
  #displayedProgress:
    | (ProgressOrder & {
        update: ScanProgress;
        owner: "live" | "parent" | "worker";
      })
    | null = null;
  #matchedParentItems = 0;
  #parentCompletionCursor = 0;
  #indexedParentCompletions = 0;
  #indexedParentItems = 0;
  readonly #parentCompletionKeys: ProgressOccurrenceQueues = new Map();
  readonly #parentItemKeys: ProgressOccurrenceQueues = new Map();
  readonly #parentMatches: number[] = [];
  readonly #pendingParentMatches = new Set<number>();
  #parentSession: SessionUsage | null = null;
  #parentTurnStartKnown = true;
  #parentFrontier = { position: 0, markerIndex: -1 };
  #threadId: string | null = null;
  #observingWorkers = true;
  #timer: NodeJS.Timeout | null = null;
  #pending: Promise<void> = Promise.resolve();
  #snapshot: ScanCostSnapshot = { usage: null, cost: null };
  #lastCost: string | null = null;
  #lastUsage: string | null = null;
  #highestFilesCompleted = 0;
  #expectedFilesTotal: number | undefined;
  #inventoryNeedsReconciliation = false;

  public constructor(options: ScanCostTrackerOptions) {
    this.#options = options;
    if (options.expectedFilesTotal !== undefined)
      this.setExpectedFilesTotal(options.expectedFilesTotal);
  }

  public setExpectedFilesTotal(filesTotal: number): void {
    if (
      this.#expectedFilesTotal !== undefined &&
      this.#expectedFilesTotal !== filesTotal
    )
      this.#inventoryNeedsReconciliation = true;
    this.#expectedFilesTotal = filesTotal;
  }

  /** Called before launching a turn, after loading any resumed history. */
  public beginParentTurn(resumed = false): void {
    this.#parentTurnStartKnown = this.#parentSession !== null || !resumed;
    this.#liveParentItems.length = 0;
    this.#liveParentEvents = new WeakMap();
    this.#acceptedParent = null;
    this.#parentInventory = null;
    // Historical logs may omit projection kinds emitted by the new turn.
    this.#parentSession?.messageProjections.clear();
    for (const completion of this.#parentSession?.completions ?? [])
      completion.item = null;
    this.#readyParentMarkers.clear();
    this.#matchedParentItems = 0;
    this.#parentCompletionCursor = this.#parentSession?.completions.length ?? 0;
    this.#indexedParentCompletions = this.#parentCompletionCursor;
    this.#indexedParentItems = 0;
    this.#parentCompletionKeys.clear();
    this.#parentItemKeys.clear();
    this.#parentMatches.length = 0;
    this.#pendingParentMatches.clear();
    this.#liveParentProgress.clear();
  }

  /** Observe every supported completion so repeated output keeps its occurrence. */
  public recordParentItem(event: Readonly<Record<string, unknown>>): void {
    const item = event["item"];
    if (
      event["type"] !== "item.completed" ||
      !isRecord(item) ||
      (item["type"] !== "command_execution" &&
        item["type"] !== "agent_message") ||
      this.#liveParentEvents.has(event)
    )
      return;
    const live: StreamedProgressItem = {
      markers: [],
      item: streamedProgressItem(event),
      position: null,
    };
    this.#liveParentItems.push(live);
    this.#liveParentEvents.set(event, live);
    this.#matchParentCompletions();
  }

  /** Observe source identity before applying display/count guards. */
  public recordParentProgress(
    progress: ScanProgress,
    event: Readonly<Record<string, unknown>>,
  ): boolean {
    this.recordParentItem(event);
    const live = this.#liveParentEvents.get(event);
    if (live === undefined) return true;
    // Parsed rows were observed before this live marker even when their
    // file.close is still pending. Do not give that old snapshot a later order.
    for (const session of this.#sessions.values())
      if (session.threadId === this.#threadId)
        for (const saved of session.progress)
          saved.order ??= ++this.#progressOrder;
    const marker = {
      progress,
      index: live.markers.length,
      order: ++this.#progressOrder,
      accepted: false,
    };
    live.markers.push(marker);
    if (progress.phase === "discovery" && progress.filesCompleted === 0)
      this.#parentInventory = marker;
    if (live.position !== null) this.#readyParentMarkers.set(marker, live);
    const current = this.#parentFacts.get(progress.filesTotal);
    return (
      live.position === null ||
      this.#afterParentFrontier(live.position, marker.index) ||
      // Polling can admit this completion before live delivery. Its live copy
      // restores progress after worker output or an unmatched live completion;
      // older proved positions and earlier markers remain stale.
      ((this.#displayedProgress?.owner === "worker" ||
        (this.#displayedProgress?.owner === "live" &&
          this.#displayedProgress.position === undefined)) &&
        ((live.position === this.#parentFrontier.position &&
          marker.index === this.#parentFrontier.markerIndex) ||
          (current?.position === this.#parentFrontier.position &&
            current.markerIndex === this.#parentFrontier.markerIndex &&
            progressKey(current.progress) === progressKey(progress))))
    );
  }

  /** Source acceptance is independent of duplicate observer notifications. */
  public acceptParentProgress(
    progress: ScanProgress,
    event: Readonly<Record<string, unknown>>,
  ): void {
    const live = this.#liveParentEvents.get(event);
    if (live === undefined) return;
    const marker = live.markers.at(-1);
    if (marker === undefined) return;
    marker.accepted = true;
    this.#acceptedParent = live;
    const provenance = {
      order: marker.order,
      ...(live.position === null
        ? {}
        : { position: live.position, markerIndex: marker.index }),
    };
    this.#parentProgress = { progress, ...provenance };
    this.#rememberParentFact(this.#parentProgress);
    const update = {
      ...progress,
      filesTotal: this.#expectedFilesTotal ?? progress.filesTotal,
    };
    this.#displayedProgress = { update, owner: "live", ...provenance };
    this.#highestFilesCompleted = Math.max(
      this.#highestFilesCompleted,
      progress.filesCompleted,
    );
    this.#liveParentProgress.add(progressKey(progress));
    if (live.position !== null) {
      this.#recordParentReview(progress, live.position, marker.index);
      if (this.#afterParentFrontier(live.position, marker.index))
        this.#parentFrontier = {
          position: live.position,
          markerIndex: marker.index,
        };
    }
  }

  #rememberParentFact(candidate: OrderedProgress): void {
    // Unbound live markers stay in the existing completion queue until their
    // saved occurrence resolves. Inventory markers have their own frontier.
    if (
      candidate.position === undefined ||
      (candidate.progress.phase === "discovery" &&
        candidate.progress.filesCompleted === 0)
    )
      return;
    const total = candidate.progress.filesTotal;
    const previous = this.#parentFacts.get(total);
    if (
      previous === undefined ||
      candidate.progress.filesCompleted > previous.progress.filesCompleted ||
      (candidate.progress.filesCompleted === previous.progress.filesCompleted &&
        compareProgressOrder(candidate, previous) > 0)
    )
      this.#parentFacts.set(total, candidate);
  }

  #recordParentReview(
    progress: ScanProgress,
    position: number,
    markerIndex: number,
  ): void {
    if (progress.filesCompleted === 0) return;
    const first = this.#parentReviewStart;
    if (
      first === null ||
      position < first.position ||
      (position === first.position && markerIndex < first.markerIndex)
    )
      this.#parentReviewStart = { position, markerIndex };
  }

  #precedesParentReview(position: number, markerIndex: number): boolean {
    const first = this.#parentReviewStart;
    return (
      first !== null &&
      (position < first.position ||
        (position === first.position && markerIndex < first.markerIndex))
    );
  }

  #afterParentFrontier(position: number, index: number): boolean {
    return (
      position > this.#parentFrontier.position ||
      (position === this.#parentFrontier.position &&
        index > this.#parentFrontier.markerIndex)
    );
  }

  #unresolvedParentCommand(
    session: SessionUsage,
  ): UnresolvedParentCommand | undefined {
    const live = this.#acceptedParent;
    if (
      !this.#parentTurnStartKnown ||
      live?.position !== null ||
      live.item?.kind !== "command" ||
      this.#liveParentItems.indexOf(live) < this.#matchedParentItems ||
      this.#parentProgress === null ||
      this.#parentProgress.position !== undefined
    )
      return undefined;
    const item = live.item;
    for (
      let index = session.completions.length - 1;
      index >= this.#parentCompletionCursor;
      index--
    ) {
      const completion = session.completions[index]!;
      if (
        completion.item?.kind === "command" &&
        (completion.item.outputDigest === item.outputDigest ||
          completion.item.outputDigest === item.persistedOutputDigest)
      )
        return {
          live,
          completion,
          truncated: completion.item.outputDigest !== item.outputDigest,
        };
    }
    return undefined;
  }

  #matchParentCompletions(): void {
    if (this.#parentSession === null || !this.#parentTurnStartKnown) return;
    const completions = this.#parentSession.completions;
    // Ordinary live completions can be dropped by native queue backpressure.
    // Match ordered signatures, not list indexes. Identical output signatures
    // remain ambiguous; use the earliest compatible occurrence after our anchor.
    const add = (
      index: number,
      key: string,
      queues: ProgressOccurrenceQueues,
    ) => {
      let queue = queues.get(key);
      if (queue === undefined) {
        queue = { indexes: [], next: 0 };
        queues.set(key, queue);
      }
      queue.indexes.push(index);
      this.#queueParentMatch(key);
    };
    while (this.#indexedParentCompletions < completions.length) {
      const index = this.#indexedParentCompletions++;
      const item = completions[index]!.item;
      if (item !== null)
        add(index, progressItemKey(item), this.#parentCompletionKeys);
    }
    while (this.#indexedParentItems < this.#liveParentItems.length) {
      const index = this.#indexedParentItems++;
      const item = this.#liveParentItems[index]!.item;
      if (item !== null)
        for (const key of progressItemKeys(item))
          add(index, key, this.#parentItemKeys);
    }
    while (this.#parentMatches.length > 0) {
      const index = takeFirstIndex(this.#parentMatches);
      this.#pendingParentMatches.delete(index);
      if (index < this.#matchedParentItems) continue;
      const live = this.#liveParentItems[index]!;
      if (live.item === null) continue;
      let matched: number | undefined;
      for (const key of progressItemKeys(live.item)) {
        const queue = this.#parentCompletionKeys.get(key);
        const savedIndex = queue?.indexes[queue.next];
        if (
          savedIndex !== undefined &&
          (matched === undefined || savedIndex < matched)
        )
          matched = savedIndex;
      }
      if (matched === undefined) continue;
      live.position = completions[matched]!.position;
      for (const marker of live.markers)
        this.#readyParentMarkers.set(marker, live);
      const changed = new Set<string>();
      const remove = (key: string, queues: ProgressOccurrenceQueues) => {
        const queue = queues.get(key)!;
        if (++queue.next === queue.indexes.length) queues.delete(key);
        changed.add(key);
      };
      // A compatible later anchor lets both prefixes advance. Without an
      // anchor, retain compact unmatched signatures: reads can precede writes
      // or native persistence can fail and later retry. Neither blocks other
      // compatible signatures, and each occurrence is indexed/consumed once.
      while (this.#matchedParentItems <= index) {
        const previous = this.#liveParentItems[this.#matchedParentItems++]!;
        if (previous.item !== null) {
          for (const key of progressItemKeys(previous.item))
            remove(key, this.#parentItemKeys);
          if (previous.position !== null) previous.item = null;
        }
      }
      while (this.#parentCompletionCursor <= matched) {
        const saved = completions[this.#parentCompletionCursor++]!;
        if (saved.item !== null) {
          remove(progressItemKey(saved.item), this.#parentCompletionKeys);
          if (saved.position === live.position) saved.item = null;
        }
      }
      for (const key of changed) this.#queueParentMatch(key);
    }
  }

  #queueParentMatch(key: string): void {
    if (!this.#parentCompletionKeys.has(key)) return;
    const queue = this.#parentItemKeys.get(key);
    const index = queue?.indexes[queue.next];
    if (index === undefined || this.#pendingParentMatches.has(index)) return;
    this.#pendingParentMatches.add(index);
    insertIndex(this.#parentMatches, index);
  }

  #corroboratedInventory(
    live: StreamedProgressItem,
    marker: ParentProgressMarker,
  ): ParentProgressMarker | undefined {
    if (
      !this.#parentTurnStartKnown ||
      marker.progress.filesCompleted === 0 ||
      live.position === null
    )
      return undefined;
    let inventory: ParentProgressMarker | undefined;
    let pending: StreamedProgressItem | undefined;
    for (
      let index = this.#liveParentItems.indexOf(live) - 1;
      index >= 0;
      index--
    ) {
      const candidate = this.#liveParentItems[index]!;
      inventory = candidate.markers.findLast(
        (observed) =>
          (observed.accepted || observed === this.#parentInventory) &&
          observed.progress.phase === "discovery" &&
          observed.progress.filesCompleted === 0 &&
          observed.progress.filesTotal === marker.progress.filesTotal,
      );
      if (inventory !== undefined) {
        pending = candidate;
        break;
      }
    }
    if (inventory === undefined || pending === undefined) return undefined;
    let position = pending.position;
    if (position === null) {
      const item = pending.item;
      if (
        item?.kind !== "command" ||
        (!inventory.accepted &&
          item.outputDigest === item.persistedOutputDigest)
      )
        return undefined;
      for (const completion of this.#parentSession?.completions ?? []) {
        if (
          completion.item?.kind !== "command" ||
          completion.item.outputDigest !== item.persistedOutputDigest
        )
          continue;
        if (position !== null) return undefined;
        position = completion.position;
      }
    }
    // A matched review can corroborate an accepted inventory or admit a lost
    // inventory without assigning its command a guessed occurrence. A later
    // inventory still wins, and duplicate lossy output remains ambiguous.
    return position !== null &&
      (position > this.#inventoryFrontier.position ||
        (pending.position !== null &&
          position === this.#inventoryFrontier.position &&
          inventory.index >= this.#inventoryFrontier.markerIndex)) &&
      (position < live.position ||
        (pending.position !== null &&
          position === live.position &&
          inventory.index < marker.index)) &&
      !this.#parentSession?.progress.some(
        (saved) =>
          saved.update.phase === "discovery" &&
          saved.update.filesCompleted === 0 &&
          (saved.position > position ||
            (pending.position !== null &&
              saved.position === position &&
              saved.markerIndex > inventory.index)) &&
          (saved.position < live.position! ||
            (saved.position === live.position &&
              saved.markerIndex < marker.index)),
      )
      ? inventory
      : undefined;
  }

  #reconcileParentProgress(): void {
    const ready = [...this.#readyParentMarkers];
    this.#readyParentMarkers.clear();
    for (const [marker, live] of ready) {
      if (live.position !== null)
        this.#rememberParentFact({
          progress: marker.progress,
          order: marker.order,
          position: live.position,
          markerIndex: marker.index,
        });
      if (marker.accepted && live.position !== null) {
        this.#recordParentReview(marker.progress, live.position, marker.index);
        const source = { position: live.position, markerIndex: marker.index };
        if (this.#parentProgress?.order === marker.order)
          Object.assign(this.#parentProgress, source);
        if (
          this.#displayedProgress?.owner !== "worker" &&
          this.#displayedProgress?.order === marker.order
        )
          Object.assign(this.#displayedProgress, source);
      }
    }
    let acceptedInventory:
      (ProgressOrder & { marker: ParentProgressMarker }) | undefined;
    for (const live of this.#liveParentItems) {
      for (const marker of live.markers) {
        if (
          !marker.accepted ||
          marker.progress.phase !== "discovery" ||
          marker.progress.filesCompleted !== 0
        )
          continue;
        const candidate = {
          marker,
          position: live.position ?? undefined,
          markerIndex: marker.index,
          order: marker.order,
        };
        if (
          acceptedInventory === undefined ||
          compareProgressOrder(candidate, acceptedInventory) > 0
        )
          acceptedInventory = candidate;
      }
    }
    let corrected:
      (OrderedProgress & { owner: "worker" | "live" | "parent" }) | null = null;
    const previousParent = this.#parentProgress;
    for (const [marker, live] of ready) {
      const position = live.position;
      if (position === null) continue;
      const corroborated = this.#corroboratedInventory(live, marker);
      const progress = (corroborated ?? marker).progress;
      if (
        marker === this.#parentInventory &&
        !marker.accepted &&
        (this.#parentProgress?.progress.filesCompleted ?? 0) > 0 &&
        this.#parentReviewStart === null
      ) {
        // A read can reach EOF before the next completion is appended, then
        // receive both live items while file.close is pending. Keep the compact
        // inventory proof until the admitted review's source position resolves.
        this.#readyParentMarkers.set(marker, live);
        continue;
      }
      if (
        (corroborated !== undefined ||
          marker === acceptedInventory?.marker ||
          (marker === this.#parentInventory &&
            ((this.#parentProgress?.progress.filesCompleted ?? 0) === 0 ||
              this.#precedesParentReview(position, marker.index)))) &&
        progress.phase === "discovery" &&
        progress.filesCompleted === 0 &&
        (position > this.#inventoryFrontier.position ||
          (position === this.#inventoryFrontier.position &&
            marker.index > this.#inventoryFrontier.markerIndex))
      ) {
        // Inventory may precede already-admitted review even when its full live
        // marker arrives later. For lossy output, the real matched review marks
        // the scope-proof boundary; the missing inventory position stays unknown.
        this.#inventoryFrontier = {
          position,
          markerIndex: marker.index,
          filesTotal: progress.filesTotal,
        };
        this.setExpectedFilesTotal(progress.filesTotal);
      }
    }
    const inventoryChanged = this.#inventoryNeedsReconciliation;
    this.#inventoryNeedsReconciliation = false;
    if (inventoryChanged) {
      const parentIneligible =
        this.#parentProgress !== null &&
        this.#parentProgress.progress.filesTotal > this.#expectedFilesTotal!;
      let retainedWorker: OrderedProgress | null = null;
      // Reconsider compact worker receipts under the proven inventory. Keep an
      // oversized receipt available without counting it as reviewed coverage.
      for (const session of this.#sessions.values()) {
        if (session.threadId === null || session.threadId === this.#threadId)
          continue;
        for (const [total, pending] of session.pendingWorkerProgress) {
          const progress = pending.progress;
          if (
            total > this.#expectedFilesTotal! ||
            (session.filesTotal !== null && total !== session.filesTotal) ||
            progress.filesCompleted < session.filesCompleted
          )
            continue;
          session.filesTotal = total;
          session.filesCompleted = progress.filesCompleted;
          const latest = session.latestWorkerProgress;
          if (
            latest === null ||
            progress.filesCompleted > latest.progress.filesCompleted ||
            pending.order > latest.order
          )
            session.latestWorkerProgress = pending;
          session.pendingWorkerProgress.delete(total);
          if (corrected === null || pending.order > corrected.order)
            corrected = { ...pending, owner: "worker" };
        }
        if (
          session.filesTotal !== null &&
          session.filesTotal <= this.#expectedFilesTotal!
        ) {
          this.#workerProgress.set(session.threadId, session.filesCompleted);
          const latest = session.latestWorkerProgress;
          if (
            latest !== null &&
            (retainedWorker === null || latest.order > retainedWorker.order)
          )
            retainedWorker = latest;
          if (
            parentIneligible &&
            latest !== null &&
            (corrected === null || latest.order > corrected.order)
          )
            corrected = { ...latest, owner: "worker" };
        } else this.#workerProgress.delete(session.threadId);
      }
      const parent = this.#parentProgress?.progress ?? null;
      const parentCount =
        parent !== null && parent.filesTotal <= this.#expectedFilesTotal!
          ? parent.filesCompleted
          : 0;
      // Scope growth can reveal already-accepted worker coverage without a new
      // pending phase. Keep an existing pending correction when one was chosen.
      const workerCoverage = Math.min(
        this.#expectedFilesTotal!,
        this.#workerProgress.values().reduce((sum, count) => sum + count, 0),
      );
      if (
        corrected === null &&
        retainedWorker !== null &&
        workerCoverage > this.#highestFilesCompleted &&
        workerCoverage > parentCount
      )
        corrected = { ...retainedWorker, owner: "worker" };
      this.#highestFilesCompleted = Math.max(parentCount, workerCoverage);
      if (this.#parentSession !== null) {
        this.#parentSession.filesCompleted = parentCount;
        this.#parentSession.filesTotal = this.#expectedFilesTotal!;
      }
    }
    const workerCoverage = Math.min(
      this.#expectedFilesTotal ?? Number.MAX_SAFE_INTEGER,
      this.#workerProgress.values().reduce((sum, count) => sum + count, 0),
    );
    for (const [marker, live] of ready) {
      const position = live.position;
      const progress = marker.progress;
      const deferredCoverage =
        !marker.accepted &&
        progress.filesCompleted > this.#highestFilesCompleted;
      if (
        position === null ||
        (!deferredCoverage &&
          !this.#afterParentFrontier(position, marker.index))
      )
        continue;
      const candidate: OrderedProgress & { owner: "live" } = {
        progress,
        order: marker.order,
        position,
        markerIndex: marker.index,
        owner: "live",
      };
      const selectedCoverage =
        corrected?.owner === "worker"
          ? workerCoverage
          : (corrected?.progress.filesCompleted ?? -1);
      // Do not let a newer, lower-coverage worker candidate mask a valid parent
      // correction before the final display guards can consider it.
      const preferCandidate =
        corrected === null ||
        progress.filesCompleted > selectedCoverage ||
        (progress.filesCompleted === selectedCoverage &&
          compareProgressOrder(candidate, corrected) > 0);
      if (!marker.accepted) {
        if (
          (this.#expectedFilesTotal !== undefined &&
            progress.filesTotal > this.#expectedFilesTotal) ||
          progress.filesCompleted < this.#highestFilesCompleted
        ) {
          // Saved inventory can admit the live receipt or invalidate provisional
          // worker coverage. Keep only the parsed fact until it is eligible.
          this.#readyParentMarkers.set(marker, live);
          continue;
        }
        marker.accepted = true;
        this.#acceptedParent = live;
        const selectedParent = this.#parentProgress;
        if (
          selectedParent === null ||
          selectedParent.progress.filesTotal >
            (this.#expectedFilesTotal ?? selectedParent.progress.filesTotal) ||
          progress.filesCompleted !== selectedParent.progress.filesCompleted ||
          compareProgressOrder(candidate, selectedParent) >= 0
        )
          this.#parentProgress = {
            progress,
            order: marker.order,
            position,
            markerIndex: marker.index,
          };
        this.#recordParentReview(progress, position, marker.index);
        this.#liveParentProgress.add(progressKey(progress));
        this.#highestFilesCompleted = progress.filesCompleted;
        if (preferCandidate) corrected = candidate;
      } else if (
        progress.filesTotal <=
          (this.#expectedFilesTotal ?? progress.filesTotal) &&
        this.#displayedProgress?.owner === "parent" &&
        compareProgressOrder(candidate, this.#displayedProgress) > 0 &&
        preferCandidate
      ) {
        corrected = candidate;
      }
      if (this.#afterParentFrontier(position, marker.index))
        this.#parentFrontier = { position, markerIndex: marker.index };
    }
    // Parent facts outlive display admission and queue draining. Preserve the
    // greatest eligible coverage for each original inventory, then source order.
    let eligible =
      this.#parentProgress !== null &&
      this.#parentProgress.progress.filesTotal <=
        (this.#expectedFilesTotal ?? Number.MAX_SAFE_INTEGER)
        ? this.#parentProgress
        : null;
    for (const candidate of this.#parentFacts.values()) {
      // Process preceding inventories before promoting a retained phase past
      // them. Their source order can still change the admitted coverage.
      if (
        this.#parentSession?.progress.some(
          (saved) =>
            saved.update.phase === "discovery" &&
            saved.update.filesCompleted === 0 &&
            (saved.position > this.#inventoryFrontier.position ||
              (saved.position === this.#inventoryFrontier.position &&
                saved.markerIndex > this.#inventoryFrontier.markerIndex)) &&
            (saved.position < candidate.position! ||
              (saved.position === candidate.position &&
                saved.markerIndex < candidate.markerIndex!)),
        )
      )
        continue;
      if (
        candidate.progress.filesTotal >
          (this.#expectedFilesTotal ?? Number.MAX_SAFE_INTEGER) ||
        candidate.progress.filesCompleted < workerCoverage
      )
        continue;
      if (
        eligible === null ||
        candidate.progress.filesCompleted > eligible.progress.filesCompleted ||
        (candidate.progress.filesCompleted ===
          eligible.progress.filesCompleted &&
          // Keep unresolved live authority until an exact later completion
          // releases its retained rows. Discarded prefix-only facts stay stale.
          (eligible.position !== undefined ||
            (this.#acceptedParent?.position === null &&
              this.#liveParentItems.indexOf(this.#acceptedParent) <
                this.#matchedParentItems &&
              this.#parentSession?.progress.some(
                (saved) =>
                  saved.order !== undefined &&
                  !saved.unresolvedProjection &&
                  saved.position === candidate.position &&
                  saved.markerIndex === candidate.markerIndex,
              ))) &&
          compareProgressOrder(candidate, eligible) > 0)
      )
        eligible = candidate;
    }
    if (eligible !== null && eligible !== this.#parentProgress) {
      this.#parentProgress = eligible;
      if (this.#afterParentFrontier(eligible.position!, eligible.markerIndex!))
        this.#parentFrontier = {
          position: eligible.position!,
          markerIndex: eligible.markerIndex!,
        };
      this.#recordParentReview(
        eligible.progress,
        eligible.position!,
        eligible.markerIndex!,
      );
      this.#highestFilesCompleted = Math.max(
        workerCoverage,
        eligible.progress.filesCompleted,
      );
      if (this.#parentSession !== null) {
        this.#parentSession.filesCompleted = eligible.progress.filesCompleted;
        this.#parentSession.filesTotal =
          this.#expectedFilesTotal ?? eligible.progress.filesTotal;
      }
      const correctedCoverage =
        corrected?.owner === "worker"
          ? workerCoverage
          : (corrected?.progress.filesCompleted ?? -1);
      if (
        corrected === null ||
        eligible.progress.filesCompleted > correctedCoverage ||
        (eligible.progress.filesCompleted === correctedCoverage &&
          compareProgressOrder(eligible, corrected) > 0)
      )
        corrected = { ...eligible, owner: "parent" };
    }
    const displayed = this.#displayedProgress;
    const displayedParentIneligible =
      displayed !== null &&
      displayed.owner !== "worker" &&
      previousParent !== null &&
      previousParent.progress.filesTotal >
        (this.#expectedFilesTotal ?? Number.MAX_SAFE_INTEGER) &&
      compareProgressOrder(previousParent, displayed) === 0;
    if (!inventoryChanged && corrected === null) return;
    const correctedCoverage =
      corrected?.owner === "worker"
        ? workerCoverage
        : (corrected?.progress.filesCompleted ?? 0);
    const replacePhase =
      corrected !== null &&
      correctedCoverage >= this.#highestFilesCompleted &&
      (displayed === null ||
        displayedParentIneligible ||
        correctedCoverage > displayed.update.filesCompleted ||
        compareProgressOrder(corrected, displayed) >= 0);
    const selected = replacePhase ? corrected : displayed;
    const parent = this.#parentProgress;
    const parentAtEqualCoverage =
      selected?.owner === "worker" &&
      parent !== null &&
      parent.progress.filesCompleted === this.#highestFilesCompleted &&
      parent.progress.filesTotal <=
        (this.#expectedFilesTotal ?? parent.progress.filesTotal);
    const phase = parentAtEqualCoverage
      ? parent.progress.phase
      : replacePhase
        ? corrected!.progress.phase
        : (displayed?.update.phase ?? "discovery");
    const progress = {
      phase,
      filesCompleted: this.#highestFilesCompleted,
      filesTotal:
        this.#expectedFilesTotal ??
        corrected?.progress.filesTotal ??
        displayed!.update.filesTotal,
    };
    const key = progressKey(progress);
    // An initial zero-count discovery already reported this inventory. Other
    // equal raw keys can still require synchronization of the API's file total.
    const inventoryReported =
      progress.phase === "discovery" && progress.filesCompleted === 0;
    const duplicate =
      displayed !== null &&
      progressKey(displayed.update) === key &&
      (!inventoryChanged || inventoryReported);
    const displaySource = parentAtEqualCoverage
      ? { ...parent, owner: "parent" as const }
      : selected;
    this.#displayedProgress = {
      update: progress,
      owner: displaySource?.owner ?? "live",
      order: displaySource?.order ?? 0,
      ...(displaySource?.position === undefined
        ? {}
        : {
            position: displaySource.position,
            markerIndex: displaySource.markerIndex,
          }),
    };
    if (duplicate) return;
    this.#options.onProgress?.(progress, {
      reconciled: true,
      ...(inventoryChanged ? { inventory: true } : {}),
    });
  }

  #savedParentProgressIsCurrent(saved: SessionProgress): boolean {
    if (!this.#afterParentFrontier(saved.position, saved.markerIndex))
      return false;
    // An outer tool result has its own completion order. Native output does not
    // identify whether its text was copied from a nested command or emitted
    // directly, so text equality and call-start time cannot establish a copy.
    // Treat it as a receipt; a copied truncated preview can consequently hide
    // omitted same-count phases from its earlier command. This is best effort.
    if (saved.receipt) return true;
    const live = this.#acceptedParent;
    if (live === null) return true;
    // A later saved occurrence may legitimately repeat an earlier live tuple,
    // including progress recovered only from the original multipart response.
    if (live.position !== null) return saved.position > live.position;
    // A positioned inventory can prove a later scope change even when the
    // earlier live command had a different display. Unpositioned live state
    // and review markers do not establish that an inventory copy is newer.
    const current = this.#parentProgress;
    if (
      saved.completion &&
      saved.update.phase === "discovery" &&
      saved.update.filesCompleted === 0 &&
      current?.position !== undefined &&
      current.progress.phase === "discovery" &&
      current.progress.filesCompleted === 0
    )
      return (
        saved.position > current.position ||
        (saved.position === current.position &&
          saved.markerIndex > (current.markerIndex ?? 0))
      );
    return !this.#liveParentProgress.has(progressKey(saved.update));
  }

  public recordUsage(usage: unknown, threadId = this.#threadId): void {
    const normalized = tokenUsage(usage);
    if (threadId !== null) {
      this.#receipts.set(threadId, normalized);
    }
  }

  public start(threadId: string): void {
    if (this.#threadId !== null) return;
    this.#threadId = threadId;
    if (
      this.#options.maxCostUsd === undefined &&
      this.#options.onCost === undefined &&
      this.#options.onUsage === undefined &&
      this.#options.onActivity === undefined &&
      this.#options.onProgress === undefined &&
      this.#options.onSessionEvent === undefined &&
      this.#options.onWorkerEvent === undefined
    ) {
      return;
    }
    let polling = false;
    let rerun = false;
    const poll = () => {
      if (polling) {
        rerun = true;
        return;
      }
      polling = true;
      void this.refresh()
        .catch((error: unknown) => {
          this.#options.onError?.(error);
        })
        .finally(() => {
          polling = false;
          if (rerun && this.#timer !== null) {
            rerun = false;
            poll();
          }
        });
    };
    this.#timer = setInterval(poll, COST_POLL_INTERVAL_MS);
    this.#timer.unref();
    poll();
  }

  public async refresh(): Promise<ScanCostSnapshot> {
    const update = this.#pending.then(async () => {
      await this.#readSessions();
    });
    this.#pending = update.catch(() => {});
    await update;
    return this.#snapshot;
  }

  public async stop(fallbackUsage?: unknown): Promise<ScanCostSnapshot> {
    clearInterval(this.#timer ?? undefined);
    this.#timer = null;
    if (fallbackUsage !== undefined) this.recordUsage(fallbackUsage);
    try {
      await this.refresh();
    } finally {
      this.#observingWorkers = false;
    }
    if (this.#receipts.size > 0 || this.#snapshot.usage !== null)
      return this.#snapshot;
    const cost = estimateScanCost(this.#options.model, fallbackUsage);
    this.#snapshot = { usage: fallbackUsage ?? null, cost };
    this.#reportUsage(tokenUsage(fallbackUsage));
    this.#reportCost(cost);
    return this.#snapshot;
  }

  async #readSessions(): Promise<void> {
    if (this.#threadId === null) return;
    const repository =
      this.#options.onActivity === undefined
        ? undefined
        : this.#options.repository;
    const progressThread =
      this.#options.onProgress === undefined ? undefined : this.#threadId;
    const unreadable: Array<{ session: SessionUsage; error: unknown }> = [];
    for await (const path of sessionFiles(
      join(this.#options.codexHome, "sessions"),
    )) {
      let session = this.#sessions.get(path);
      if (session === undefined) {
        session = createSessionUsage();
        this.#sessions.set(path, session);
      }
      try {
        await readSessionUsage(path, session, repository, progressThread);
      } catch (error) {
        if (session.threadId === null) throw error;
        unreadable.push({ session, error });
      }
    }

    const included = new Set([this.#threadId, ...this.#receipts.keys()]);
    if (this.#options.scanDirectory !== undefined) {
      const scanStartedAt =
        [...this.#sessions.values()].find(
          (session) => session.threadId === this.#threadId,
        )?.startedAt ?? null;
      for (const session of this.#sessions.values()) {
        if (
          session.threadId === null ||
          session.parentThreadId !== null ||
          session.workingDirectory === null ||
          scanStartedAt === null ||
          session.startedAt === null ||
          session.startedAt < scanStartedAt
        ) {
          continue;
        }
        if (
          isScanArtifactDirectory(
            this.#options.scanDirectory,
            session.workingDirectory,
          )
        ) {
          included.add(session.threadId);
        }
      }
    }
    let previousSize: number;
    do {
      previousSize = included.size;
      for (const session of this.#sessions.values()) {
        if (
          session.threadId !== null &&
          session.parentThreadId !== null &&
          included.has(session.parentThreadId)
        ) {
          included.add(session.threadId);
        }
      }
    } while (included.size !== previousSize);
    for (const { session, error } of unreadable) {
      if (included.has(session.threadId!)) throw error;
    }

    const usages = new Map(this.#receipts);
    for (const [path, session] of this.#sessions) {
      const threadId = session.threadId;
      if (threadId === null || !included.has(threadId)) continue;
      if (
        this.#options.onSessionEvent !== undefined &&
        session.events === undefined
      ) {
        // Replay event history through the already-read snapshot without
        // replacing its authoritative progress, usage, or partial-line decoder.
        const replay = createSessionUsage();
        replay.events = [];
        await readSessionUsage(
          path,
          replay,
          undefined,
          undefined,
          session.offset,
        );
        if (replay.offset === session.offset) session.events = replay.events;
      }
      let worker: number | undefined;
      if (threadId !== this.#threadId) {
        worker = this.#workers.get(threadId);
        if (worker === undefined) {
          worker = this.#workers.size + 1;
          this.#workers.set(threadId, worker);
          if (this.#observingWorkers)
            this.#options.onWorkerEvent?.({ kind: "observed", worker });
        }
      }
      for (const event of session.events?.splice(0) ?? []) {
        this.#options.onSessionEvent?.({
          threadId,
          parentThreadId: session.parentThreadId,
          worker,
          event,
        });
      }
      if (worker !== undefined) {
        for (const activity of session.activities.splice(0)) {
          this.#options.onActivity?.({
            ...activity,
            id: `${threadId}:${activity.id}`,
            worker,
          });
        }
      }
      let unresolvedCommand: UnresolvedParentCommand | undefined;
      if (threadId === this.#threadId) {
        this.#parentSession = session;
        // Capture evidence before exact later anchors consume unmatched signatures.
        unresolvedCommand = this.#unresolvedParentCommand(session);
        for (const saved of session.progress)
          if (saved.order !== undefined && !saved.duplicate)
            this.#rememberParentFact({
              progress: saved.update,
              order: saved.order,
              position: saved.position,
              markerIndex: saved.markerIndex,
            });
        this.#matchParentCompletions();
        this.#reconcileParentProgress();
      }
      const reviewWasUnpositioned = this.#parentReviewStart === null;
      this.#reportSessionProgress(
        session,
        threadId === this.#threadId,
        unresolvedCommand,
      );
      // Fresh saved facts are observed at their source-loop position, so initial
      // inventory notifications keep their order. Recover after the batch too:
      // a later accepted parent may have hidden an eligible earlier receipt.
      if (threadId === this.#threadId) {
        // A newly admitted review locates inventories parked earlier in this
        // batch. Reconsider them before the final refresh returns.
        if (reviewWasUnpositioned && this.#parentReviewStart !== null)
          this.#reportSessionProgress(session, true, unresolvedCommand);
        const inventory = this.#inventoryFrontier;
        const parent = this.#parentProgress;
        // Apply this batch's inventories before restoring their proven scope
        // from a later positioned fact. That fact may already be selected while
        // its displayed total still reflects an older unmatched live inventory.
        if (inventory.filesTotal !== undefined && parent !== null) {
          const fact = this.#parentFacts.get(inventory.filesTotal);
          if (
            fact?.position !== undefined &&
            fact.order >= parent.order &&
            (fact.position > inventory.position ||
              (fact.position === inventory.position &&
                (fact.markerIndex ?? 0) > inventory.markerIndex))
          )
            this.setExpectedFilesTotal(inventory.filesTotal);
        }
        this.#reconcileParentProgress();
      }
      const receipt = usages.get(threadId);
      if (
        session.usage !== null &&
        (session.usage.total_tokens > (receipt?.total_tokens ?? -1) ||
          // The SDK inserts zero when the final receipt omits cache writes.
          (session.usage.total_tokens === receipt?.total_tokens &&
            receipt.cache_write_input_tokens === 0))
      ) {
        usages.set(threadId, session.usage);
      }
    }
    let usage: ScanTokenUsage | null = null;
    for (const value of usages.values()) {
      if (value === null) {
        this.#snapshot = { usage: null, cost: null };
        return;
      }
      usage = addTokenUsage(usage, value);
    }
    if (usage === null) return;
    const cost = estimateScanCost(this.#options.model, usage);
    this.#snapshot = { usage, cost };
    this.#reportUsage(usage);
    this.#reportCost(cost);
  }

  #reportSessionProgress(
    session: SessionUsage,
    parent: boolean,
    command?: UnresolvedParentCommand,
  ): void {
    if (this.#options.onProgress === undefined || session.threadId === null) {
      return;
    }
    let corroborated: SessionProgress | undefined;
    let unresolvedCommandState = false;
    let missingCommandProgress = false;
    const live = this.#acceptedParent;
    const current = this.#parentProgress;
    if (
      parent &&
      command?.live === live &&
      live?.position === null &&
      current !== null &&
      current.position === undefined
    ) {
      const completion = command.completion;
      const saved = session.progress.findLast(
        (row) => row.position === completion.position,
      );
      const key = progressKey(current.progress);
      if (
        saved === undefined ||
        (command.truncated && progressKey(saved.update) !== key)
      ) {
        // Truncation may retain older markers but lose the current one. Its
        // digest cannot locate live state, even after a marker-free anchor.
        unresolvedCommandState = true;
        missingCommandProgress = true;
      }
      if (saved !== undefined && progressKey(saved.update) === key) {
        unresolvedCommandState = true;
        if (
          session.progress.every(
            (row) =>
              row.position <= saved.position || progressKey(row.update) === key,
          )
        ) {
          // The latest saved state agrees with live output even when command
          // presentation differs. Admit the fact, without guessing live identity.
          corroborated = saved;
          session.progress.splice(session.progress.indexOf(saved), 1);
          session.progress.unshift(saved);
        }
      }
    }
    if (parent) {
      // Legacy message projections lack native completion metadata, but still
      // locate an already-admitted live review in the saved source. Establish
      // that boundary before discarding duplicate observer notifications.
      for (const saved of session.progress)
        if (
          !saved.receipt &&
          this.#liveParentProgress.has(progressKey(saved.update))
        )
          this.#recordParentReview(
            saved.update,
            saved.position,
            saved.markerIndex,
          );
    }
    for (const saved of session.progress.splice(0)) {
      const progress = saved.update;
      const inventoryMarker =
        parent &&
        progress.phase === "discovery" &&
        progress.filesCompleted === 0;
      const newerInventory =
        saved.position > this.#inventoryFrontier.position ||
        (saved.position === this.#inventoryFrontier.position &&
          saved.markerIndex > this.#inventoryFrontier.markerIndex);
      // A correlated newer inventory may already have repaired scope before
      // these saved markers are processed. Older zeros must not reset it again.
      if (inventoryMarker && !newerInventory) continue;
      const provenInventory =
        inventoryMarker &&
        newerInventory &&
        this.#precedesParentReview(saved.position, saved.markerIndex);
      // Source order suppresses old phase copies, but a previously parked
      // receipt can still recover greater coverage after inventory admission.
      const deferredCoverage =
        saved.order !== undefined &&
        progress.filesCompleted > this.#highestFilesCompleted;
      if (parent && !saved.duplicate && !inventoryMarker)
        this.#rememberParentFact({
          progress,
          order: (saved.order ??= ++this.#progressOrder),
          position: saved.position,
          markerIndex: saved.markerIndex,
        });
      if (
        inventoryMarker &&
        newerInventory &&
        (this.#parentProgress?.progress.filesCompleted ?? 0) > 0 &&
        this.#parentReviewStart === null
      ) {
        // Legacy logs can expose the same EOF/close race through a tool receipt
        // before the admitted review's persisted message becomes observable.
        session.progress.push(saved);
        continue;
      }
      if (
        ((unresolvedCommandState && corroborated === undefined) ||
          saved.unresolvedProjection) &&
        saved !== corroborated &&
        this.#afterParentFrontier(saved.position, saved.markerIndex) &&
        !provenInventory &&
        progress.filesCompleted <= this.#highestFilesCompleted
      ) {
        // Keep lossy-output ambiguity across marker-free anchors; a current
        // state or greater coverage must supply the missing progress evidence.
        if (missingCommandProgress) saved.unresolvedProjection = true;
        session.progress.push(saved);
        continue;
      }
      if (
        parent &&
        saved !== corroborated &&
        !provenInventory &&
        !deferredCoverage &&
        !this.#savedParentProgressIsCurrent(saved)
      )
        continue;
      if (saved.duplicate) {
        if (
          parent &&
          saved.completion &&
          this.#afterParentFrontier(saved.position, saved.markerIndex)
        )
          this.#parentFrontier = {
            position: saved.position,
            markerIndex: saved.markerIndex,
          };
        continue;
      }
      const expectedFilesTotal = this.#expectedFilesTotal;
      const parentInventory =
        inventoryMarker &&
        ((this.#parentProgress?.progress.filesCompleted ?? 0) === 0 ||
          provenInventory);
      const order = (saved.order ??= ++this.#progressOrder);
      if (
        (!parent &&
          session.filesTotal !== null &&
          progress.filesTotal !== session.filesTotal) ||
        (!parentInventory && progress.filesCompleted < session.filesCompleted)
      )
        continue;
      if (
        !parentInventory &&
        expectedFilesTotal !== undefined &&
        progress.filesTotal > expectedFilesTotal
      ) {
        if (parent) {
          // The full inventory may still be waiting in the live stream. Retain
          // parsed receipts so its admission can recover saved parent coverage.
          session.progress.push(saved);
        } else {
          const pending = session.pendingWorkerProgress.get(
            progress.filesTotal,
          );
          if (
            pending === undefined ||
            progress.filesCompleted >= pending.progress.filesCompleted
          )
            session.pendingWorkerProgress.set(progress.filesTotal, {
              progress,
              order,
            });
        }
        continue;
      }
      session.filesTotal = progress.filesTotal;
      session.filesCompleted = progress.filesCompleted;
      if (!parent) session.latestWorkerProgress = { progress, order };
      if (parentInventory && this.#highestFilesCompleted > 0) {
        // An inventory behind admitted review changes scope without replaying
        // its earlier phase. At zero coverage it follows normal source-ordered
        // phase admission below, including when the inventory total changes.
        let inventory = progress;
        if ((this.#parentProgress?.progress.filesCompleted ?? 0) === 0) {
          const candidate = {
            progress,
            order,
            position: saved.position,
            markerIndex: saved.markerIndex,
          };
          if (
            this.#parentProgress === null ||
            saved === corroborated ||
            this.#parentProgress.progress.phase !== "discovery" ||
            compareProgressOrder(candidate, this.#parentProgress) >= 0
          )
            this.#parentProgress = candidate;
          inventory = this.#parentProgress.progress;
        }
        const position = {
          position: saved.position,
          markerIndex: saved.markerIndex,
        };
        if (this.#afterParentFrontier(saved.position, saved.markerIndex))
          this.#parentFrontier = position;
        this.#inventoryFrontier = {
          ...position,
          filesTotal: progress.filesTotal,
        };
        this.setExpectedFilesTotal(inventory.filesTotal);
        continue;
      }
      // Parent markers already describe global coverage, including its workers.
      // Only worker-local counts belong in the delegated shard sum.
      if (!parent)
        this.#workerProgress.set(session.threadId, progress.filesCompleted);
      const filesCompleted = parent
        ? progress.filesCompleted
        : Math.min(
            expectedFilesTotal ?? Number.MAX_SAFE_INTEGER,
            this.#workerProgress
              .values()
              .reduce((total, reviewed) => total + reviewed, 0),
          );
      if (filesCompleted < this.#highestFilesCompleted) {
        // A provisional worker can exceed this global parent receipt, then
        // become ineligible when the parent's earlier inventory is recovered.
        // Keep the parsed parent fact for that correction, without displaying
        // a count decrease while the worker coverage remains eligible.
        if (parent) session.progress.push(saved);
        continue;
      }
      // A worker-local phase cannot replace eligible global parent authority
      // when the aggregate count adds no reviewed files. Counts remain above.
      if (
        !parent &&
        this.#parentProgress !== null &&
        filesCompleted === this.#parentProgress.progress.filesCompleted &&
        this.#parentProgress.progress.filesTotal <=
          (expectedFilesTotal ?? this.#parentProgress.progress.filesTotal)
      )
        continue;
      if (parent)
        this.#recordParentReview(progress, saved.position, saved.markerIndex);
      // Known parent positions outrank observation order: polling can park a
      // newer completion before an earlier live completion is displayed.
      const displayed = this.#displayedProgress;
      const provenance = {
        order,
        position: saved.position,
        markerIndex: saved.markerIndex,
      };
      const newerProgress =
        parent &&
        displayed !== null &&
        displayed.owner !== "worker" &&
        filesCompleted === displayed.update.filesCompleted &&
        compareProgressOrder(provenance, displayed) < 0
          ? displayed
          : null;
      const update = newerProgress?.update ?? {
        ...progress,
        filesCompleted,
        filesTotal: parent
          ? progress.filesTotal
          : (expectedFilesTotal ??
            Math.max(progress.filesTotal, filesCompleted)),
      };
      // Retaining a newer parent phase retains that whole receipt, including
      // its actual inventory. Mixing an older total with its phase would discard
      // valid parent coverage when a later inventory correction arrives.
      if (parent && newerProgress === null)
        this.#parentProgress = { progress, ...provenance };
      const key = progressKey(update);
      if (parent) {
        // An original multipart response can expose progress absent from its
        // concatenated native projection. Its admitted source position still
        // prevents an older live completion from replaying over that progress.
        if (this.#afterParentFrontier(saved.position, saved.markerIndex))
          this.#parentFrontier = {
            position: saved.position,
            markerIndex: saved.markerIndex,
          };
        if (parentInventory)
          this.#inventoryFrontier = {
            position: saved.position,
            markerIndex: saved.markerIndex,
            filesTotal: progress.filesTotal,
          };
      }
      this.#highestFilesCompleted = update.filesCompleted;
      this.#displayedProgress =
        newerProgress !== null
          ? { ...newerProgress, update }
          : {
              update,
              owner: parent ? "parent" : "worker",
              order,
              ...(parent
                ? { position: saved.position, markerIndex: saved.markerIndex }
                : {}),
            };
      // Distinct equal-valued receipts still advance source ownership/order.
      if (displayed !== null && progressKey(displayed.update) === key) continue;
      this.#options.onProgress(update);
    }
  }

  #reportCost(cost: ScanCost | null): void {
    if (cost === null) return;
    const signature = JSON.stringify(cost);
    if (signature === this.#lastCost) return;
    this.#lastCost = signature;
    this.#options.onCost?.(cost);
  }

  #reportUsage(usage: ScanTokenUsage | null): void {
    if (usage === null) return;
    const signature = JSON.stringify(usage);
    if (signature === this.#lastUsage) return;
    this.#lastUsage = signature;
    this.#options.onUsage?.(usage);
  }
}

export async function* sessionFiles(
  directory: string,
  compressed = false,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* sessionFiles(path, compressed);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".jsonl") ||
        (compressed && entry.name.endsWith(".jsonl.zst")))
    ) {
      yield path;
    }
  }
}

async function readSessionUsage(
  path: string,
  session: SessionUsage,
  repository?: string,
  progressThread?: string,
  throughOffset?: number,
): Promise<void> {
  if (session.unreadable) return;
  let file;
  try {
    if ((await stat(path)).size === session.offset) return;
    file = await open(path, "r");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(SESSION_READ_SIZE);
    while (throughOffset === undefined || session.offset < throughOffset) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        throughOffset === undefined
          ? buffer.length
          : Math.min(buffer.length, throughOffset - session.offset),
        session.offset,
      );
      if (bytesRead === 0) return;
      session.offset += bytesRead;
      try {
        const lines = session.decoder
          .write(buffer.subarray(0, bytesRead))
          .split("\n");
        session.pendingLine.push(lines[0]!);
        for (const line of lines.slice(1)) {
          readSessionEvent(
            session.pendingLine.join(""),
            session,
            repository,
            progressThread,
          );
          session.pendingLine = [line];
        }
      } catch (error) {
        session.unreadable = true;
        session.pendingLine = [];
        throw error;
      }
    }
  } finally {
    await file.close();
  }
}

function readSessionEvent(
  line: string,
  session: SessionUsage,
  repository?: string,
  progressThread?: string,
): void {
  if (line.length === 0) return;
  const event = parseJson(() => line);
  if (!isRecord(event) || !isRecord(event["payload"])) return;
  const payload = event["payload"];
  if (event["type"] === "session_meta") {
    if (session.threadId !== null) {
      session.replaying = payload["id"] !== session.threadId;
      if (!session.replaying) session.events?.push(event);
      return;
    }
    if (typeof payload["id"] === "string") {
      session.threadId = payload["id"];
    }
    if (typeof payload["cwd"] === "string") {
      session.workingDirectory = payload["cwd"];
    }
    session.startedAt = sessionStartedAt(payload["timestamp"]);
    session.parentThreadId = sessionParentThreadId(payload);
    session.events?.push(event);
    return;
  }
  if (session.replaying) {
    if (event["type"] !== "event_msg") return;
    if (payload["type"] === "token_count" && isRecord(payload["info"])) {
      const usage = tokenUsage(payload["info"]["total_token_usage"]);
      if (usage !== null) session.inheritedUsage = usage;
    }
    if (
      payload["type"] === "task_started" &&
      sessionOwnsTurn(session, payload)
    ) {
      session.replaying = false;
      session.events?.push(event);
    }
    return;
  }
  session.events?.push(event);
  const position = ++session.position;
  if (event["type"] === "response_item") {
    const receipt =
      payload["type"] === "function_call_output" ||
      payload["type"] === "custom_tool_call_output";
    const message =
      payload["type"] === "message" &&
      payload["role"] === "assistant" &&
      Array.isArray(payload["content"])
        ? payload["content"]
            .filter(isRecord)
            .map((part) =>
              typeof part["text"] === "string" ? part["text"] : "",
            )
            .join("")
        : null;
    const updates = sessionProgressUpdates(payload);
    const duplicateMessage =
      message !== null &&
      repeatedMessageProjection(session, digest(message), "response", updates);
    // Code-mode notifications and the final output can share a call ID.
    // Each appended output record remains a distinct completion receipt.
    for (const [markerIndex, update] of (duplicateMessage
      ? []
      : updates
    ).entries()) {
      session.progress.push({
        update,
        position,
        completion: false,
        markerIndex,
        receipt,
        duplicate: false,
      });
    }
    if (repository === undefined) return;
    if (
      payload["type"] === "reasoning" &&
      typeof payload["id"] === "string" &&
      Array.isArray(payload["summary"]) &&
      payload["summary"].length > 1 &&
      session.reasoning?.raw !== true
    ) {
      for (const [index, summary] of payload["summary"].entries()) {
        const activity = scanActivityFromSessionEvent(
          {
            ...event,
            payload: {
              ...payload,
              id: `${payload["id"]}:${index}`,
              summary: [summary],
            },
          },
          repository,
        );
        if (
          activity === null ||
          session.prose.has(`${activity.kind}:${activity.description}`)
        ) {
          continue;
        }
        session.reasoning = {
          id: activity.id,
          text: activity.description,
          raw: false,
          activity: null,
        };
        recordReasoningActivity(session, activity);
      }
      return;
    }
    const activity = scanActivityFromSessionEvent(event, repository);
    if (activity !== null) {
      if (activity.kind === "reasoning") {
        const reasoning = (session.reasoning ??= {
          id: activity.id,
          text: activity.description,
          raw: false,
          activity: null,
        });
        recordReasoningActivity(session, {
          ...activity,
          id: reasoning.id,
          description:
            reasoning.raw && reasoning.activity !== null
              ? reasoning.activity.description
              : activity.description,
        });
        return;
      }
      session.reasoning = null;
      if (
        activity.kind === "message" &&
        session.prose.has(`${activity.kind}:${activity.description}`)
      ) {
        return;
      }
      if (activity.kind === "message") {
        session.prose.add(`${activity.kind}:${activity.description}`);
      }
      if (activity.status === "running") {
        session.calls.set(activity.id, activity);
      }
      session.activities.push(activity);
      return;
    }
    if (
      (payload["type"] === "function_call_output" ||
        payload["type"] === "custom_tool_call_output") &&
      typeof payload["call_id"] === "string"
    ) {
      const call = session.calls.get(payload["call_id"]);
      if (call !== undefined) {
        session.activities.push({
          ...call,
          status: payload["status"] === "failed" ? "failed" : "completed",
        });
        session.calls.delete(call.id);
      }
    }
    return;
  }
  if (
    session.threadId === progressThread &&
    event["type"] === "event_msg" &&
    payload["type"] === "item_completed"
  ) {
    const item = nativeProgressItem(payload["item"]);
    const value = payload["item"];
    const duplicateCompletion =
      item?.kind === "message" &&
      repeatedMessageProjection(session, item.outputDigest, "native");
    if (
      isRecord(value) &&
      (value["type"] === "CommandExecution" ||
        value["type"] === "AgentMessage") &&
      !duplicateCompletion
    ) {
      const signature =
        item === null
          ? null
          : {
              kind: item.kind,
              outputDigest: item.outputDigest,
              persistedOutputDigest: item.persistedOutputDigest,
              ...(item.commandDigest === undefined
                ? {}
                : { commandDigest: item.commandDigest }),
            };
      session.completions.push({ position, item: signature });
    }
    if (item !== null) {
      const duplicate =
        item.kind === "message" &&
        repeatedMessageProjection(
          session,
          item.outputDigest,
          "native",
          item.updates,
        );
      for (const [markerIndex, update] of item.updates.entries()) {
        session.progress.push({
          update,
          position,
          completion: true,
          markerIndex,
          receipt: false,
          duplicate,
        });
      }
    }
  }
  if (
    event["type"] === "event_msg" &&
    (payload["type"] === "agent_reasoning" ||
      payload["type"] === "agent_reasoning_delta" ||
      payload["type"] === "agent_reasoning_raw_content" ||
      payload["type"] === "agent_reasoning_raw_content_delta" ||
      payload["type"] === "agent_message")
  ) {
    if (
      payload["type"] === "agent_message" &&
      typeof payload["message"] === "string"
    ) {
      const updates = scanProgressUpdatesFromText(payload["message"]);
      const duplicate = repeatedMessageProjection(
        session,
        digest(payload["message"]),
        "event",
        updates,
      );
      // Legacy rollouts persist the finalized message instead of the native
      // item. It provides the same compact output signature for live matching.
      if (
        session.threadId === progressThread &&
        !repeatedMessageProjection(session, digest(payload["message"]), "event")
      )
        session.completions.push({
          position,
          item: progressSignature("message", payload["message"]),
        });
      for (const [markerIndex, update] of (duplicate
        ? []
        : updates
      ).entries()) {
        session.progress.push({
          update,
          position,
          completion: false,
          markerIndex,
          receipt: false,
          duplicate: false,
        });
      }
    }
    if (repository === undefined) return;
    if (payload["type"] !== "agent_message") {
      readSessionReasoning(event, payload, session, repository);
      return;
    }
    session.reasoning = null;
    const activity = scanActivityFromSessionEvent(event, repository);
    if (
      activity !== null &&
      !session.prose.has(`${activity.kind}:${activity.description}`)
    ) {
      session.prose.add(`${activity.kind}:${activity.description}`);
      session.activities.push(activity);
    }
    return;
  }
  if (
    event["type"] !== "event_msg" ||
    payload["type"] !== "token_count" ||
    !isRecord(payload["info"])
  ) {
    return;
  }
  const usage = tokenUsage(payload["info"]["total_token_usage"]);
  if (usage === null) return;
  const ownUsage =
    session.inheritedUsage === null
      ? usage
      : subtractTokenUsage(usage, session.inheritedUsage);
  if (ownUsage !== null) session.usage = ownUsage;
}

function readSessionReasoning(
  event: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
  session: SessionUsage,
  repository: string,
): void {
  const type = payload["type"];
  const raw =
    type === "agent_reasoning_raw_content" ||
    type === "agent_reasoning_raw_content_delta";
  const delta =
    type === "agent_reasoning_delta" ||
    type === "agent_reasoning_raw_content_delta";
  const text = payload[delta ? "delta" : "text"];
  if (typeof text !== "string") return;

  if (
    !delta &&
    !raw &&
    session.reasoning?.raw !== true &&
    session.reasoning?.activity?.status === "completed" &&
    session.reasoning.text !== text
  ) {
    session.reasoning = null;
  }
  const reasoning = (session.reasoning ??= {
    id: `reasoning-${++session.reasoningCount}`,
    text: "",
    raw: false,
    activity: null,
  });
  if (reasoning.raw && !raw) return;
  if (raw && !reasoning.raw) {
    reasoning.text = "";
    reasoning.raw = true;
  }
  reasoning.text = delta ? `${reasoning.text}${text}` : text;

  const activity = scanActivityFromSessionEvent(
    {
      ...event,
      payload: {
        ...payload,
        [delta ? "delta" : "text"]: reasoning.text,
      },
    },
    repository,
  );
  if (activity === null) return;
  recordReasoningActivity(session, { ...activity, id: reasoning.id });
}

function recordReasoningActivity(
  session: SessionUsage,
  activity: ScanActivity,
): void {
  const reasoning = session.reasoning!;
  if (
    reasoning.activity?.description === activity.description &&
    reasoning.activity.status === activity.status
  ) {
    return;
  }
  reasoning.activity = activity;
  session.prose.add(`${activity.kind}:${activity.description}`);
  session.activities.push(activity);
}

const PERSISTED_OUTPUT_GAP =
  "\n... command output truncated for persistence ...\n";

// Native Codex 0.162.1 persists command output with a 64 KiB UTF-8 budget.
// This signature mirrors that representation; emitted diagnostics stay intact.
const PERSISTED_COMMAND_OUTPUT_BYTES = 64 * 1024;
const PERSISTED_OUTPUT_GAP_BYTES = Buffer.byteLength(PERSISTED_OUTPUT_GAP);
const PERSISTED_COMMAND_PREFIX_BYTES = Math.floor(
  (PERSISTED_COMMAND_OUTPUT_BYTES - PERSISTED_OUTPUT_GAP_BYTES) / 2,
);
const PERSISTED_COMMAND_SUFFIX_BYTES =
  PERSISTED_COMMAND_OUTPUT_BYTES -
  PERSISTED_OUTPUT_GAP_BYTES -
  PERSISTED_COMMAND_PREFIX_BYTES;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function persistedOutputDigest(text: string, fullDigest: string): string {
  if (Buffer.byteLength(text) <= PERSISTED_COMMAND_OUTPUT_BYTES)
    return fullDigest;
  const bytes = Buffer.from(text);
  let prefixEnd = PERSISTED_COMMAND_PREFIX_BYTES;
  let suffixStart = bytes.length - PERSISTED_COMMAND_SUFFIX_BYTES;
  while ((bytes[prefixEnd]! & 0xc0) === 0x80) prefixEnd--;
  while ((bytes[suffixStart]! & 0xc0) === 0x80) suffixStart++;
  return createHash("sha256")
    .update(bytes.subarray(0, prefixEnd))
    .update(PERSISTED_OUTPUT_GAP)
    .update(bytes.subarray(suffixStart))
    .digest("hex");
}

function progressSignature(
  kind: ProgressItem["kind"],
  text: string,
  command?: readonly string[],
): ProgressItem {
  const outputDigest = digest(text);
  return {
    kind,
    outputDigest,
    persistedOutputDigest:
      kind === "command"
        ? persistedOutputDigest(text, outputDigest)
        : outputDigest,
    ...(command === undefined
      ? {}
      : { commandDigest: digest(JSON.stringify(command)) }),
  };
}

function repeatedMessageProjection(
  session: SessionUsage,
  textDigest: string,
  projection: "native" | "event" | "response",
  updates?: readonly ScanProgress[],
): boolean {
  if (updates?.length === 0) return false;
  // Completion matching counts every native/legacy message, even without
  // progress. Keep those occurrences separate from parsed progress copies:
  // multipart responses can recover updates absent from their native copy.
  const key =
    updates === undefined
      ? textDigest
      : `${textDigest}:${digest(JSON.stringify(updates))}`;
  let counts = session.messageProjections.get(key);
  if (counts === undefined) {
    counts = { native: 0, event: 0, response: 0 };
    session.messageProjections.set(key, counts);
  }
  const previous = Math.max(counts.native, counts.event, counts.response);
  counts[projection]++;
  return counts[projection] <= previous;
}

function progressKey(progress: ScanProgress): string {
  return `${progress.phase}:${progress.filesCompleted}:${progress.filesTotal}`;
}

function streamedProgressItem(
  event: Readonly<Record<string, unknown>>,
): ProgressItem | null {
  const item = event["item"];
  if (!isRecord(item)) return null;
  if (item["type"] === "agent_message" && typeof item["text"] === "string")
    return progressSignature("message", item["text"]);
  if (
    item["type"] !== "command_execution" ||
    typeof item["aggregated_output"] !== "string" ||
    typeof item["command"] !== "string"
  )
    return null;
  const command = splitCommand(item["command"]);
  return command === null
    ? null
    : progressSignature("command", item["aggregated_output"], command);
}

function nativeProgressItem(value: unknown): NativeProgressItem | null {
  if (!isRecord(value)) return null;
  let kind: ProgressItem["kind"];
  let text: string;
  let command: string[] | undefined;
  if (value["type"] === "AgentMessage" && Array.isArray(value["content"])) {
    kind = "message";
    text = value["content"]
      .filter(
        (part): part is { text: string } =>
          isRecord(part) &&
          part["type"] === "Text" &&
          typeof part["text"] === "string",
      )
      .map((part) => part.text)
      .join("");
  } else if (
    value["type"] === "CommandExecution" &&
    typeof value["aggregated_output"] === "string" &&
    Array.isArray(value["command"]) &&
    value["command"].every((arg): arg is string => typeof arg === "string")
  ) {
    kind = "command";
    text = value["aggregated_output"];
    command = value["command"];
  } else return null;
  let progressText = text;
  if (kind === "command") {
    const bytes = Buffer.from(text);
    // Native UTF-8 boundary adjustment can shorten each fragment by up to
    // three bytes. An earlier literal sentinel is ordinary command output.
    const gap = bytes.indexOf(
      PERSISTED_OUTPUT_GAP,
      PERSISTED_COMMAND_PREFIX_BYTES - 3,
    );
    const suffixBytes = bytes.length - gap - PERSISTED_OUTPUT_GAP_BYTES;
    if (
      gap !== -1 &&
      gap <= PERSISTED_COMMAND_PREFIX_BYTES &&
      suffixBytes >= PERSISTED_COMMAND_SUFFIX_BYTES - 3 &&
      suffixBytes <= PERSISTED_COMMAND_SUFFIX_BYTES
    ) {
      // Complete original prefix lines have known fence state. The gap inserts
      // its own newline, so the partial prefix line and tail remain unproven.
      // Literal text at these exact boundaries is indistinguishable on disk.
      const prefix = bytes.subarray(0, gap).toString("utf8");
      progressText = prefix.slice(0, prefix.lastIndexOf("\n") + 1);
    }
  }
  return {
    ...progressSignature(kind, text, command),
    updates: scanProgressUpdatesFromText(progressText),
  };
}

function progressItemKey(item: ProgressItem, persisted = false): string {
  return `${item.kind}:${item.commandDigest ?? ""}:${persisted ? item.persistedOutputDigest : item.outputDigest}`;
}

function progressItemKeys(item: ProgressItem): string[] {
  const keys = [progressItemKey(item)];
  if (item.outputDigest !== item.persistedOutputDigest)
    keys.push(progressItemKey(item, true));
  return keys;
}

// Min-heap keeps compatible live occurrences ordered without rescanning the
// unmatched prefix or sorting every completion batch.
function insertIndex(heap: number[], index: number): void {
  let child = heap.length;
  heap.push(index);
  while (child > 0) {
    const parent = (child - 1) >>> 1;
    if (heap[parent]! <= index) break;
    heap[child] = heap[parent]!;
    child = parent;
  }
  heap[child] = index;
}

function takeFirstIndex(heap: number[]): number {
  const first = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  let parent = 0;
  while (parent * 2 + 1 < heap.length) {
    let child = parent * 2 + 1;
    if (child + 1 < heap.length && heap[child + 1]! < heap[child]!) child++;
    if (last <= heap[child]!) break;
    heap[parent] = heap[child]!;
    parent = child;
  }
  heap[parent] = last;
  return first;
}

/** Decode the quoted argv rendering emitted by native command completions. */
function splitCommand(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === "\\" && quote !== "'") {
      const next = command[++index];
      if (next === undefined) return null;
      if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(next))
        word += "\\";
      if (next !== "\n") word += next;
      started = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (" \t\r\n".includes(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote !== null) return null;
  if (started) words.push(word);
  return words;
}

function sessionProgressUpdates(
  payload: Readonly<Record<string, unknown>>,
): ScanProgress[] {
  if (payload["type"] === "message" && payload["role"] === "assistant") {
    const content = payload["content"];
    if (!Array.isArray(content)) return [];
    return scanProgressUpdatesFromText(sessionContentText(content, false));
  }
  if (
    payload["type"] !== "function_call_output" &&
    payload["type"] !== "custom_tool_call_output" &&
    payload["type"] !== "local_shell_call_output"
  ) {
    return [];
  }
  const value = payload["output"];
  const output =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? sessionContentText(value, true)
        : null;
  if (payload["status"] === "failed" || output === null) {
    return [];
  }
  return scanProgressUpdatesFromText(output);
}

function sessionContentText(
  content: readonly unknown[],
  includeInputText: boolean,
): string {
  return content
    .filter(
      (item): item is Record<string, unknown> & { text: string } =>
        isRecord(item) &&
        (item["type"] === "output_text" ||
          (includeInputText && item["type"] === "input_text")) &&
        typeof item["text"] === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function addTokenUsage(
  previous: ScanTokenUsage | null,
  next: ScanTokenUsage,
): ScanTokenUsage {
  if (previous === null) return next;
  return {
    input_tokens: previous.input_tokens + next.input_tokens,
    cached_input_tokens:
      previous.cached_input_tokens + next.cached_input_tokens,
    cache_write_input_tokens:
      previous.cache_write_input_tokens + next.cache_write_input_tokens,
    ...(previous.cache_write_input_tokens_reported === false ||
    next.cache_write_input_tokens_reported === false
      ? { cache_write_input_tokens_reported: false }
      : {}),
    output_tokens: previous.output_tokens + next.output_tokens,
    reasoning_output_tokens:
      previous.reasoning_output_tokens + next.reasoning_output_tokens,
    total_tokens: previous.total_tokens + next.total_tokens,
  };
}

function subtractTokenUsage(
  usage: ScanTokenUsage,
  inherited: ScanTokenUsage,
): ScanTokenUsage | null {
  return tokenUsage({
    input_tokens: usage.input_tokens - inherited.input_tokens,
    cached_input_tokens:
      usage.cached_input_tokens - inherited.cached_input_tokens,
    cache_write_input_tokens:
      usage.cache_write_input_tokens - inherited.cache_write_input_tokens,
    ...(usage.cache_write_input_tokens_reported === false ||
    inherited.cache_write_input_tokens_reported === false
      ? { cache_write_input_tokens_reported: false }
      : {}),
    output_tokens: usage.output_tokens - inherited.output_tokens,
    reasoning_output_tokens:
      usage.reasoning_output_tokens - inherited.reasoning_output_tokens,
  });
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}
