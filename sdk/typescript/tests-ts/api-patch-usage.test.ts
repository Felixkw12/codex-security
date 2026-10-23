import { Codex } from "@openai/codex-sdk";
import { afterEach, expect, test } from "bun:test";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { estimateScanCost, type ScanUsageMeasurement } from "../src/cost.js";
import { ScanInterruptedError } from "../src/errors.js";
import {
  OperationTelemetry,
  readOperationTelemetry,
  type OperationTelemetryEvent,
} from "../src/operation-telemetry.js";
import { TestClient } from "./support/api-client.js";
import { preparedRuntime } from "./support/api-events.js";
import { createApiTestFixtures } from "./support/temporary-directories.js";

const { temporaryDirectory, cleanup } = createApiTestFixtures(
  "codex-security-patch-usage-",
);
afterEach(cleanup);

const receipt = {
  input_tokens: 100,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 10,
  reasoning_output_tokens: 0,
};
const noChange = {
  status: "no_change",
  changedFiles: [],
  verificationReport: "The synthetic finding is already safe.",
  reason: null,
};

test.each([
  "invalid JSON",
  "invalid schema",
  "valid no_change",
  "canceled after completion",
  "null usage",
  "absent usage",
] as const)("preserves completed SDK patch usage with %s", async (ending) => {
  const root = await temporaryDirectory();
  const repository = join(root, "repository");
  const codexHome = join(root, "codex-home");
  const state = join(root, "state");
  await mkdir(repository);
  await mkdir(codexHome);
  const controller = new AbortController();
  const observed: Readonly<OperationTelemetryEvent>[] = [];
  const measurements: Readonly<ScanUsageMeasurement>[] = [];
  const model = "gpt-5.6-terra";
  const environment = {
    CODEX_SECURITY_STATE_DIR: state,
    OPENAI_API_KEY: "synthetic-patch-usage-key",
  };
  const usage =
    ending === "null usage"
      ? null
      : ending === "absent usage"
        ? undefined
        : receipt;
  const response =
    ending === "invalid JSON"
      ? "not JSON"
      : JSON.stringify(
          ending === "invalid schema"
            ? { ...noChange, verificationReport: " " }
            : noChange,
        );
  let executions = 0;
  await using client = new TestClient(
    { codexOverrides: { model, analytics: { enabled: false } } },
    {
      environment,
      prepareRuntime: async () => ({
        ...preparedRuntime(codexHome),
        environment,
      }),
      resolvePluginPython: async () => "/managed/python",
      createOperationTelemetry: (options) => new OperationTelemetry(options),
      createCodex: (options) => {
        const codex = new Codex({
          ...options,
          codexPathOverride: process.execPath,
        });
        return {
          startThread: (options) => {
            const thread = codex.startThread(options);
            const executable = thread as unknown as {
              _exec: { run(): AsyncGenerator<string> };
            };
            executable._exec.run = async function* () {
              executions++;
              yield JSON.stringify({
                type: "thread.started",
                thread_id: "patch-usage-thread",
              });
              yield JSON.stringify({
                type: "item.completed",
                item: { id: "result", type: "agent_message", text: response },
              });
              yield JSON.stringify({ type: "turn.completed", usage });
              if (ending === "canceled after completion") {
                controller.abort(new Error("Synthetic cancellation."));
              }
            };
            return thread;
          },
        };
      },
    },
  );
  const pending = client.patch({
    repositoryPath: repository,
    finding: "Synthetic candidate finding.",
    auth: "api-key",
    signal: controller.signal,
    onTelemetry: (event) => observed.push(event),
    onMeasurement: (measurement) => measurements.push(measurement),
  });
  const canceled = ending === "canceled after completion";
  const invalid = ending === "invalid JSON" || ending === "invalid schema";
  if (canceled) {
    await expect(pending).rejects.toBeInstanceOf(ScanInterruptedError);
  } else if (invalid) {
    await expect(pending).rejects.toThrow(
      "Finding patch returned an invalid result.",
    );
  } else {
    expect(await pending).toMatchObject({
      status: "no_change",
      threadId: "patch-usage-thread",
      cost: estimateScanCost(model, usage),
    });
  }
  expect(executions).toBe(1);
  await expect(access(join(codexHome, "sessions"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
  const saved = await readOperationTelemetry(state);
  expect(saved.parseFailures).toBe(0);
  expect(saved.events.map((event) => event.type)).toEqual([
    "attempt_started",
    "attempt_finished",
  ]);
  expect(observed.map((event) => event.eventId)).toEqual(
    saved.events.map((event) => event.eventId),
  );
  const terminal = saved.events.at(-1)!;
  expect(terminal.outcome).toBe(
    canceled ? "canceled" : invalid ? "failed" : "completed",
  );
  expect(terminal.measurement).toEqual(measurements.at(-1));
  expect(terminal.measurement).toMatchObject({
    usage:
      usage == null
        ? null
        : { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    coverage: usage == null ? "unavailable" : "complete",
    cost: estimateScanCost(model, usage),
  });
});
