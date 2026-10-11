import { parseJson } from "./value.js";
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
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
  position: number;
  completion: boolean;
  markerIndex: number;
  receipt: boolean;
  duplicate: boolean;
}

interface ProgressItem {
  kind: "message" | "command";
  outputDigest: string;
  persistedOutputDigest: string;
  commandDigest?: string;
}

interface NativeProgressItem extends ProgressItem {
  updates: ScanProgress[];
}

interface SessionCompletion {
  position: number;
  item: ProgressItem | null;
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

interface StreamedProgressItem {
  markers: ParentProgressMarker[];
  accepted: ScanProgress | null;
  observedMarkerIndex: number;
  acceptedMarkerIndex: number;
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
  workerProgress: Set<string>;
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
    workerProgress: new Set(),
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
  #lastProgress: string | null = null;
  readonly #liveParentProgress = new Set<string>();
  readonly #liveParentItems: StreamedProgressItem[] = [];
  #liveParentEvents = new WeakMap<
    Readonly<Record<string, unknown>>,
    StreamedProgressItem
  >();
  #acceptedParent: StreamedProgressItem | null = null;
  // Global coverage admitted from either the live or saved parent projection.
  #parentProgress: ScanProgress | null = null;
  #acceptedInventory: ParentProgressMarker | null = null;
  readonly #readyParentMarkers: Array<{
    live: StreamedProgressItem;
    marker: ParentProgressMarker;
  }> = [];
  #inventoryFrontier = { position: 0, markerIndex: -1 };
  #progressOrder = 0;
  #displayedProgress: {
    update: ScanProgress;
    owner: "live" | "parent" | "worker";
    order: number;
    position?: number;
  } | null = null;
  #matchedParentItems = 0;
  #parentCompletionStart = 0;
  #parentSession: SessionUsage | null = null;
  #parentTurnStart: number | null = 0;
  #parentFrontier = { position: 0, markerIndex: -1 };
  #threadId: string | null = null;
  #observingWorkers = true;
  #timer: NodeJS.Timeout | null = null;
  #pending: Promise<void> = Promise.resolve();
  #snapshot: ScanCostSnapshot = { usage: null, cost: null };
  #lastCost: string | null = null;
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
    this.#parentTurnStart =
      this.#parentSession?.position ?? (resumed ? null : 0);
    this.#liveParentItems.length = 0;
    this.#liveParentEvents = new WeakMap();
    this.#acceptedParent = null;
    this.#acceptedInventory = null;
    // Historical logs may omit projection kinds emitted by the new turn.
    this.#parentSession?.messageProjections.clear();
    this.#readyParentMarkers.length = 0;
    this.#matchedParentItems = 0;
    this.#parentCompletionStart = this.#parentSession?.completions.length ?? 0;
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
      accepted: null,
      observedMarkerIndex: -1,
      acceptedMarkerIndex: -1,
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
    live.observedMarkerIndex++;
    const marker = {
      progress,
      index: live.observedMarkerIndex,
      order: ++this.#progressOrder,
      accepted: false,
    };
    live.markers.push(marker);
    if (live.position !== null) this.#readyParentMarkers.push({ live, marker });
    return (
      live.position === null ||
      this.#afterParentFrontier(live.position, live.observedMarkerIndex)
    );
  }

  /** Source acceptance is independent of duplicate observer notifications. */
  public acceptParentProgress(
    progress: ScanProgress,
    event: Readonly<Record<string, unknown>>,
  ): void {
    const live = this.#liveParentEvents.get(event);
    if (live === undefined) return;
    const marker = live.markers[live.observedMarkerIndex];
    if (marker === undefined) return;
    marker.accepted = true;
    if (progress.phase === "discovery" && progress.filesCompleted === 0)
      this.#acceptedInventory = marker;
    this.#acceptedParent = live;
    this.#parentProgress = progress;
    live.accepted = progress;
    live.acceptedMarkerIndex = live.observedMarkerIndex;
    const update = {
      ...progress,
      filesTotal: this.#expectedFilesTotal ?? progress.filesTotal,
    };
    this.#lastProgress = progressKey(update);
    this.#displayedProgress = { update, owner: "live", order: marker.order };
    this.#highestFilesCompleted = Math.max(
      this.#highestFilesCompleted,
      progress.filesCompleted,
    );
    this.#liveParentProgress.add(progressKey(progress));
    if (live.position !== null)
      this.#parentFrontier = {
        position: live.position,
        markerIndex: live.acceptedMarkerIndex,
      };
  }

  #afterParentFrontier(position: number, index: number): boolean {
    return (
      position > this.#parentFrontier.position ||
      (position === this.#parentFrontier.position &&
        index > this.#parentFrontier.markerIndex)
    );
  }

  #matchParentCompletions(): void {
    if (this.#parentSession === null || this.#parentTurnStart === null) return;
    const completions = this.#parentSession.completions;
    // Both projections preserve supported completion occurrences. Check each
    // pair once; missing or unfamiliar metadata remains nonblocking.
    while (this.#matchedParentItems < this.#liveParentItems.length) {
      const saved =
        completions[this.#parentCompletionStart + this.#matchedParentItems];
      if (saved === undefined) break;
      const live = this.#liveParentItems[this.#matchedParentItems++]!;
      if (
        live.item !== null &&
        saved.item !== null &&
        matchingProgressItem(live.item, saved.item)
      ) {
        live.position = saved.position;
        for (const marker of live.markers)
          this.#readyParentMarkers.push({ live, marker });
      }
      live.item = null;
      saved.item = null;
    }
  }

  #reconcileParentProgress(): void {
    const ready = this.#readyParentMarkers.splice(0);
    let corrected: { progress: ScanProgress; order: number } | null = null;
    for (const { live, marker } of ready) {
      const position = live.position;
      if (position === null) continue;
      const progress = marker.progress;
      if (
        marker === this.#acceptedInventory &&
        marker.accepted &&
        progress.phase === "discovery" &&
        progress.filesCompleted === 0 &&
        (position > this.#inventoryFrontier.position ||
          (position === this.#inventoryFrontier.position &&
            marker.index > this.#inventoryFrontier.markerIndex))
      ) {
        this.#inventoryFrontier = { position, markerIndex: marker.index };
        this.setExpectedFilesTotal(progress.filesTotal);
      }
    }
    const inventoryChanged = this.#inventoryNeedsReconciliation;
    this.#inventoryNeedsReconciliation = false;
    if (inventoryChanged) {
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
          session.workerProgress.add(progressKey(progress));
          session.pendingWorkerProgress.delete(total);
          if (corrected === null || pending.order > corrected.order)
            corrected = pending;
        }
        if (
          session.filesTotal !== null &&
          session.filesTotal <= this.#expectedFilesTotal!
        )
          this.#workerProgress.set(session.threadId, session.filesCompleted);
        else this.#workerProgress.delete(session.threadId);
      }
      const parent = this.#parentProgress;
      const parentCount =
        parent !== null && parent.filesTotal <= this.#expectedFilesTotal!
          ? parent.filesCompleted
          : 0;
      this.#highestFilesCompleted = Math.max(
        parentCount,
        Math.min(
          this.#expectedFilesTotal!,
          this.#workerProgress.values().reduce((sum, count) => sum + count, 0),
        ),
      );
      if (this.#parentSession !== null) {
        this.#parentSession.filesCompleted = parentCount;
        this.#parentSession.filesTotal = this.#expectedFilesTotal!;
      }
    }
    for (const { live, marker } of ready) {
      const position = live.position;
      if (
        position === null ||
        !this.#afterParentFrontier(position, marker.index)
      )
        continue;
      const progress = marker.progress;
      if (!marker.accepted) {
        if (
          this.#expectedFilesTotal !== undefined &&
          progress.filesTotal > this.#expectedFilesTotal
        ) {
          // Saved inventory in this poll may admit the live receipt. Keep only
          // its parsed progress available until that inventory is processed.
          this.#readyParentMarkers.push({ live, marker });
          continue;
        }
        if (progress.filesCompleted < this.#highestFilesCompleted) continue;
        marker.accepted = true;
        live.accepted = progress;
        live.acceptedMarkerIndex = marker.index;
        this.#acceptedParent = live;
        this.#parentProgress = progress;
        this.#liveParentProgress.add(progressKey(progress));
        this.#highestFilesCompleted = progress.filesCompleted;
        if (corrected === null || marker.order > corrected.order)
          corrected = { progress, order: marker.order };
      } else if (
        this.#displayedProgress?.owner === "parent" &&
        position > (this.#displayedProgress.position ?? 0) &&
        (corrected === null || marker.order > corrected.order)
      ) {
        corrected = { progress, order: marker.order };
      }
      this.#parentFrontier = { position, markerIndex: marker.index };
    }
    const displayed = this.#displayedProgress;
    if (!inventoryChanged && corrected === null) return;
    const replacePhase =
      corrected !== null &&
      (displayed === null ||
        displayed.owner === "parent" ||
        corrected.order >= displayed.order);
    const phase = replacePhase
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
    if (this.#lastProgress === key) return;
    this.#lastProgress = key;
    this.#displayedProgress = {
      update: progress,
      owner: replacePhase ? "live" : (displayed?.owner ?? "live"),
      order: replacePhase ? corrected!.order : (displayed?.order ?? 0),
    };
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
    if (live.position !== null && saved.position <= live.position) return false;
    if (!this.#liveParentProgress.has(progressKey(saved.update))) return true;
    return live.position !== null && saved.completion;
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
    for (const [path, tracked] of this.#sessions) {
      const threadId = tracked.threadId;
      if (threadId === null || !included.has(threadId)) continue;
      let session = tracked;
      if (
        this.#options.onSessionEvent !== undefined &&
        session.events === undefined
      ) {
        // Replay only newly associated sessions, including their early events.
        session = createSessionUsage();
        session.events = [];
        await readSessionUsage(path, session, repository, progressThread);
        this.#sessions.set(path, session);
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
      if (threadId === this.#threadId) {
        this.#parentSession = session;
        this.#matchParentCompletions();
        this.#reconcileParentProgress();
      }
      this.#reportSessionProgress(session, threadId === this.#threadId);
      if (threadId === this.#threadId && this.#inventoryNeedsReconciliation)
        this.#reconcileParentProgress();
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
    this.#reportCost(cost);
  }

  #reportSessionProgress(session: SessionUsage, parent: boolean): void {
    if (this.#options.onProgress === undefined || session.threadId === null) {
      return;
    }
    for (const saved of session.progress.splice(0)) {
      if (parent && !this.#savedParentProgressIsCurrent(saved)) continue;
      if (saved.duplicate) {
        if (parent && saved.completion)
          this.#parentFrontier = {
            position: saved.position,
            markerIndex: saved.markerIndex,
          };
        continue;
      }
      const progress = saved.update;
      const expectedFilesTotal = this.#expectedFilesTotal;
      const parentInventory =
        parent &&
        progress.phase === "discovery" &&
        (this.#parentProgress?.filesCompleted ?? 0) === 0 &&
        progress.filesCompleted === 0;
      const order = ++this.#progressOrder;
      if (
        (!parent &&
          session.filesTotal !== null &&
          progress.filesTotal !== session.filesTotal) ||
        progress.filesCompleted < session.filesCompleted
      )
        continue;
      if (
        !parentInventory &&
        expectedFilesTotal !== undefined &&
        progress.filesTotal > expectedFilesTotal
      ) {
        if (!parent) {
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
      if (!parent) {
        const key = progressKey(progress);
        if (session.workerProgress.has(key)) continue;
        session.workerProgress.add(key);
      }
      session.filesTotal = progress.filesTotal;
      session.filesCompleted = progress.filesCompleted;
      if (parentInventory && this.#highestFilesCompleted > 0) {
        // Resumed workers may be enumerated before the parent's inventory.
        // Admit the scope independently while preserving eligible worker counts.
        this.#parentProgress = progress;
        if (saved.completion || saved.receipt) {
          this.#parentFrontier = {
            position: saved.position,
            markerIndex: saved.markerIndex,
          };
          this.#inventoryFrontier = { ...this.#parentFrontier };
        }
        this.setExpectedFilesTotal(progress.filesTotal);
        this.#reconcileParentProgress();
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
      if (filesCompleted < this.#highestFilesCompleted) continue;
      if (parent) this.#parentProgress = progress;
      const update = {
        ...progress,
        filesCompleted,
        filesTotal: parent
          ? progress.filesTotal
          : (expectedFilesTotal ??
            Math.max(progress.filesTotal, filesCompleted)),
      };
      const key = `${update.phase}:${update.filesCompleted}:${update.filesTotal}`;
      if (parent && (saved.completion || saved.receipt)) {
        this.#parentFrontier = {
          position: saved.position,
          markerIndex: saved.markerIndex,
        };
        if (parentInventory)
          this.#inventoryFrontier = { ...this.#parentFrontier };
      }
      if (this.#lastProgress === key) continue;
      this.#lastProgress = key;
      this.#highestFilesCompleted = update.filesCompleted;
      this.#displayedProgress = {
        update,
        owner: parent ? "parent" : "worker",
        order,
        ...(parent ? { position: saved.position } : {}),
      };
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
): Promise<void> {
  if (session.unreadable) return;
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(SESSION_READ_SIZE);
    while (true) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
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
    if (
      isRecord(value) &&
      (value["type"] === "CommandExecution" || value["type"] === "AgentMessage")
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

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function persistedOutputDigest(text: string, fullDigest: string): string {
  if (Buffer.byteLength(text) <= PERSISTED_COMMAND_OUTPUT_BYTES)
    return fullDigest;
  const bytes = Buffer.from(text);
  const budget =
    PERSISTED_COMMAND_OUTPUT_BYTES - Buffer.byteLength(PERSISTED_OUTPUT_GAP);
  let prefixEnd = Math.floor(budget / 2);
  let suffixStart = bytes.length - (budget - prefixEnd);
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
  updates: readonly ScanProgress[],
): boolean {
  // Finalized messages concatenate parts; original responses retain separate
  // lines. Only suppress copies that recovered the same progress updates.
  const key = `${textDigest}:${digest(JSON.stringify(updates))}`;
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
  const markers = scanProgressUpdatesFromText(text);
  return {
    ...progressSignature(kind, text, command),
    // Missing fence delimiters in the persisted middle can make quoted text
    // look like a marker. Only full output establishes those progress updates.
    updates:
      kind === "command" && text.includes(PERSISTED_OUTPUT_GAP) ? [] : markers,
  };
}

function matchingProgressItem(
  live: ProgressItem,
  saved: ProgressItem,
): boolean {
  return (
    live.kind === saved.kind &&
    live.commandDigest === saved.commandDigest &&
    (live.outputDigest === saved.outputDigest ||
      live.persistedOutputDigest === saved.outputDigest)
  );
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
