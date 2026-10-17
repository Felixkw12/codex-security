import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { assertFlagPair } from "./assertions.ts";
import { readJson } from "./support/json.ts";
import type { CodexSdkWorkerExecutor as WorkerExecutor } from "../src/deep-scan/executor.js";
import type { DeepWorkerParentSandbox } from "../src/deep-scan/parent-sandbox.js";
import type { CodexWorkerRequest } from "../src/deep-scan/types.js";

interface Fixture {
  root: string;
  markerPath: string;
  preflightMarkerPath: string;
  executablePath: string;
}

export async function testExecutorExecutablePinning({
  CodexSdkWorkerExecutor,
  fakeCodexFixture,
  parentSandbox,
}: {
  CodexSdkWorkerExecutor: typeof WorkerExecutor;
  fakeCodexFixture: () => Promise<Fixture>;
  parentSandbox: DeepWorkerParentSandbox;
}) {
  const originalSpawn = childProcess.spawn;
  if (process.platform === "win32") {
    // Windows needs Node to run the selected script fixture.
    childProcess.spawn = ((
      command: string,
      args: readonly string[] = [],
      options: SpawnOptions = {},
    ) =>
      originalSpawn(
        process.execPath,
        [command, ...args],
        options,
      )) as typeof childProcess.spawn;
    syncBuiltinESMExports();
  }
  try {
    await testExecutorPinsCodexExecutableAcrossWorkers();
    await testExecutorRejectsChangedPinnedExecutable();
    await testExecutorRejectsReplacementAfterPreflight();
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }

  async function testExecutorPinsCodexExecutableAcrossWorkers() {
    const previousPath = process.env.CODEX_CLI_PATH;
    const previousMarker = process.env.FAKE_CODEX_MARKER;
    const fixtures = [await fakeCodexFixture(), await fakeCodexFixture()];
    const executors = fixtures.map(
      () => new CodexSdkWorkerExecutor({ parentSandbox }),
    );
    try {
      for (const fixture of fixtures) {
        await writeFile(
          path.join(fixture.root, "prompt.md"),
          "fixture pinned executable\n",
        );
      }
      for (const kind of ["discovery", "dedup"] as const) {
        for (const resumeThreadId of [undefined, "fixture-resumed-thread"]) {
          const firstLaunch =
            kind === "discovery" && resumeThreadId === undefined;
          await Promise.all(
            fixtures.map((fixture, index) => {
              process.env.CODEX_CLI_PATH =
                fixtures[firstLaunch ? index : 1 - index]!.executablePath;
              process.env.FAKE_CODEX_MARKER = fixture.markerPath;
              return executors[index]!.run(
                workerRequest(
                  path.join(fixture.root, "prompt.md"),
                  fixture.root,
                  { kind, resumeThreadId },
                ),
              );
            }),
          );
          for (const fixture of fixtures) {
            const preflight = await readJson(fixture.preflightMarkerPath);
            const invocation = await readJson(fixture.markerPath);
            assert.equal(
              await realpath(preflight.executablePath),
              fixture.executablePath,
            );
            assert.deepEqual(preflight.requests, [
              { method: "config/read", cwd: fixture.root },
              { method: "permissionProfile/list", cwd: fixture.root },
            ]);
            assert.equal(
              await realpath(invocation.executablePath),
              fixture.executablePath,
            );
            assert.equal(
              invocation.argv.includes("resume"),
              resumeThreadId !== undefined,
            );
            if (resumeThreadId !== undefined) {
              assertFlagPair(invocation.argv, "resume", resumeThreadId);
            }
            assertFlagPair(invocation.argv, "--cd", fixture.root);
            await rm(fixture.preflightMarkerPath);
            await rm(fixture.markerPath);
          }
        }
      }
    } finally {
      restoreEnv("CODEX_CLI_PATH", previousPath);
      restoreEnv("FAKE_CODEX_MARKER", previousMarker);
    }
  }

  async function testExecutorRejectsChangedPinnedExecutable() {
    for (const change of ["replace", "remove"]) {
      await withWorkerFixture(async (fixture, promptPath, workingDirectory) => {
        await writeFile(promptPath, "fixture changed pinned executable\n");
        const executor = new CodexSdkWorkerExecutor({
          parentSandbox,
        });
        await executor.run(workerRequest(promptPath, workingDirectory));
        await rm(fixture.preflightMarkerPath);
        await rm(fixture.markerPath);
        if (change === "remove") {
          await rm(fixture.executablePath);
        } else {
          const original = await readFile(fixture.executablePath, "utf8");
          await writeFile(
            fixture.executablePath,
            `${original}\n// replaced after scan start\n`,
          );
        }
        for (const kind of ["discovery", "dedup"] as const) {
          for (const resumeThreadId of [undefined, "fixture-resumed-thread"]) {
            await assert.rejects(
              executor.run(
                workerRequest(promptPath, workingDirectory, {
                  kind,
                  resumeThreadId,
                }),
              ),
              {
                name: "DeepScanNonRetryableError",
                message: /changed after this Deep Scan started/i,
              },
            );
          }
        }
        await assert.rejects(readFile(fixture.preflightMarkerPath), {
          code: "ENOENT",
        });
        await assert.rejects(readFile(fixture.markerPath), { code: "ENOENT" });
      });
    }
  }

  async function testExecutorRejectsReplacementAfterPreflight() {
    const previousReplace = process.env.FAKE_CODEX_REPLACE_AFTER_PREFLIGHT;
    process.env.FAKE_CODEX_REPLACE_AFTER_PREFLIGHT = "1";
    try {
      for (const kind of ["discovery", "dedup"] as const) {
        for (const resumeThreadId of [undefined, "fixture-resumed-thread"]) {
          await withWorkerFixture(
            async (fixture, promptPath, workingDirectory) => {
              await writeFile(
                promptPath,
                "fixture replacement after preflight\n",
              );
              await assert.rejects(
                new CodexSdkWorkerExecutor({ parentSandbox }).run(
                  workerRequest(promptPath, workingDirectory, {
                    kind,
                    resumeThreadId,
                  }),
                ),
                {
                  name: "DeepScanNonRetryableError",
                  message: /changed after this Deep Scan started/i,
                },
              );
              const preflight = await readJson(fixture.preflightMarkerPath);
              assert.equal(
                await realpath(preflight.executablePath),
                fixture.executablePath,
              );
              await assert.rejects(readFile(fixture.markerPath), {
                code: "ENOENT",
              });
            },
          );
        }
      }
    } finally {
      restoreEnv("FAKE_CODEX_REPLACE_AFTER_PREFLIGHT", previousReplace);
    }
  }

  async function withWorkerFixture(
    action: (
      fixture: Fixture,
      promptPath: string,
      workingDirectory: string,
    ) => Promise<void>,
  ) {
    const previousPath = process.env.CODEX_CLI_PATH;
    const previousMarker = process.env.FAKE_CODEX_MARKER;
    try {
      const fixture = await fakeCodexFixture();
      process.env.CODEX_CLI_PATH = fixture.executablePath;
      const workingDirectory = path.join(fixture.root, "artifacts");
      await mkdir(workingDirectory);
      await action(
        fixture,
        path.join(fixture.root, "prompt.md"),
        workingDirectory,
      );
    } finally {
      restoreEnv("CODEX_CLI_PATH", previousPath);
      restoreEnv("FAKE_CODEX_MARKER", previousMarker);
    }
  }
}

function workerRequest(
  promptPath: string,
  workingDirectory: string,
  options: Partial<CodexWorkerRequest> = {},
): CodexWorkerRequest {
  return {
    kind: "discovery",
    promptPath,
    workingDirectory,
    subagents: 0,
    signal: new AbortController().signal,
    ...options,
  };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
