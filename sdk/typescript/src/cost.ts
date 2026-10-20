import { parseJson } from "./value.js";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "./record.js";
import { sessionLines } from "./session-lines.js";
import {
  estimateScanCost,
  tokenUsage,
  type ScanCost,
  type ScanTokenUsage,
} from "./cost-model.js";
import {
  scanActivityFromSessionEvent,
  sessionContentText,
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

type SessionReasoning = ReturnType<typeof createSessionReasoning>;

function createSessionReasoning(id: string, text = "") {
  return { id, text, raw: false, activity: null as ScanActivity | null };
}

type SessionUsage = ReturnType<typeof createSessionUsage> & {
  events?: Record<string, unknown>[];
};

interface ScanCostTrackerOptions {
  codexHome: string;
  model: string;
  repository?: string;
  scanDirectory?: string;
  maxCostUsd?: number;
  expectedFilesTotal?: number;
  /** Incomplete costs are measured subtotals, usable for spending limits only. */
  onCost?: (cost: Readonly<ScanCost>, complete: boolean) => void;
  onUsage?: (usage: Readonly<ScanTokenUsage>) => void;
  onMeasurement?: (measurement: Readonly<ScanUsageMeasurement>) => void;
  onActivity?: (activity: ScanActivity) => void;
  onProgress?: (progress: ScanProgress) => void;
  onSessionEvent?: (event: ScanSessionEvent) => void;
  onWorkerEvent?: (event: ScanWorkerEvent) => void;
  onError?: (error: unknown) => void;
}

export interface ScanUsageMeasurement {
  usage: Readonly<ScanTokenUsage> | null;
  cost: Readonly<ScanCost> | null;
  coverage: "complete" | "partial" | "unavailable";
  observedAt: string;
  threadCount: number;
  missingThreadCount: number;
  /** Known thread/attempt identities for reconciling coverage, not metric labels. */
  coverageScope?: string[];
}

export interface ScanCostSnapshot {
  usage: unknown;
  cost: ScanCost | null;
  measurement: ScanUsageMeasurement;
}

const COST_POLL_INTERVAL_MS = 100;
const SESSION_READ_SIZE = 64 * 1_024;

function createSessionUsage() {
  return {
    offset: 0,
    decoder: new StringDecoder("utf8"),
    pendingLine: [] as string[],
    unreadable: false,
    compressedRead: false,
    threadId: null as string | null,
    parentThreadId: null as string | null,
    workingDirectory: null as string | null,
    startedAt: null as number | null,
    inheritedUsage: null as ScanTokenUsage | null,
    replaying: false,
    usage: null as ScanTokenUsage | null,
    responseUsage: null as ScanTokenUsage | null,
    responseIds: new Set<string>(),
    calls: new Map<string, ScanActivity>(),
    activities: [] as ScanActivity[],
    progress: [] as ScanProgress[],
    filesCompleted: 0,
    filesTotal: null as number | null,
    prose: new Set<string>(),
    reasoning: null as SessionReasoning | null,
    reasoningCount: 0,
  };
}

export class ScanCostTracker {
  readonly #options: ScanCostTrackerOptions;
  readonly #sessions = new Map<string, SessionUsage>();
  readonly #receipts = new Map<string, ScanTokenUsage | null>();
  readonly #workers = new Map<string, number>();
  readonly #workerProgress = new Map<string, number>();
  readonly #reportedProgress = new Set<string>();
  #threadId: string | null = null;
  #observingWorkers = true;
  #timer: NodeJS.Timeout | null = null;
  #pending: Promise<void> = Promise.resolve();
  #snapshot: ScanCostSnapshot = {
    usage: null,
    cost: null,
    measurement: {
      usage: null,
      cost: null,
      coverage: "unavailable",
      observedAt: new Date().toISOString(),
      threadCount: 0,
      missingThreadCount: 0,
    },
  };
  #lastCost: string | null = null;
  #lastUsage: string | null = null;
  #lastMeasurement: string | null = null;
  #highestFilesCompleted = 0;
  #expectedFilesTotal: number | undefined;

  public constructor(options: ScanCostTrackerOptions) {
    this.#options = options;
    this.#expectedFilesTotal = options.expectedFilesTotal;
  }

  public setExpectedFilesTotal(filesTotal: number): void {
    this.#expectedFilesTotal = filesTotal;
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
      this.#options.onMeasurement === undefined &&
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
      try {
        await this.#readSessions();
      } catch (error) {
        const previous = this.#snapshot.measurement;
        this.#setSnapshot(
          previous.usage,
          previous.cost,
          false,
          previous.threadCount,
          Math.max(1, previous.missingThreadCount),
          previous.coverageScope,
        );
        throw error;
      }
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
    if (
      this.#receipts.size > 0 ||
      this.#snapshot.measurement.usage !== null ||
      this.#snapshot.measurement.missingThreadCount > 0
    )
      return this.#snapshot;
    const cost = estimateScanCost(this.#options.model, fallbackUsage);
    const usage = tokenUsage(fallbackUsage);
    this.#setSnapshot(usage, cost, usage !== null, usage === null ? 0 : 1, 0);
    this.#reportUsage(usage);
    this.#reportCost(cost);
    return this.#snapshot;
  }

  async #readSessions(): Promise<void> {
    if (this.#threadId === null) return;
    const repository =
      this.#options.onActivity === undefined
        ? undefined
        : this.#options.repository;
    let collectionError: unknown;
    const unreadable: Array<{ session: SessionUsage; error: unknown }> = [];
    for (const directory of ["sessions", "archived_sessions"]) {
      try {
        for await (const path of sessionFiles(
          join(this.#options.codexHome, directory),
          true,
        )) {
          let session = this.#sessions.get(path);
          if (session === undefined) {
            session = createSessionUsage();
            this.#sessions.set(path, session);
          }
          try {
            await readSessionUsage(
              path,
              session,
              repository,
              path.endsWith(".zst"),
            );
          } catch (error) {
            if (session.threadId === null) collectionError ??= error;
            else unreadable.push({ session, error });
          }
        }
      } catch (error) {
        collectionError ??= error;
      }
    }

    let workerReceipts: Awaited<ReturnType<typeof readWorkerReceipts>> = {
      usages: new Map(),
      unknownAttempts: 0,
      attemptIds: new Set(),
    };
    try {
      workerReceipts = await readWorkerReceipts(this.#options.scanDirectory);
    } catch (error) {
      collectionError ??= error;
    }
    const included = new Set([
      this.#threadId,
      ...this.#receipts.keys(),
      ...workerReceipts.usages.keys(),
    ]);
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
      if (included.has(session.threadId!)) collectionError ??= error;
    }

    const usages = new Map<string, ScanTokenUsage | null>(
      [...included].map((threadId) => [
        threadId,
        this.#receipts.get(threadId) ?? null,
      ]),
    );
    for (const [threadId, receipt] of workerReceipts.usages) {
      const current = usages.get(threadId);
      if (
        receipt !== null &&
        receipt.total_tokens > (current?.total_tokens ?? -1)
      )
        usages.set(threadId, receipt);
    }
    // SDK totals retain measured usage when a rollout is unavailable.
    // Native rollouts also establish descendant coverage.
    const incomplete = new Set(workerReceipts.usages.keys());
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
        try {
          await readSessionUsage(path, session, repository);
          this.#sessions.set(path, session);
        } catch (error) {
          collectionError ??= error;
          session = tracked;
        }
      } else if (path.endsWith(".zst") && !session.compressedRead) {
        // Cold history is immutable. Decode its body only after metadata has
        // associated the thread with this scan.
        try {
          await readSessionUsage(path, session, repository);
        } catch (error) {
          collectionError ??= error;
        }
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
        this.#reportWorkerProgress(session);
      }
      const receipt = usages.get(threadId);
      if (
        session.usage !== null &&
        session.usage.total_tokens >=
          (workerReceipts.usages.get(threadId)?.total_tokens ?? 0)
      )
        incomplete.delete(threadId);
      // A discovered thread without a receipt has unknown usage, not zero.
      // Retain it so a parent-only subtotal cannot appear to be complete.
      if (receipt === undefined) usages.set(threadId, null);
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
    let missingThreadCount = workerReceipts.unknownAttempts;
    let threadCount = 0;
    for (const [threadId, value] of usages) {
      if (value === null) {
        missingThreadCount += 1;
        continue;
      }
      threadCount += 1;
      if (incomplete.has(threadId)) missingThreadCount += 1;
      usage = addTokenUsage(usage, value);
    }
    if (collectionError !== undefined)
      missingThreadCount = Math.max(1, missingThreadCount);
    const complete = missingThreadCount === 0 && usage !== null;
    const cost = estimateScanCost(this.#options.model, usage);
    this.#setSnapshot(
      usage,
      cost,
      complete,
      threadCount,
      missingThreadCount,
      collectionError === undefined
        ? [
            ...[...included].map((id) => `thread:${id}`),
            ...[...workerReceipts.attemptIds].map(
              (id) => `worker-attempt:${id}`,
            ),
          ].sort()
        : undefined,
    );
    if (complete) {
      this.#reportUsage(usage);
    }
    this.#reportCost(cost, complete);
    // Preserve every available receipt before surfacing the original read error.
    if (collectionError !== undefined) throw collectionError;
  }

  #setSnapshot(
    usage: ScanTokenUsage | null,
    cost: ScanCost | null,
    complete: boolean,
    threadCount: number,
    missingThreadCount: number,
    coverageScope?: string[],
  ): void {
    const data = {
      usage,
      cost,
      coverage:
        usage === null ? "unavailable" : complete ? "complete" : "partial",
      threadCount,
      missingThreadCount,
      ...(coverageScope === undefined ? {} : { coverageScope }),
    } as const;
    const measurement = { ...data, observedAt: new Date().toISOString() };
    this.#snapshot = {
      usage: complete ? usage : null,
      cost: complete ? cost : null,
      measurement,
    };
    const signature = JSON.stringify(data);
    if (signature === this.#lastMeasurement) return;
    this.#lastMeasurement = signature;
    this.#options.onMeasurement?.(measurement);
  }

  #reportWorkerProgress(session: SessionUsage): void {
    if (this.#options.onProgress === undefined || session.threadId === null) {
      return;
    }
    for (const progress of session.progress.splice(0)) {
      const expectedFilesTotal = this.#expectedFilesTotal;
      if (
        (expectedFilesTotal !== undefined &&
          progress.filesTotal > expectedFilesTotal) ||
        (session.filesTotal !== null &&
          progress.filesTotal !== session.filesTotal) ||
        progress.filesCompleted < session.filesCompleted
      ) {
        continue;
      }
      session.filesTotal = progress.filesTotal;
      session.filesCompleted = progress.filesCompleted;
      this.#workerProgress.set(session.threadId, progress.filesCompleted);
      const filesCompleted = Math.min(
        expectedFilesTotal ?? Number.MAX_SAFE_INTEGER,
        this.#workerProgress
          .values()
          .reduce((total, reviewed) => total + reviewed, 0),
      );
      if (filesCompleted < this.#highestFilesCompleted) continue;
      const update = {
        ...progress,
        filesCompleted,
        filesTotal:
          expectedFilesTotal ?? Math.max(progress.filesTotal, filesCompleted),
      };
      const key = `${update.phase}:${update.filesCompleted}:${update.filesTotal}`;
      if (this.#reportedProgress.has(key)) continue;
      this.#reportedProgress.add(key);
      this.#highestFilesCompleted = update.filesCompleted;
      this.#options.onProgress(update);
    }
  }

  #reportCost(cost: ScanCost | null, complete = true): void {
    if (cost === null) return;
    const signature = JSON.stringify([cost, complete]);
    if (signature === this.#lastCost) return;
    this.#lastCost = signature;
    this.#options.onCost?.(cost, complete);
  }

  #reportUsage(usage: ScanTokenUsage | null): void {
    if (usage === null) return;
    const signature = JSON.stringify(usage);
    if (signature === this.#lastUsage) return;
    this.#lastUsage = signature;
    this.#options.onUsage?.(usage);
  }
}

async function readWorkerReceipts(scanDirectory: string | undefined): Promise<{
  usages: Map<string, ScanTokenUsage | null>;
  unknownAttempts: number;
  attemptIds: Set<string>;
}> {
  const usages = new Map<string, ScanTokenUsage | null>();
  const attempts = new Set<string>();
  const result = { usages, unknownAttempts: 0, attemptIds: attempts };
  if (scanDirectory === undefined) return result;
  const directory = join(scanDirectory, "artifacts", "deep_discovery", "usage");
  try {
    const directoryInfo = await lstat(directory);
    if (
      !directoryInfo.isDirectory() ||
      relative(resolve(directory), await realpath(directory)) !== ""
    )
      throw new Error(
        `Worker usage directory must use a canonical directory: ${directory}`,
      );
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const receipt: unknown = JSON.parse(
        await readFile(join(directory, entry.name), "utf8"),
      );
      if (
        !isRecord(receipt) ||
        receipt["schemaVersion"] !== 1 ||
        receipt["source"] !== "codex_sdk" ||
        receipt["usageScope"] !== "thread_cumulative" ||
        typeof receipt["attemptId"] !== "string" ||
        attempts.has(receipt["attemptId"])
      )
        continue;
      attempts.add(receipt["attemptId"]);
      if (typeof receipt["threadId"] !== "string") {
        result.unknownAttempts += 1;
        continue;
      }
      const usage = tokenUsage(receipt["usage"]);
      const existing = usages.get(receipt["threadId"]) ?? null;
      // Native SDK completions include earlier turns of a resumed thread.
      usages.set(
        receipt["threadId"],
        usage !== null &&
          (existing === null ||
            usage.total_tokens > existing.total_tokens ||
            (usage.total_tokens === existing.total_tokens &&
              existing.cache_write_input_tokens_reported === false &&
              usage.cache_write_input_tokens_reported !== false))
          ? usage
          : existing,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
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
  metadataOnly = false,
): Promise<void> {
  if (session.unreadable) return;
  if (path.endsWith(".zst")) {
    if (session.compressedRead) return;
    if (metadataOnly && session.threadId !== null) return;
    for await (const line of sessionLines(path)) {
      readSessionEvent(line, session, repository);
      if (metadataOnly && session.threadId !== null) return;
    }
    session.compressedRead = true;
    return;
  }
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
          readSessionEvent(session.pendingLine.join(""), session, repository);
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
  if (event["type"] === "token_usage_record") {
    const responseId = payload["response_id"];
    if (
      payload["thread_id"] !== session.threadId ||
      typeof responseId !== "string" ||
      session.responseIds.has(responseId)
    ) {
      return;
    }
    const usage = tokenUsage(payload["usage"]);
    if (usage === null) return;
    session.responseIds.add(responseId);
    session.responseUsage = addTokenUsage(session.responseUsage, usage);
    // Native thread totals include compaction and any earlier turns. They are
    // scoped to thread_id, unlike inherited legacy token_count snapshots.
    const total = tokenUsage(payload["thread_token_usage"]);
    const recorded =
      total !== null && total.total_tokens >= session.responseUsage.total_tokens
        ? total
        : session.responseUsage;
    if (
      session.usage === null ||
      recorded.total_tokens >= session.usage.total_tokens
    ) {
      session.usage = recorded;
    }
    return;
  }
  if (event["type"] === "response_item") {
    session.progress.push(...sessionProgressUpdates(payload));
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
        session.reasoning = createSessionReasoning(
          activity.id,
          activity.description,
        );
        recordReasoningActivity(session, activity);
      }
      return;
    }
    const activity = scanActivityFromSessionEvent(event, repository);
    if (activity !== null) {
      if (activity.kind === "reasoning") {
        const reasoning = (session.reasoning ??= createSessionReasoning(
          activity.id,
          activity.description,
        ));
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
      session.progress.push(...scanProgressUpdatesFromText(payload["message"]));
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
  // Older runtimes only emit token_count. In newer rollouts these snapshots can
  // lag compaction receipts, so do not replace a more complete native total.
  if (
    ownUsage !== null &&
    (session.usage === null ||
      ownUsage.total_tokens > session.usage.total_tokens ||
      (session.responseUsage === null &&
        ownUsage.total_tokens === session.usage.total_tokens))
  ) {
    session.usage = ownUsage;
  }
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
  const reasoning = (session.reasoning ??= createSessionReasoning(
    `reasoning-${++session.reasoningCount}`,
  ));
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

function sessionProgressUpdates(
  payload: Readonly<Record<string, unknown>>,
): ScanProgress[] {
  if (payload["type"] === "message" && payload["role"] === "assistant") {
    return scanProgressUpdatesFromText(sessionContentText(payload["content"]));
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
      : sessionContentText(value, ["output_text", "input_text"]);
  if (payload["status"] === "failed") {
    return [];
  }
  return scanProgressUpdatesFromText(output);
}

export function addTokenUsage(
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
