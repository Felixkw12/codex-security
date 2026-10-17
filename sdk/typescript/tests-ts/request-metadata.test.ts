import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { afterEach, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { codexSecurityRequestContext } from "../src/request-metadata.js";
import { VERSION } from "../src/version.js";
import { executablePathForSpawn, resolveCodexCommand } from "../src/runtime.js";
import { createApiTestFixtures } from "./support/temporary-directories.js";

const { temporaryDirectory, cleanup } = createApiTestFixtures(
  "codex-security-request-metadata-",
);
afterEach(cleanup);

test.each([
  [undefined, "openai"],
  ["openai", "openai"],
  ["amazon-bedrock", "amazon-bedrock"],
  ["openrouter", "openrouter"],
  ["fireworks", "fireworks"],
  ["ollama", "ollama"],
  ["lmstudio", "lmstudio"],
  ["synthetic.private-provider", "custom"],
] as const)("attributes provider %p as %s", (provider, expected) => {
  const context = codexSecurityRequestContext(
    provider === undefined ? {} : { model_provider: provider },
    { surface: "sdk", command: "scan" },
  );
  expect(context.metadata["codex_security_provider"]).toBe(expected);
});

test("selected profile metadata and provider win without changing telemetry settings", () => {
  const config = {
    model_provider: "openai",
    analytics: { enabled: true },
    otel: { exporter: "none" },
    responses_api_metadata: { "root.tag": "retained", "team.tag": "root" },
    profile: "selected.profile",
    profiles: {
      "selected.profile": {
        model_provider: "amazon-bedrock",
        analytics: { enabled: false },
        otel: {
          exporter: { "otlp-http": { endpoint: "http://localhost:4318" } },
        },
        responses_api_metadata: {
          "team.tag": "selected",
          codex_security_integration: "github_action",
          codex_security_surface: "spoofed",
          codex_security_command: "spoofed",
          codex_security_package_version: "spoofed",
          codex_security_plugin_version: "spoofed",
          codex_security_provider: "spoofed",
          codex_security_scan_mode: "spoofed",
        },
      },
      unused: { model_provider: "ollama" },
    },
  };
  const original = structuredClone(config);
  const context = codexSecurityRequestContext(config, {
    surface: "cli",
    command: "scan",
    pluginVersion: "1.2.3",
    mode: "deep",
  });
  expect(context.metadata).toEqual({
    "root.tag": "retained",
    "team.tag": "selected",
    codex_security_integration: "github_action",
    codex_security_surface: "cli",
    codex_security_command: "scan",
    codex_security_package_version: VERSION,
    codex_security_plugin_version: "1.2.3",
    codex_security_provider: "amazon-bedrock",
    codex_security_scan_mode: "deep",
  });
  expect(parse(context.configOverride)).toEqual({
    responses_api_metadata: context.metadata,
  });
  expect(config).toEqual(original);
});

test("leaves provider attribution to native configuration when unresolved", () => {
  const context = codexSecurityRequestContext(
    {},
    { surface: "cli", command: "patch", providerResolved: false },
  );
  expect(context.metadata).not.toHaveProperty("codex_security_provider");
  const inherited = codexSecurityRequestContext(
    { responses_api_metadata: { codex_security_provider: "amazon-bedrock" } },
    { surface: "cli", command: "patch", providerResolved: false },
  );
  expect(inherited.metadata["codex_security_provider"]).toBe("amazon-bedrock");
});

test("contexts are immutable independent snapshots of caller metadata", () => {
  const config = {
    analytics: { enabled: false },
    responses_api_metadata: { "team.tag": "first" },
  };
  const first = codexSecurityRequestContext(config, {
    surface: "cli",
    command: "scan",
    mode: "standard",
  });
  config.responses_api_metadata["team.tag"] = "second";
  const second = codexSecurityRequestContext(config, {
    surface: "sdk",
    command: "validate",
  });
  expect(first.metadata["team.tag"]).toBe("first");
  expect(second.metadata["team.tag"]).toBe("second");
  expect(first.metadata["codex_security_scan_mode"]).toBe("standard");
  expect(second.metadata).not.toHaveProperty("codex_security_scan_mode");
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.metadata)).toBe(true);
  expect(Reflect.set(first.metadata, "team.tag", "changed")).toBe(false);
  expect(config.analytics.enabled).toBe(false);
});

test("the SDK passes literal metadata keys as one native config table", async () => {
  const home = await temporaryDirectory();
  const script = join(home, "capture native arguments.mjs");
  await writeFile(
    script,
    `for await (const chunk of process.stdin) {}
console.log(JSON.stringify({ type: "thread.started", thread_id: "synthetic-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: {
  type: "agent_message", id: "answer", text: JSON.stringify(process.argv.slice(1)),
} }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);`,
  );
  const context = codexSecurityRequestContext(
    {
      responses_api_metadata: {
        "team.tag": "synthetic-team",
        codex_security_integration: "github_action",
      },
    },
    { surface: "cli", command: "scan", mode: "deep" },
  );
  const node = Bun.which("node");
  expect(node).not.toBeNull();
  const codex = new Codex({
    codexPathOverride: node!,
    env: {
      ...process.env,
      CODEX_HOME: home,
      NODE_OPTIONS: `--import=${pathToFileURL(script).href}`,
    },
    config: { analytics: { enabled: false }, otel: { exporter: "none" } },
    configOverrides: [context.configOverride],
  });
  const turn = await codex
    .startThread({ workingDirectory: home, skipGitRepoCheck: true })
    .run("synthetic request");
  const args = JSON.parse(turn.finalResponse) as string[];
  const overrides = args.flatMap((value, index) =>
    value === "--config" ? [args[index + 1]!] : [],
  );
  expect(
    overrides.filter((value) => value.startsWith("responses_api_metadata")),
  ).toEqual([context.configOverride]);
  expect(parse(context.configOverride)["responses_api_metadata"]).toEqual(
    context.metadata,
  );
  expect(overrides).toContain("analytics.enabled=false");
  expect(overrides).toContain('otel.exporter="none"');
});

test("native table overrides preserve inherited literal metadata and opt-outs", async () => {
  const home = await temporaryDirectory();
  await writeFile(
    join(home, "config.toml"),
    '[analytics]\nenabled=false\n[responses_api_metadata]\n"home.tag"="preserved"\ncodex_security_integration="github_action"\n',
  );
  const context = codexSecurityRequestContext(
    { responses_api_metadata: { "caller.tag": "synthetic" } },
    { surface: "cli", command: "publish", providerResolved: false },
  );
  const child = spawn(
    executablePathForSpawn(resolveCodexCommand({}).command),
    ["-c", context.configOverride, "app-server", "--stdio"],
    {
      cwd: home,
      env: {
        PATH: process.env["PATH"],
        SystemRoot: process.env["SystemRoot"],
        CODEX_HOME: home,
      },
      windowsHide: true,
    },
  );
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  try {
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "synthetic_metadata_test", version: "1" } } })}\n`,
    );
    let inspected = false;
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.error) throw new Error(JSON.stringify(message.error));
      if (message.id === 1)
        child.stdin.write(
          `${JSON.stringify({ id: 2, method: "config/read", params: { cwd: home } })}\n`,
        );
      if (message.id === 2) {
        expect(message.result.config.responses_api_metadata).toEqual({
          "home.tag": "preserved",
          codex_security_integration: "github_action",
          ...context.metadata,
        });
        expect(message.result.config.analytics).toEqual({ enabled: false });
        inspected = true;
        break;
      }
    }
    expect(inspected, diagnostic).toBe(true);
  } finally {
    lines.close();
    child.kill();
    await closed;
  }
});
