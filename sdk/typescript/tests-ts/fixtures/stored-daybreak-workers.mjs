import childProcess from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mock } from "bun:test";
import { createInterface } from "node:readline";
import { parse as parseToml } from "smol-toml";

const spawn = childProcess.spawn;
let workerArgs;
let workerProcess;
let workerEnvironment;
let workerConfig;
// Capture the actual native launch, including the temporary per-scan home config.
const recordedSpawn = (command, args, options) => {
  if (args[0] === "exec") {
    workerArgs = args;
    workerEnvironment = { ...options.env };
    workerConfig = parseToml(
      readFileSync(join(workerEnvironment.CODEX_HOME, "config.toml"), "utf8"),
    );
  }
  const child = spawn(command, args, options);
  if (args[0] === "exec") workerProcess = child;
  return child;
};
for (const name of ["node:child_process", "child_process"])
  mock.module(name, () => ({ ...childProcess, spawn: recordedSpawn }));
const {
  createExecutionCodex,
  lockExecutionConfiguration,
  nativeScanConfiguration,
  prepareDiscoveryExecution,
  prepareExecutionSource,
  prepareMergeExecution,
} = await import("../../src/execution-preparation.ts");
const { scanRuntimeCodexConfig } = await import("../../src/api.ts");
const { preparedRuntime } = await import("../support/api-events.ts");
const { VERSION } = await import("../../src/version.ts");
const { readCodexRuntimeConfigWithOrigins } =
  await import("../../../../plugins/codex-security/scripts/codex_profile.mjs");
const requests = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/responses")
      return Response.json({});
    if (request.method !== "POST") return new Response(null, { status: 426 });
    requests.push(await request.json());
    return new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"synthetic-response","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
process.env.OPENAI_BASE_URL = `${server.url}v1`;
let session;
process.stdout.write(
  JSON.stringify({ baseUrl: process.env.OPENAI_BASE_URL }) + "\n",
);
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    const requestCount = requests.length;
    workerArgs = undefined;
    workerProcess = undefined;
    if (session === undefined) {
      const configuration = await nativeScanConfiguration(
        process.env,
        { model: "gpt-test" },
        0,
      );
      const source = prepareExecutionSource({
        command: { command: process.env.CODEX_CLI_PATH },
        configuration,
        environment: process.env,
        auth: "api-key",
      });
      const home = process.env.CODEX_HOME;
      /** @type {import("../../src/execution-preparation.ts").PreparedExecution} */
      const prepared = {
        policy: "ordinary",
        source,
        runtime: preparedRuntime(home),
        runtimeHome: home,
        effectiveConfig: configuration,
        preflightConfig: {},
        sessionConfig: scanRuntimeCodexConfig(configuration, home),
        runtimeConfig: {},
        authentication: source.authentication,
        approvalPolicy: "never",
        python: process.execPath,
        releaseCredentialHome: null,
      };
      session = prepared;
    }
    const worker =
      request.kind === "discovery"
        ? prepareDiscoveryExecution(session)
        : prepareMergeExecution(session, 0);
    const { codex } = await createExecutionCodex(
      { surface: "sdk", command: "scan", mode: "deep" },
      worker,
      {},
    );
    const threadOptions = {
      model: "gpt-test",
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
    };
    const thread = request.resumeThreadId
      ? codex.resumeThread(request.resumeThreadId, threadOptions)
      : codex.startThread(threadOptions);
    const { events } = await thread.runStreamed(
      await readFile(process.argv[2], "utf8"),
      {
        signal: new AbortController().signal,
      },
    );
    for await (const event of events) {
      if (event.type === "turn.failed") throw new Error(event.error.message);
    }
    if (!workerArgs)
      throw new Error("Native worker arguments were not captured");
    if (requests.length === requestCount)
      throw new Error("Worker completed without a synthetic Responses request");
    // Turn completion can precede exec's exit. Release its SQLite handles before
    // this fixture starts a separate app-server against the same Codex home.
    if (workerProcess.exitCode === null && workerProcess.signalCode === null)
      await once(workerProcess, "exit");
    const signal = new AbortController().signal;
    const release = await lockExecutionConfiguration(
      workerEnvironment.CODEX_HOME,
      workerConfig,
      signal,
    );
    let config;
    try {
      ({ config } = await readCodexRuntimeConfigWithOrigins({
        clientVersion: VERSION,
        codexPath: process.env.CODEX_CLI_PATH,
        cwd: process.cwd(),
        configOverrides: workerArgs.flatMap((arg, index) =>
          arg === "--config" || arg === "-c" ? [workerArgs[index + 1]] : [],
        ),
        env: workerEnvironment,
        signal,
      }));
    } finally {
      await release();
    }
    process.stdout.write(
      JSON.stringify({
        threadId: thread.id,
        resumed: workerArgs.includes("resume"),
        program: requests.at(-1)?.access_programs?.cyber,
        daybreak: config.daybreak ?? null,
        daybreakFeatures: Object.fromEntries(
          [
            "cli_daybreak",
            "api_key_cyber_access_programs",
            "api_key_model_discovery",
          ].map((key) => [key, config.features?.[key] ?? null]),
        ),
      }) + "\n",
    );
  }
} finally {
  server.stop(true);
}
