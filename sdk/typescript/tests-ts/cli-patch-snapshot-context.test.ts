import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCodexSkillCommand, runRepositoryCommand } from "../src/cli.js";
import { resolveCodexCommand } from "../src/runtime.js";
import { repositoryGit, runWorkflow } from "./cli-patch-fixtures.js";
import { createTemporaryDirectories } from "./support/temporary-directories.js";

const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);
const windows =
  process.platform === "win32" ? 'windows = { sandbox = "unelevated" }\n' : "";
const provider =
  'model_provider = "synthetic"\n[model_providers.synthetic]\nname = "Synthetic"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n';

test.each([
  "stored credentials",
  "provider override",
  "Git exclusions",
] as const)(
  "snapshots inherit the prepared native context: %s",
  async (mode) => {
    const root = await fixtures.create("patch-snapshot-context-");
    const repository = join(root, "repository"),
      home = join(root, "home"),
      state = join(root, "state"),
      prepared = join(state, "codex-home");
    await Promise.all([mkdir(repository), mkdir(home)]);
    const global = join(root, "empty-gitconfig");
    await writeFile(global, "");
    const environment = {
      PATH: process.env["PATH"],
      ...(process.env["SystemRoot"] === undefined
        ? {}
        : { SystemRoot: process.env["SystemRoot"] }),
      CODEX_HOME:
        mode === "stored credentials" ? join(root, "absent-home") : home,
      CODEX_SECURITY_STATE_DIR: state,
      GIT_CONFIG_GLOBAL: global,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = repositoryGit(repository);
    git("init", "--initial-branch=main");
    git("config", "user.name", "Synthetic User");
    git("config", "user.email", "synthetic@example.test");
    const source = join(repository, "app.ts");
    await writeFile(source, "before\n");
    git("add", ".");
    git("commit", "-m", "Synthetic baseline");
    const index = await readFile(join(repository, ".git", "index"));
    if (mode === "stored credentials") {
      await mkdir(prepared, { recursive: true });
      await writeFile(
        join(prepared, "auth.json"),
        '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-synthetic-local-only"}\n',
        { mode: 0o600 },
      );
      await writeFile(join(prepared, "config.toml"), windows);
    } else
      await writeFile(
        join(home, "config.toml"),
        windows +
          (mode === "provider override"
            ? 'model_provider = "synthetic"\n'
            : provider +
              '[shell_environment_policy]\ninherit = "all"\nexclude = ["GIT_*"]\n'),
      );
    // Use real native configuration and preflight; substitute only the model turn.
    const proxy = join(root, "native-turn.cjs"),
      record = join(root, "runtime.json");
    await writeFile(
      proxy,
      `const fs=require("node:fs"),{spawn}=require("node:child_process"),{createInterface}=require("node:readline");
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({home:process.env.CODEX_HOME}));
const child=spawn(process.argv[2],process.argv.slice(3),{stdio:["pipe","pipe","inherit"]});
let thread;
createInterface({input:child.stdout}).on("line",line=>{const reply=JSON.parse(line);if(reply.id===2)thread=reply.result?.thread.id;process.stdout.write(line+"\\n");});
const send=reply=>process.stdout.write(JSON.stringify(reply)+"\\n");
createInterface({input:process.stdin}).on("line",line=>{const request=JSON.parse(line);if(request.method!=="turn/start"){child.stdin.write(line+"\\n");return;}
fs.writeFileSync(${JSON.stringify(source)},"after\\n");
send({id:request.id,result:{turn:{id:"synthetic-turn"}}});
send({method:"item/completed",params:{threadId:thread,turnId:"synthetic-turn",item:{type:"agentMessage",text:"Synthetic patch complete"}}});
send({method:"turn/completed",params:{threadId:thread,turn:{id:"synthetic-turn",status:"completed"}}});
}).on("close",()=>child.stdin.end());child.on("exit",code=>process.exitCode=code??1);
`,
    );
    const homes = new Set<string>();
    const result = await runWorkflow(
      [
        "patch",
        "Synthetic issue",
        ...(mode === "stored credentials" ? ["--auth", "chatgpt"] : []),
        ...(mode === "provider override"
          ? [
              "--codex",
              'model_providers.synthetic={name="Synthetic",base_url="http://127.0.0.1:9/v1",wire_api="responses"}',
              "--codex",
              "analytics.enabled=false",
            ]
          : []),
        "--json",
      ],
      {
        currentDirectory: repository,
        environment,
        onCodex: (args, output, selected) =>
          runCodexSkillCommand(
            [proxy, resolveCodexCommand(selected).command, ...args],
            output,
            { command: process.execPath },
            selected,
          ),
        onRepositoryCommand: (command, args, cwd, options) => {
          if (options?.sandbox !== undefined) {
            homes.add(options.sandbox.environment["CODEX_HOME"]!);
            if (mode === "provider override") {
              expect(
                options.sandbox.configuration?.["model_providers"],
              ).toHaveProperty("synthetic");
              expect(options.sandbox.configuration?.["analytics"]).toEqual({
                enabled: false,
              });
            }
          }
          return runRepositoryCommand(command, args, cwd, {
            ...options,
            environment: { ...environment, ...options?.environment },
          });
        },
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual(["app.ts"]);
    expect(homes).toEqual(
      new Set([mode === "stored credentials" ? prepared : home]),
    );
    expect(JSON.parse(await readFile(record, "utf8")).home).toBe([...homes][0]);
    expect(await readFile(join(repository, ".git", "index"))).toEqual(index);
  },
  30_000,
);

test("snapshot binding frames retain raw stdin and unset semantics while native environment filters remain active", async () => {
  const root = await fixtures.create("patch-snapshot-bindings-");
  const repository = join(root, "repository"),
    home = join(root, "home");
  await Promise.all([mkdir(repository), mkdir(home)]);
  repositoryGit(repository)("init", "--initial-branch=main");
  await writeFile(
    join(home, "config.toml"),
    windows +
      '[shell_environment_policy]\ninherit="all"\nexclude=["GIT_*","SNAPSHOT_USER_FILTERED"]\n[shell_environment_policy.set]\nGIT_DIR="incorrect-repository"\nSNAPSHOT_USER_SET="preserved"\n',
  );
  const script = join(root, "inspect.cjs");
  await writeFile(
    script,
    `const fs=require("node:fs");
process.stdout.write(JSON.stringify({index:process.env.GIT_INDEX_FILE,dir:process.env.GIT_DIR??null,filtered:process.env.SNAPSHOT_USER_FILTERED??null,set:process.env.SNAPSHOT_USER_SET})+"\\n");
process.stdout.write(fs.readFileSync(0));
if(process.argv.includes("fail")){process.stderr.write("Synthetic Git failure detail.\\n");process.exitCode=17;}
`,
  );
  const index = join(root, "snapshot-index");
  const gitEnvironment = {
    GIT_INDEX_FILE: index,
    GIT_DIR: undefined,
    ...Object.fromEntries(
      Array.from({ length: 1024 }, (_, i) => [
        `GIT_UNSET_${i}_${"x".repeat(128)}`,
        undefined,
      ]),
    ),
  };
  expect(
    Buffer.byteLength(
      JSON.stringify(
        Object.entries(gitEnvironment).map(([name, value]) => [
          name,
          value ?? null,
        ]),
      ),
    ),
  ).toBeGreaterThan(128 * 1024);
  const sandbox = {
    directory: repository,
    environment: {
      ...process.env,
      CODEX_HOME: home,
      SNAPSHOT_USER_FILTERED: "excluded",
    },
    gitEnvironment,
    profile: {
      extends: ":workspace",
      network: { enabled: false },
      workspace_roots: {},
      filesystem: {},
    },
  };
  const input = Buffer.alloc(256 * 1024);
  for (let i = 0; i < input.length; i++) input[i] = i % 256;
  const args = [
    "-c",
    `alias.inspect=!node ${JSON.stringify(script.replaceAll("\\", "/"))}`,
    "inspect",
  ];
  const bytes = Buffer.from(
    await runRepositoryCommand("git", args, repository, {
      sandbox,
      input,
      encoding: "base64",
      trim: false,
      maxBuffer: Infinity,
    }),
    "base64",
  );
  const end = bytes.indexOf(10);
  expect(JSON.parse(bytes.subarray(0, end).toString())).toEqual({
    index,
    dir: null,
    filtered: null,
    set: "preserved",
  });
  expect(bytes.subarray(end + 1)).toEqual(input);
  await expect(
    runRepositoryCommand("git", [...args, "fail"], repository, { sandbox }),
  ).rejects.toMatchObject({
    code: 17,
    stderr: expect.stringContaining("Synthetic Git failure detail."),
  });
  await expect(
    runRepositoryCommand("git", args, repository, {
      sandbox,
      input,
      maxBuffer: 32,
    }),
  ).rejects.toHaveProperty("code", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  await expect(
    runRepositoryCommand(
      "git",
      ["cat-file", "--invalid-synthetic-option"],
      repository,
      { sandbox, input },
    ),
  ).rejects.toHaveProperty("code", 129);
  await expect(
    runRepositoryCommand("git", args, repository, {
      sandbox: {
        ...sandbox,
        configuration: { model_provider: "missing-synthetic-provider" },
      },
      input,
    }),
  ).rejects.toThrow("Model provider `missing-synthetic-provider` not found");
}, 30_000);

test.each(["standard", "nested", "worktree", "configured"] as const)(
  "snapshot filters can write LFS data while overlapping hooks stay protected: %s",
  async (mode) => {
    const root = await fixtures.create("patch-snapshot-storage-");
    const parent = join(root, "repository"),
      home = join(root, "home");
    await Promise.all([mkdir(parent), mkdir(home)]);
    await writeFile(join(home, "config.toml"), windows);
    const initialize = (directory: string) => {
      const git = repositoryGit(directory);
      git("init", "--initial-branch=main");
      git("config", "user.name", "Synthetic User");
      git("config", "user.email", "synthetic@example.test");
      return git;
    };
    const parentGit = initialize(parent);
    let repository = parent;
    let checkout = parent;
    if (mode === "nested") {
      checkout = join(parent, "child");
      await mkdir(checkout);
      initialize(checkout);
    }
    const initial = repositoryGit(checkout);
    const storage =
      mode === "configured"
        ? join(root, "data-cache")
        : join(checkout, ".git", "lfs");
    if (mode === "configured") initial("config", "lfs.storage", storage);
    const temporary = join(storage, "tmp"),
      objects = join(storage, "objects");
    await Promise.all([
      mkdir(temporary, { recursive: true }),
      mkdir(objects, { recursive: true }),
    ]);
    const hook = join(temporary, "post-index-change");
    const hookContents = "#!/bin/sh\nexit 0\n";
    await writeFile(hook, hookContents, { mode: 0o755 });
    initial("config", "core.hooksPath", temporary);
    const clean = join(root, "clean.cjs");
    await writeFile(
      clean,
      `const fs=require("node:fs"),path=require("node:path");const input=fs.readFileSync(0);
fs.writeFileSync(${JSON.stringify(join(temporary, "payload"))},input);
fs.writeFileSync(${JSON.stringify(join(objects, "payload"))},input);
if(fs.readFileSync("app.ts","utf8").startsWith("after")){try{fs.writeFileSync(${JSON.stringify(hook)},"changed");}catch(error){if(!["EACCES","EPERM","EROFS"].includes(error.code))throw error;}}
process.stdout.write(input);
`,
    );
    initial(
      "config",
      "filter.storage.clean",
      `node ${JSON.stringify(clean.replaceAll("\\", "/"))}`,
    );
    initial("config", "filter.storage.required", "true");
    initial("config", "filter.storage.smudge", "cat");
    await writeFile(join(checkout, ".gitattributes"), "data filter=storage\n");
    await writeFile(join(checkout, "app.ts"), "before\n");
    await writeFile(join(checkout, "data"), "Synthetic LFS payload\n");
    initial("add", ".");
    initial("commit", "-m", "Synthetic filtered baseline");
    if (mode === "nested") {
      parentGit("add", ".");
      parentGit("commit", "-m", "Synthetic parent baseline");
    }
    if (mode === "worktree") {
      repository = join(root, "linked");
      initial("worktree", "add", "-b", "linked", repository);
      checkout = repository;
    }
    const index = repositoryGit(checkout)(
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const originalIndex = await readFile(index);
    const environment = { ...process.env, CODEX_HOME: home };
    const result = await runWorkflow(["patch", "Synthetic issue", "--json"], {
      currentDirectory: repository,
      environment,
      onCodex: async (_args, output) => {
        output!.appServer!.onPermissions!({
          directory: repository,
          environment,
          snapshotStoragePaths: output!.appServer!.snapshotStoragePaths,
          profile: {
            extends: ":workspace",
            network: { enabled: false },
            workspace_roots: {},
            filesystem: Object.fromEntries(
              output!.appServer!.permissions!.readOnlyPaths.map((path) => [
                path,
                { ".": "read" },
              ]),
            ),
          },
        });
        await writeFile(join(checkout, "app.ts"), "after\n");
        output!.stdout.write("Synthetic patch complete.\n");
        return 0;
      },
      onRepositoryCommand: (command, args, cwd, options) =>
        runRepositoryCommand(command, args, cwd, {
          ...options,
          environment: { ...environment, ...options?.environment },
        }),
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).files).toContain(
      mode === "nested" ? "child/app.ts" : "app.ts",
    );
    expect(await readFile(hook, "utf8")).toBe(hookContents);
    expect(await readFile(join(objects, "payload"), "utf8")).toBe(
      "Synthetic LFS payload\n",
    );
    expect(await readFile(index)).toEqual(originalIndex);
  },
  30_000,
);
