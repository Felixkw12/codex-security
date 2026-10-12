import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { main } from "../src/cli.js";
import {
  mergedCodexConfig,
  resolveCodexProfile,
  type JsonObject,
} from "../src/config.js";
import {
  createProviderProfile,
  privateReplayOverrides,
  restoreProviderProfile,
} from "../src/provider-profile.js";
import { codexSecurityCredentialHome } from "../src/runtime.js";
import { dependencies, capture } from "./cli-fixtures.js";
import { PLUGIN_ROOT } from "./plugin-root.js";
import { TestClient, mockWorkbench } from "./support/api-client.js";
import { preparedRuntime } from "./support/api-events.js";
import { rejecting } from "./support/errors.js";
import { createApiTestFixtures } from "./support/temporary-directories.js";

const { temporaryDirectory, cleanup } = createApiTestFixtures(
  "file-profile-replay-",
);
afterEach(cleanup);

test.each(["rerun", "resume"] as const)(
  "saved registration retains explicit file-profile settings through CLI %s",
  async (command) => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const home = join(root, "home");
    const runtimeHome = join(root, "runtime");
    const scanDir = join(root, "scan");
    for (const path of [repository, home, runtimeHome, scanDir])
      await mkdir(path, { mode: 0o700 });
    const profilePath = join(home, "review.config.toml");
    const fileProfile = (version: string) => ({
      model: "gpt-5.6-sol",
      analytics: { enabled: true },
      shell_environment_policy: {
        inherit: "all",
        exclude: ["FILE_SETTING"],
        set: { INHERITED: version },
      },
      otel: { exporter: "console", environment: version },
      agents: {
        reviewer: { config_file: "file-reviewer.toml", description: version },
      },
      skills: { config: [{ path: "file-skill", enabled: true }] },
      model_instructions_file: "file-instructions.md",
      model_catalog_json: "file-catalog.json",
      features: { view_image: true },
    });
    await writeFile(profilePath, stringify(fileProfile("first")));
    const explicit: JsonObject = {
      profile: "review",
      analytics: { enabled: false },
      shell_environment_policy: {
        inherit: "none",
        exclude: [],
        set: { EXPLICIT: "kept" },
      },
      otel: { exporter: "none" },
      agents: { reviewer: { config_file: "caller-reviewer.toml" } },
      skills: { config: [{ path: "caller-skill", enabled: false }] },
      model_instructions_file: null,
      model_catalog_json: "../caller-catalog.json",
      features: { view_image: false, shell_tool: false },
    };
    const environment = {
      CODEX_HOME: home,
      CODEX_SECURITY_STATE_DIR: join(root, "state"),
    };
    let recipe: JsonObject | undefined;
    const client = new TestClient(
      { pluginPath: PLUGIN_ROOT, codexOverrides: explicit },
      {
        environment,
        resolvePluginPython: async () => "/managed/python",
        prepareRuntime: async () => preparedRuntime(runtimeHome),
        prepareOutputDir: async () => scanDir,
        repositoryRevision: async () => "deadbeef",
        runWorkbench: async (_runtime, args, input) => {
          if (args[0] === "register-cli-scan")
            recipe = JSON.parse(input!).recipe;
          return mockWorkbench(args, input);
        },
        createCodex: async () => ({
          startThread: () => ({
            id: null,
            runStreamed: rejecting("synthetic stop after registration"),
          }),
        }),
      },
    );
    try {
      await expect(client.run(repository, { mode: "deep" })).rejects.toThrow(
        "synthetic stop after registration",
      );
      expect(recipe).toBeDefined();
      await writeFile(profilePath, stringify(fileProfile("reloaded")));
      let replay: JsonObject | undefined;
      const out = capture(),
        err = capture();
      const status = await main(
        ["scans", command, "saved", "--json"],
        out.stream,
        err.stream,
        dependencies({
          currentDirectory: repository,
          environment,
          onWorkbench: () => ({ scanId: "saved", scanDir, recipe: recipe! }),
          onConfig: (config) => {
            replay = config.codexOverrides;
          },
        }),
      );
      expect(status, out.text() + err.text()).toBe(0);
      const restored = resolveCodexProfile(
        await mergedCodexConfig({ codexOverrides: replay }, home),
      );
      expect(restored).toMatchObject({
        analytics: { enabled: false },
        shell_environment_policy: {
          inherit: "none",
          exclude: [],
          set: { INHERITED: "reloaded", EXPLICIT: "kept" },
        },
        otel: { exporter: "none", environment: "reloaded" },
        agents: {
          reviewer: {
            config_file: join(scanDir, "caller-reviewer.toml"),
            description: "reloaded",
          },
        },
        skills: {
          config: [{ path: join(scanDir, "caller-skill"), enabled: false }],
        },
        model_catalog_json: resolve(scanDir, "../caller-catalog.json"),
        features: { view_image: false, shell_tool: false },
      });
      expect(restored).not.toHaveProperty("model_instructions_file");
      const workerResult = execFileSync(
        Bun.which("node")!,
        [
          fileURLToPath(
            new URL("./support/replay-worker-boundary.ts", import.meta.url),
          ),
          root,
        ],
        { input: JSON.stringify(restored), encoding: "utf8" },
      );
      expect(JSON.parse(workerResult)).toEqual({ launches: 4 });
      const profile = recipe!["providerProfile"] as JsonObject;
      const privatePath = join(
        codexSecurityCredentialHome(environment),
        `${profile["name"]}.config.json`,
      );
      const saved = JSON.parse(await readFile(privatePath, "utf8"));
      expect(saved).not.toHaveProperty("model_catalog_json");
      expect(saved).not.toHaveProperty("features.shell_tool");
      expect(saved).toHaveProperty("model_instructions_file", null);
      expect(saved).not.toHaveProperty(
        "shell_environment_policy.set.INHERITED",
      );
      if (process.platform !== "win32")
        expect((await stat(privatePath)).mode & 0o777).toBe(0o600);
      expect(explicit["model_catalog_json"]).toBe("../caller-catalog.json");
    } finally {
      await client.close();
    }
  },
);

test("private replay preserves explicit clears over projected defaults and empty provider semantics", async () => {
  const home = await temporaryDirectory();
  const recipe: JsonObject = {
    model_provider: "openai",
    model_catalog_json: join(home, "original-catalog.json"),
    features: { shell_tool: true },
  };
  const providerCases: (JsonObject | null)[] = [
    null,
    {},
    { synthetic: { auth: null, http_headers: {} } },
  ];
  for (const providers of providerCases) {
    const overrides: JsonObject = {
      model_provider: null,
      model_catalog_json: "raw-relative-catalog.json",
      features: { shell_tool: null },
      shell_environment_policy: { exclude: [] },
      model_providers: providers,
    };
    const saved = await createProviderProfile(
      home,
      privateReplayOverrides(overrides, recipe),
      { replay: true },
    );
    try {
      const restored = await restoreProviderProfile(
        recipe,
        { name: saved.name, home: "ambient" },
        { CODEX_HOME: home },
      );
      expect(restored).toMatchObject({
        model_provider: null,
        model_catalog_json: recipe["model_catalog_json"],
        features: { shell_tool: null },
        shell_environment_policy: { exclude: [] },
      });
      if (providers === null || Object.keys(providers).length > 0)
        expect(restored["model_providers"]).toEqual(providers);
      else expect(restored).not.toHaveProperty("model_providers");
    } finally {
      await saved.cleanup();
    }
    await expect(readFile(saved.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});
