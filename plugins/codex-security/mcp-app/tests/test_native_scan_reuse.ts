import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    export { resolveDeepScanConfig } from ${JSON.stringify(path.join(sdkRoot, "src/deep-config.ts"))};
    export { nativeScanConfiguration } from ${JSON.stringify(path.join(sdkRoot, "src/execution-preparation.ts"))};
    export { mergedCodexConfig, scanModelConfiguration } from ${JSON.stringify(path.join(sdkRoot, "src/config.ts"))};`,
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
  nativeScanConfiguration,
  mergedCodexConfig,
  scanModelConfiguration,
} = module.exports;

for (const change of [
  "unchanged",
  "equivalent config",
  "knowledge",
  "deep config",
  "added knowledge",
  "missing knowledge",
  "legacy recipe",
  "selected model",
  "selected effort",
  "unchanged selected profile",
  "equivalent selected profile",
  "turn metadata precedence",
  "unchanged developer instructions",
  "changed developer instructions",
  "removed developer instructions",
  "equivalent developer instructions",
  "unchanged model instructions file",
  "content changed model instructions file",
  "unchanged home model instructions file",
  "content changed home model instructions file",
  "unchanged relative model instructions file",
  "content changed relative model instructions file",
  "legacy model instructions file",
  "empty model instructions file",
  "missing model instructions file",
  "changed model instructions file",
  "removed model instructions file",
  "empty knowledge environment",
  "whitespace knowledge environment",
  "plain knowledge environment",
  "padded knowledge environment",
]) {
  test(`completed native target reuse after MCP restart: ${change}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-completed-reuse-"));
    const repository = path.join(root, "repository");
    const knowledgeEnvironment = change.endsWith("knowledge environment");
    const knowledgePath = path.join(
      root,
      knowledgeEnvironment ? "knowledge guidance.md" : "knowledge.md",
    );
    const configPath = path.join(root, "deep.toml");
    const selectedConfigPath = path.join(root, "selected.toml");
    const modelInstructionsPath = path.join(root, "model-instructions-a.md");
    const otherModelInstructionsPath = path.join(
      root,
      "model-instructions-b.md",
    );
    const selectedProfile =
      change.endsWith("selected profile") ||
      change === "turn metadata precedence";
    const developerInstructions = change.endsWith("developer instructions");
    const modelInstructionsFile = change.endsWith("model instructions file");
    const selectedConfig =
      developerInstructions ||
      modelInstructionsFile ||
      selectedProfile ||
      change === "selected model" ||
      change === "selected effort";
    let instructionFileReference = modelInstructionsPath;
    let initialSelectedConfig = modelInstructionsFile
      ? `model = "synthetic-model-a"\nmodel_reasoning_effort = "synthetic-effort-a"\ndeveloper_instructions = "Follow synthetic guidance A."\nmodel_instructions_file = ${JSON.stringify(modelInstructionsPath)}\n`
      : developerInstructions
        ? 'model = "synthetic-model-a"\nmodel_reasoning_effort = "synthetic-effort-a"\ndeveloper_instructions = "Follow synthetic guidance A."\n'
        : selectedProfile
          ? 'model = "synthetic-unused-root-model"\nmodel_reasoning_effort = "synthetic-unused-root-effort"\nprofile = "scan"\n[profiles.scan]\nmodel = "synthetic-model-a"\nmodel_reasoning_effort = "synthetic-effort-a"\n'
          : 'model = "synthetic-model-a"\nmodel_reasoning_effort = "synthetic-effort-a"\n';
    const turnSettings =
      change === "turn metadata precedence"
        ? {
            model: "synthetic-turn-model",
            reasoningEffort: "synthetic-turn-effort",
          }
        : {};
    const environment = {
      HOME: root,
      USERPROFILE: root,
      CODEX_SECURITY_SCAN_ROOT: path.join(root, "scans"),
      CODEX_SECURITY_STATE_DIR: path.join(root, "state"),
      CODEX_HOME: path.join(root, "home"),
      CODEX_SECURITY_KNOWLEDGE_BASE:
        change === "added knowledge" ||
        change === "empty knowledge environment" ||
        change === "whitespace knowledge environment"
          ? ""
          : knowledgePath,
      CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH: configPath,
      CODEX_SECURITY_CONFIG_PATH: selectedConfig ? selectedConfigPath : "",
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
          ...(turnSettings.model
            ? {
                "x-codex-turn-metadata": {
                  model: turnSettings.model,
                  reasoning_effort: turnSettings.reasoningEffort,
                },
              }
            : {}),
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
      if (modelInstructionsFile) {
        await writeFile(
          modelInstructionsPath,
          change === "empty model instructions file"
            ? ""
            : "Synthetic model instructions A.\n",
        );
        await writeFile(
          otherModelInstructionsPath,
          "Synthetic model instructions B.\n",
        );
      }
      await writeFile(configPath, "[deep_scan]\nworkers = 2\nsubagents = 1\n");
      if (selectedConfig)
        await writeFile(selectedConfigPath, initialSelectedConfig);
      const knowledge = environment.CODEX_SECURITY_KNOWLEDGE_BASE
        ? await readKnowledgeBaseSnapshot([knowledgePath])
        : undefined;
      const deep = (await resolveDeepScanConfig({}, configPath)).settings;
      const savedConfig = await mergedCodexConfig({
        codexOverrides: await nativeScanConfiguration(
          { ...process.env, ...environment },
          turnSettings,
          deep.subagents,
        ),
      });
      if (modelInstructionsFile) {
        assert.equal(
          savedConfig.model_instructions_file,
          modelInstructionsPath,
        );
        assert.equal(
          savedConfig.developer_instructions,
          "Follow synthetic guidance A.",
        );
      }
      if (selectedConfig)
        assert.deepEqual(scanModelConfiguration(savedConfig), {
          model: turnSettings.model ?? "synthetic-model-a",
          reasoningEffort: turnSettings.reasoningEffort ?? "synthetic-effort-a",
        });
      const begun = workbench([
        "begin-deep-scan",
        "--target-path",
        repository,
        "--thread-id",
        owner,
        "--user-context",
        userContext,
        ...(turnSettings.model
          ? [
              "--model",
              turnSettings.model,
              "--reasoning-effort",
              turnSettings.reasoningEffort,
            ]
          : []),
      ]);
      const { scanId, scanDir, handoffClaimToken } = begun.scan;
      if (
        change.includes(" home model instructions file") ||
        change.includes(" relative model instructions file")
      ) {
        instructionFileReference = change.includes(" home ")
          ? "~/model-instructions-a.md"
          : path.relative(scanDir, modelInstructionsPath);
        initialSelectedConfig = initialSelectedConfig.replace(
          JSON.stringify(modelInstructionsPath),
          JSON.stringify(instructionFileReference),
        );
        await writeFile(selectedConfigPath, initialSelectedConfig);
        savedConfig.model_instructions_file = instructionFileReference;
      }
      const recipe = {
        repository,
        mode: "deep",
        target: { kind: "repository", paths: [] },
        config: savedConfig,
        ...(knowledge ? { knowledgeBasePaths: [knowledgePath] } : {}),
        ...(change === "legacy recipe"
          ? {}
          : {
              scanInputs: {
                ...scanInputIdentity(userContext.trim(), knowledge),
                ...(modelInstructionsFile &&
                change !== "legacy model instructions file"
                  ? {
                      modelInstructionsFileSha256: createHash("sha256")
                        .update(await readFile(modelInstructionsPath))
                        .digest("hex"),
                    }
                  : {}),
              },
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
      if (modelInstructionsFile) {
        assert.equal(
          workbench(["get-scan-recipe", "--scan-id", scanId]).recipe.config
            .model_instructions_file,
          instructionFileReference,
        );
      }
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
      const originalInstructionBytes = modelInstructionsFile
        ? await readFile(modelInstructionsPath)
        : undefined;
      if (modelInstructionsFile) await rm(modelInstructionsPath);
      await rm(knowledgePath);
      if (change !== "legacy recipe")
        await writeFile(configPath, "invalid TOML [");
      if (selectedConfig) await writeFile(selectedConfigPath, "invalid TOML [");
      successful(
        await call("start_codex_security_deep_scan", {
          scanId,
          handoffClaimToken,
        }),
      );
      if (originalInstructionBytes !== undefined)
        await writeFile(modelInstructionsPath, originalInstructionBytes);
      await writeFile(knowledgePath, "Original security guidance.\n");
      await writeFile(configPath, "[deep_scan]\nworkers = 2\nsubagents = 1\n");
      if (selectedConfig)
        await writeFile(selectedConfigPath, initialSelectedConfig);
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
      if (change === "whitespace knowledge environment")
        environment.CODEX_SECURITY_KNOWLEDGE_BASE = "   ";
      if (change === "padded knowledge environment")
        environment.CODEX_SECURITY_KNOWLEDGE_BASE = `  ${knowledgePath}  `;
      if (change === "selected model")
        await writeFile(
          selectedConfigPath,
          'model = "synthetic-model-b"\nmodel_reasoning_effort = "synthetic-effort-a"\n',
        );
      if (change === "selected effort")
        await writeFile(
          selectedConfigPath,
          'model = "synthetic-model-a"\nmodel_reasoning_effort = "synthetic-effort-b"\n',
        );
      if (change === "equivalent selected profile")
        await writeFile(
          selectedConfigPath,
          '# Same effective profile; reordered keys and an inactive root value change.\nprofile = "scan"\nmodel_reasoning_effort = "different-unused-effort"\nmodel = "different-unused-model"\n[profiles.scan]\nmodel_reasoning_effort = "synthetic-effort-a"\nmodel = "synthetic-model-a"\n',
        );
      if (change === "turn metadata precedence")
        await writeFile(
          selectedConfigPath,
          'profile = "scan"\n[profiles.scan]\nmodel = "synthetic-model-b"\nmodel_reasoning_effort = "synthetic-effort-b"\n',
        );
      if (change === "changed developer instructions")
        await writeFile(
          selectedConfigPath,
          initialSelectedConfig.replace("guidance A.", "guidance B."),
        );
      if (change === "removed developer instructions")
        await writeFile(
          selectedConfigPath,
          'model = "synthetic-model-a"\nmodel_reasoning_effort = "synthetic-effort-a"\n',
        );
      if (change === "equivalent developer instructions")
        await writeFile(
          selectedConfigPath,
          'profile = "scan"\ndeveloper_instructions = "Inactive root guidance."\n[profiles.scan]\nmodel = "synthetic-model-a"\nmodel_reasoning_effort = "synthetic-effort-a"\ndeveloper_instructions = "Follow synthetic guidance A."\n',
        );
      if (change.startsWith("content changed") && modelInstructionsFile)
        await writeFile(
          modelInstructionsPath,
          "Changed same-path synthetic model instructions.\n",
        );
      if (change === "changed model instructions file")
        await writeFile(
          selectedConfigPath,
          initialSelectedConfig.replace(
            JSON.stringify(modelInstructionsPath),
            JSON.stringify(otherModelInstructionsPath),
          ),
        );
      if (change === "removed model instructions file")
        await writeFile(
          selectedConfigPath,
          initialSelectedConfig.replace(
            `model_instructions_file = ${JSON.stringify(modelInstructionsPath)}\n`,
            "",
          ),
        );
      if (change === "missing model instructions file")
        await rm(modelInstructionsPath);
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
      if (
        knowledgeEnvironment ||
        [
          "unchanged",
          "equivalent config",
          "unchanged selected profile",
          "equivalent selected profile",
          "turn metadata precedence",
          "unchanged developer instructions",
          "equivalent developer instructions",
          "unchanged model instructions file",
          "unchanged home model instructions file",
          "unchanged relative model instructions file",
          "empty model instructions file",
        ].includes(change)
      ) {
        assert.equal(successful(response).scanId, scanId);
        assert.equal(workbench(["list-scans"]).scans.length, 1);
      } else if (
        change === "missing knowledge" ||
        change === "missing model instructions file"
      ) {
        assert.equal(response.isError, true);
        assert.match(response.content[0].text, /knowledge|ENOENT/i);
        assert.equal(workbench(["list-scans"]).scans.length, 1);
      } else {
        if (modelInstructionsFile) {
          assert.notEqual(
            response.structuredContent?.scanId,
            scanId,
            `changed model instructions must not reuse the completed scan (${workbench(["list-scans"]).scans.length} persisted scans)`,
          );
        }
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
      if (knowledgeEnvironment) {
        const freshRepository = path.join(root, "fresh-repository");
        await mkdir(freshRepository);
        await writeFile(
          path.join(freshRepository, "app.py"),
          "print('fresh')\n",
        );
        const freshResponse = await call("start_codex_security_deep_scan", {
          targetPath: freshRepository,
          userContext,
        });
        assert.equal(freshResponse.isError, true);
        assert.match(freshResponse.content[0].text, /Codex executable/i);
        assert.equal(
          workbench(["list-scans"]).scans.length,
          2,
          "normalized knowledge inputs allow a recipe-less fresh start",
        );
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
