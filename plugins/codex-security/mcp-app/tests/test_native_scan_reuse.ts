import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { build } from "esbuild";

const applicationRoot = path.resolve(import.meta.dirname, "..");
const sdkRoot = path.resolve(applicationRoot, "../../../sdk/typescript");
const pluginRoot =
  process.env.CODEX_SECURITY_TEST_PLUGIN_ROOT ??
  path.join(sdkRoot, "_bundled_plugin");
const bundle = await build({
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  stdin: {
    contents: `
    export { readKnowledgeBaseSnapshot } from ${JSON.stringify(path.join(sdkRoot, "src/knowledge-base.ts"))};
    export { scanInputIdentity, saveScanKnowledge } from ${JSON.stringify(path.join(sdkRoot, "src/scan-inputs.ts"))};
    export { resolveDeepScanConfig } from ${JSON.stringify(path.join(sdkRoot, "src/deep-config.ts"))};`,
    resolveDir: applicationRoot,
  },
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const {
  readKnowledgeBaseSnapshot,
  scanInputIdentity,
  saveScanKnowledge,
  resolveDeepScanConfig,
} = module.exports;

for (const change of [
  "unchanged",
  "equivalent config",
  "knowledge",
  "deep config",
  "added knowledge",
  "missing knowledge",
  "legacy recipe",
]) {
  test(`completed native target reuse after MCP restart: ${change}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-completed-reuse-"));
    const repository = path.join(root, "repository");
    const knowledgePath = path.join(root, "knowledge.md");
    const configPath = path.join(root, "deep.toml");
    const environment = {
      CODEX_SECURITY_SCAN_ROOT: path.join(root, "scans"),
      CODEX_SECURITY_STATE_DIR: path.join(root, "state"),
      CODEX_HOME: path.join(root, "home"),
      CODEX_SECURITY_KNOWLEDGE_BASE:
        change === "added knowledge" ? "" : knowledgePath,
      CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH: configPath,
      // A replacement scan must reach preparation; no model service is used.
      CODEX_CLI_PATH: path.join(root, "missing-codex"),
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
    };
    const owner = "synthetic-reuse-owner";
    const userContext = "  Inspect authentication.  ";
    let client;
    const workbench = (args, input) =>
      JSON.parse(
        execFileSync(
          process.env.PYTHON ?? "python3",
          [path.join(pluginRoot, "scripts/workbench_db.py"), ...args],
          {
            env: { ...process.env, ...environment },
            encoding: "utf8",
            ...(input === undefined ? {} : { input: JSON.stringify(input) }),
          },
        ),
      );
    const connect = async () => {
      const next = new Client({ name: "native-reuse-test", version: "1.0.0" });
      await next.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.join(pluginRoot, "mcp/server.mjs"), "--stdio"],
          cwd: applicationRoot,
          env: { ...process.env, ...environment },
        }),
      );
      return next;
    };
    const call = (name, args) =>
      client.callTool({
        name,
        arguments: args,
        _meta: {
          "openai/threadId": owner,
          "codex/sandbox-state-meta": {
            permissionProfile: {
              type: "managed",
              file_system: {
                type: "restricted",
                entries: [
                  {
                    path: { type: "special", value: { kind: "root" } },
                    access: "read",
                  },
                ],
              },
              network: "restricted",
            },
            sandboxCwd: pathToFileURL(repository).href,
          },
        },
      });
    const successful = (response) => {
      assert.notEqual(response.isError, true, response.content?.[0]?.text);
      return response.structuredContent;
    };
    try {
      await Promise.all([
        mkdir(repository),
        mkdir(environment.CODEX_SECURITY_SCAN_ROOT, { mode: 0o700 }),
        mkdir(environment.CODEX_HOME, { mode: 0o700 }),
      ]);
      await writeFile(path.join(repository, "app.py"), "print('fixture')\n");
      await writeFile(knowledgePath, "Original security guidance.\n");
      await writeFile(configPath, "[deep_scan]\nworkers = 2\nsubagents = 1\n");
      const knowledge = environment.CODEX_SECURITY_KNOWLEDGE_BASE
        ? await readKnowledgeBaseSnapshot([knowledgePath])
        : undefined;
      const deep = (await resolveDeepScanConfig({}, configPath)).settings;
      const begun = workbench([
        "begin-deep-scan",
        "--target-path",
        repository,
        "--thread-id",
        owner,
        "--user-context",
        userContext,
      ]);
      const { scanId, scanDir, handoffClaimToken } = begun.scan;
      const recipe = {
        repository,
        mode: "deep",
        target: { kind: "repository", paths: [] },
        config: {},
        ...(knowledge ? { knowledgeBasePaths: [knowledgePath] } : {}),
        ...(change === "legacy recipe"
          ? {}
          : {
              scanInputs: scanInputIdentity(userContext.trim(), knowledge),
              deepScan: deep,
              deepScanResolved: true,
            }),
      };
      if (knowledge) await saveScanKnowledge(scanDir, knowledge);
      workbench(
        [
          "register-cli-scan",
          "--repository",
          repository,
          "--scan-dir",
          scanDir,
          "--registration-json-stdin",
        ],
        { scanId, threadId: owner, claimToken: handoffClaimToken, recipe },
      );
      workbench([
        "set-scan-thread",
        "--scan-id",
        scanId,
        "--claim-token",
        handoffClaimToken,
        "--thread-id",
        "synthetic-merge",
      ]);
      workbench(
        [
          "save-scan-artifact",
          "--scan-id",
          scanId,
          "--claim-token",
          handoffClaimToken,
          "--artifact-path",
          "artifacts/deep-scan/checkpoint.json",
        ],
        {
          version: 2,
          passes: [],
          mergedScanIds: [],
          aggregate: null,
          terminalReason: "capped",
        },
      );
      client = await connect();
      successful(
        await call("record_codex_security_scan_draft", {
          scanId,
          handoffClaimToken,
          findings: [],
          coverage: {
            completeness: "complete",
            surfaces: [{ label: "Synthetic fixture", disposition: "rejected" }],
            explicitExclusions: [],
            deferred: [],
          },
        }),
      );
      workbench([
        "prepare-scan-completion",
        "--scan-id",
        scanId,
        "--claim-token",
        handoffClaimToken,
      ]);
      // A running, sealed saved scan does not need current semantic inputs.
      await rm(knowledgePath);
      if (change !== "legacy recipe")
        await writeFile(configPath, "invalid TOML [");
      successful(
        await call("start_codex_security_deep_scan", {
          scanId,
          handoffClaimToken,
        }),
      );
      await writeFile(knowledgePath, "Original security guidance.\n");
      await writeFile(configPath, "[deep_scan]\nworkers = 2\nsubagents = 1\n");
      const artifacts = [
        "scan-manifest.json",
        "findings.json",
        "coverage.json",
      ];
      const original = await Promise.all(
        artifacts.map((name) => readFile(path.join(scanDir, name), "utf8")),
      );
      await client.close();
      client = undefined;
      if (change === "equivalent config")
        await writeFile(
          configPath,
          "# Same effective settings\n[deep_scan]\nsubagents = 1\nworkers = 2\n",
        );
      if (change === "knowledge")
        await writeFile(knowledgePath, "Different security guidance.\n");
      if (change === "deep config")
        await writeFile(
          configPath,
          "[deep_scan]\nworkers = 3\nsubagents = 1\n",
        );
      if (change === "added knowledge")
        environment.CODEX_SECURITY_KNOWLEDGE_BASE = knowledgePath;
      if (change === "missing knowledge") await rm(knowledgePath);
      client = await connect();
      // The public explicit identity remains authoritative after the restart.
      assert.equal(
        successful(
          await call("start_codex_security_deep_scan", {
            scanId,
            handoffClaimToken,
          }),
        ).scanId,
        scanId,
      );
      const response = await call("start_codex_security_deep_scan", {
        targetPath: repository,
        userContext,
      });
      if (change === "unchanged" || change === "equivalent config") {
        assert.equal(successful(response).scanId, scanId);
        assert.equal(workbench(["list-scans"]).scans.length, 1);
      } else if (change === "missing knowledge") {
        assert.equal(response.isError, true);
        assert.match(response.content[0].text, /knowledge|ENOENT/i);
        assert.equal(workbench(["list-scans"]).scans.length, 1);
      } else {
        assert.equal(response.isError, true);
        assert.match(response.content[0].text, /Codex executable/i);
        const scans = workbench(["list-scans"]).scans;
        assert.equal(
          scans.length,
          2,
          "changed semantics register a fresh scan before execution",
        );
        assert.ok(scans.some((scan) => scan.scanId !== scanId));
      }
      assert.equal(
        workbench(["get-scan", "--scan-id", scanId]).scan.progress.status,
        "complete",
      );
      assert.deepEqual(
        await Promise.all(
          artifacts.map((name) => readFile(path.join(scanDir, name), "utf8")),
        ),
        original,
      );
    } finally {
      await client?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
