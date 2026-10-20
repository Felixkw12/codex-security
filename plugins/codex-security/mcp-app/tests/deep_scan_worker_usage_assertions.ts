import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DeepScanLogEvent } from "../src/deep-scan/types.js";
import type { WorkerUsageReceipt } from "../src/deep-scan/usage-receipt.js";
import { readJson } from "./support/json.ts";

async function workerReceipts(
  scanDirectory: string,
): Promise<WorkerUsageReceipt[]> {
  const directory = join(scanDirectory, "artifacts", "deep_discovery", "usage");
  return Promise.all(
    (await readdir(directory)).map((name) => readJson(join(directory, name))),
  );
}

function assertPairedAttempts(
  receipts: WorkerUsageReceipt[],
  events: DeepScanLogEvent[],
) {
  const starts = events.filter((event) => event.event === "worker_started");
  const finishes = events.filter((event) => event.event === "worker_finished");
  assert.equal(starts.length, receipts.length);
  assert.equal(finishes.length, starts.length);
  for (const receipt of receipts)
    assert.equal(receipt.usageScope, "thread_cumulative");
  for (const start of starts) {
    const finish = finishes.find(
      (event) => event.attemptId === start.attemptId,
    );
    assert.ok(finish);
    assert.equal(finish.kind, start.kind);
    assert.equal(finish.retry, start.retry);
    assert.equal(finish.resumed, start.resumed);
    assert.ok(Number.isFinite(Date.parse(start.timestamp!)));
    assert.ok(Number.isFinite(Date.parse(finish.timestamp!)));
    assert.ok(finish.durationMs! >= 0);
  }
}

export async function assertWorkerRetryReceipts(
  scanDirectory: string,
  events: DeepScanLogEvent[],
) {
  const receipts = await workerReceipts(scanDirectory);
  const discovery = receipts
    .filter((receipt) => receipt.kind === "discovery")
    .sort((left, right) => left.attempt - right.attempt);
  assert.equal(discovery.length, 2);
  assert.notEqual(discovery[0].attemptId, discovery[1].attemptId);
  assert.equal(discovery[0].threadId, discovery[1].threadId);
  assert.deepEqual(
    discovery.map((receipt) => [
      receipt.outcome,
      receipt.resumed,
      receipt.usage?.total_tokens,
    ]),
    [
      ["failed", false, 12],
      ["succeeded", true, 24],
    ],
  );
  assertPairedAttempts(receipts, events);
}

export async function assertCanceledWorkerReceipts(
  scanDirectory: string,
  events: DeepScanLogEvent[],
  usageReported: boolean,
) {
  const receipts = await workerReceipts(scanDirectory);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "canceled");
  if (usageReported) {
    assert.equal(receipts[0].usage?.total_tokens, 12);
    assert.equal(receipts[0].turnId, "synthetic-turn");
  } else assert.equal(receipts[0].usage, null);
  assert.ok(receipts[0].threadId);
  assert.equal(
    events.find((event) => event.event === "worker_finished")?.outcome,
    "canceled",
  );
  assertPairedAttempts(receipts, events);
}
