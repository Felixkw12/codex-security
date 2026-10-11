import { parseJson } from "./value.js";
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
  sourcePosition: number | null;
  completion: boolean;
  markerIndex: number;
}

interface ProgressItem {
  kind: "message" | "command";
  text: string;
  command?: readonly string[];
}

interface SessionCompletion {
  position: number;
  item: ProgressItem | null;
}

export interface ParentProgressSource {
  event: Readonly<Record<string, unknown>>;
  reconciled?: true;
  inventory?: true;
}

interface StreamedProgressItem {
  accepted: ScanProgress | null;
  observedMarkerIndex: number;
  acceptedMarkerIndex: number;
  event: Readonly<Record<string, unknown>>;
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
  callPositions: Map<string, number>;
  completions: SessionCompletion[];
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
    callPositions: new Map(),
    completions: [],
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

  public constructor(options: ScanCostTrackerOptions) {
    this.#options = options;
    if (options.expectedFilesTotal !== undefined)
      this.setExpectedFilesTotal(options.expectedFilesTotal);
  }

  public setExpectedFilesTotal(filesTotal: number): void {
    this.#expectedFilesTotal = filesTotal;
  }

  /** Called before launching a turn, after loading any resumed history. */
  public beginParentTurn(resumed = false): void {
    this.#parentTurnStart =
      this.#parentSession?.position ?? (resumed ? null : 0);
    this.#liveParentItems.length = 0;
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
      this.#liveParentItems.at(-1)?.event === event
    )
      return;
    this.#liveParentItems.push({
      event,
      item: streamedProgressItem(event),
      position: null,
      accepted: null,
      observedMarkerIndex: -1,
      acceptedMarkerIndex: -1,
    });
    this.#matchParentCompletions();
  }

  /** Observe source identity before applying display/count guards. */
  public recordParentProgress(
    _progress: ScanProgress,
    event: Readonly<Record<string, unknown>>,
  ): boolean {
    this.recordParentItem(event);
    const live = this.#liveParentItems.at(-1);
    if (live?.event !== event) return true;
    live.observedMarkerIndex++;
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
    const live = this.#liveParentItems.at(-1);
    if (live?.event !== event) return;
    live.accepted = progress;
    live.acceptedMarkerIndex = live.observedMarkerIndex;
    this.#lastProgress = progressKey(progress);
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
    const completions = this.#parentSession.completions.filter(
      (saved) => saved.position > this.#parentTurnStart!,
    );
    // Both projections preserve completion order for commands and messages.
    // Verify each occurrence instead of searching for matching retained text:
    // a later command may have the same prefix/suffix as an earlier one.
    for (const [index, live] of this.#liveParentItems.entries()) {
      const saved = completions[index];
      if (
        live.position === null &&
        live.item !== null &&
        saved?.item !== null &&
        saved?.item !== undefined &&
        matchingProgressItem(live.item, saved.item)
      ) {
        live.position = saved.position;
      }
    }
  }

  #reconcileParentProgress(): void {
    const live = this.#liveParentItems.findLast(
      (item) => item.accepted !== null,
    );
    if (
      live?.accepted === null ||
      live?.accepted === undefined ||
      live.position === null
    )
      return;
    const index = live.acceptedMarkerIndex;
    if (!this.#afterParentFrontier(live.position, index)) return;
    this.#parentFrontier = { position: live.position, markerIndex: index };
    let progress = live.accepted;
    const inventory =
      progress.phase === "discovery" && progress.filesCompleted === 0;
    if (inventory) {
      // A provisional older preview may have normalized worker counts against
      // the wrong inventory. Reapply the same shard bounds to their receipts;
      // do not turn an invalid overcount into claimed reviewed coverage.
      this.#expectedFilesTotal = progress.filesTotal;
      for (const session of this.#sessions.values()) {
        if (
          session.threadId !== null &&
          session.filesTotal !== null &&
          session.filesTotal > progress.filesTotal
        )
          this.#workerProgress.delete(session.threadId);
      }
      const workers = this.#workerProgress
        .values()
        .reduce((sum, count) => sum + count, 0);
      progress = {
        ...progress,
        filesCompleted: Math.min(progress.filesTotal, workers),
      };
      if (this.#parentSession !== null) {
        this.#parentSession.filesCompleted = 0;
        this.#parentSession.filesTotal = progress.filesTotal;
      }
      this.#highestFilesCompleted = progress.filesCompleted;
    }
    const key = progressKey(progress);
    if (this.#lastProgress === key) return;
    this.#lastProgress = key;
    this.#options.onProgress?.(progress, {
      event: live.event,
      reconciled: true,
      ...(inventory ? { inventory: true } : {}),
    });
  }

  #savedParentProgressIsCurrent(saved: SessionProgress): boolean {
    if (!this.#afterParentFrontier(saved.position, saved.markerIndex))
      return false;
    if (!saved.completion) {
      // Response-item previews can follow a full native completion. A later
      // tool call establishes a new receipt; a copied marker does not.
      const native = this.#parentSession?.completions.findLast(
        (completion) =>
          completion.position < saved.position &&
          scanProgressUpdatesFromText(completion.item?.text ?? "").some(
            (progress) => progressKey(progress) === progressKey(saved.update),
          ),
      );
      if (
        native !== undefined &&
        (saved.sourcePosition === null ||
          saved.sourcePosition <= native.position)
      )
        return false;
    }
    const live = this.#liveParentItems.findLast(
      (item) => item.accepted !== null,
    );
    if (live === undefined) return true;
    if (live.position !== null && saved.position <= live.position) return false;
    if (!this.#liveParentProgress.has(progressKey(saved.update))) return true;
    return (
      live.position !== null &&
      (saved.completion ||
        (saved.sourcePosition !== null && saved.sourcePosition > live.position))
    );
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
      const progress = saved.update;
      const expectedFilesTotal = this.#expectedFilesTotal;
      const parentInventory =
        parent &&
        progress.phase === "discovery" &&
        this.#highestFilesCompleted === 0 &&
        progress.filesCompleted === 0;
      if (
        (!parentInventory &&
          expectedFilesTotal !== undefined &&
          progress.filesTotal > expectedFilesTotal) ||
        (!parent &&
          session.filesTotal !== null &&
          progress.filesTotal !== session.filesTotal) ||
        progress.filesCompleted < session.filesCompleted
      ) {
        continue;
      }
      session.filesTotal = progress.filesTotal;
      session.filesCompleted = progress.filesCompleted;
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
      const update = {
        ...progress,
        filesCompleted,
        filesTotal: parent
          ? progress.filesTotal
          : (expectedFilesTotal ??
            Math.max(progress.filesTotal, filesCompleted)),
      };
      const key = `${update.phase}:${update.filesCompleted}:${update.filesTotal}`;
      if (parent)
        this.#parentFrontier = {
          position: saved.position,
          markerIndex: saved.markerIndex,
        };
      if (this.#lastProgress === key) continue;
      this.#lastProgress = key;
      this.#highestFilesCompleted = update.filesCompleted;
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
    const callId = payload["call_id"];
    if (
      session.threadId === progressThread &&
      typeof callId === "string" &&
      (payload["type"] === "function_call" ||
        payload["type"] === "custom_tool_call" ||
        payload["type"] === "local_shell_call")
    ) {
      session.callPositions.set(callId, position);
    }
    for (const [markerIndex, update] of sessionProgressUpdates(
      payload,
    ).entries()) {
      session.progress.push({
        update,
        position,
        sourcePosition:
          typeof callId === "string"
            ? (session.callPositions.get(callId) ?? null)
            : null,
        completion: false,
        markerIndex,
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
    )
      session.completions.push({ position, item });
    if (item !== null) {
      for (const [markerIndex, update] of nativeProgressUpdates(
        item,
      ).entries()) {
        session.progress.push({
          update,
          position,
          sourcePosition: position,
          completion: true,
          markerIndex,
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
      for (const [markerIndex, update] of scanProgressUpdatesFromText(
        payload["message"],
      ).entries()) {
        session.progress.push({
          update,
          position,
          sourcePosition: null,
          completion: false,
          markerIndex,
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

function nativeProgressUpdates(item: ProgressItem): ScanProgress[] {
  // A truncated middle can remove a Markdown fence delimiter. Its retained
  // text is useful for identity, but only the live output establishes markers.
  return item.kind === "command" && item.text.includes(PERSISTED_OUTPUT_GAP)
    ? []
    : scanProgressUpdatesFromText(item.text);
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
    return { kind: "message", text: item["text"] };
  if (
    item["type"] !== "command_execution" ||
    typeof item["aggregated_output"] !== "string" ||
    typeof item["command"] !== "string"
  )
    return null;
  const command = splitCommand(item["command"]);
  return command === null
    ? null
    : { kind: "command", text: item["aggregated_output"], command };
}

function nativeProgressItem(value: unknown): ProgressItem | null {
  if (!isRecord(value)) return null;
  if (value["type"] === "AgentMessage" && Array.isArray(value["content"])) {
    return {
      kind: "message",
      text: value["content"]
        .filter(
          (part): part is { text: string } =>
            isRecord(part) &&
            part["type"] === "Text" &&
            typeof part["text"] === "string",
        )
        .map((part) => part.text)
        .join("\n"),
    };
  }
  if (
    value["type"] !== "CommandExecution" ||
    typeof value["aggregated_output"] !== "string" ||
    !Array.isArray(value["command"]) ||
    !value["command"].every((arg): arg is string => typeof arg === "string")
  )
    return null;
  return {
    kind: "command",
    text: value["aggregated_output"],
    command: value["command"],
  };
}

function matchingProgressItem(
  live: ProgressItem,
  saved: ProgressItem,
): boolean {
  if (live.kind !== saved.kind) return false;
  if (
    live.kind === "command" &&
    JSON.stringify(live.command) !== JSON.stringify(saved.command)
  )
    return false;
  if (live.text === saved.text) return true;
  if (live.kind !== "command") return false;
  // Native persistence keeps the head and tail of long command output. Match
  // those retained bytes, rather than requiring an omitted progress marker.
  const parts = saved.text.split(PERSISTED_OUTPUT_GAP);
  return (
    parts.length === 2 &&
    live.text.startsWith(parts[0]!) &&
    live.text.endsWith(parts[1]!) &&
    live.text.length >= parts[0]!.length + parts[1]!.length
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
