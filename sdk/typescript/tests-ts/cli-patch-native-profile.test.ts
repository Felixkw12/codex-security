import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { readSkillCommandOutput, runRepositoryCommand } from "../src/cli.js";
import { capturePatchGitControls } from "../src/patch-git-controls.js";
import { runGitRepositoryCommand } from "./cli-patch-fixtures.js";
import {
  patchSnapshotEnvironment,
  patchSnapshotWindowsConfig,
} from "./support/patch-snapshot-environment.js";
import { createTemporaryDirectories } from "./support/temporary-directories.js";

const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);

type RpcMessage = Record<string, any>;

interface PatchProfileContext {
  name: string;
  administration: string;
  filesystem: RpcMessage;
  modelProfile: RpcMessage;
  snapshotProfile: RpcMessage;
  repository: string;
  home: string;
  storage: string;
  controls: Awaited<ReturnType<typeof capturePatchGitControls>>;
}

async function cacheTransitionAcls(context: PatchProfileContext) {
  if (process.platform !== "win32") return undefined;
  try {
    let capabilities:
      | {
          workspace: string;
          readonly: string;
          workspace_by_cwd: Record<string, string>;
          writable_root_by_path: Record<string, string>;
        }
      | undefined;
    let capabilityError: string | undefined;
    try {
      capabilities = JSON.parse(
        await readFile(join(context.home, "cap_sid"), "utf8"),
      );
    } catch (error) {
      capabilityError = String(error);
    }
    const storage = await realpath(context.storage);
    const paths = [
      await realpath(context.repository),
      storage,
      join(storage, "objects"),
      join(storage, "tmp"),
    ];
    const states = await Promise.all(
      [...paths, join(storage, "objects", "synthetic")].map(async (path) => {
        try {
          const value = await lstat(path);
          return {
            path,
            file: value.isFile(),
            directory: value.isDirectory(),
            symbolicLink: value.isSymbolicLink(),
            size: value.size,
          };
        } catch (error) {
          return { path, observationError: String(error) };
        }
      }),
    );
    const observation = Buffer.from(
      JSON.stringify({
        paths,
        capabilitySids: capabilities
          ? [
              capabilities.workspace,
              capabilities.readonly,
              ...Object.values(capabilities.workspace_by_cwd),
              ...Object.values(capabilities.writable_root_by_path),
            ]
          : [],
      }),
    ).toString("base64");
    // Preserve order and masks only for capabilities generated in this fixture's home.
    const script = `$ErrorActionPreference = "Stop"
$observation = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${observation}')) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SnapshotAclReader {
  [DllImport("advapi32.dll", EntryPoint = "GetFileSecurityW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileSecurity(string path, uint information, [Out] byte[] descriptor, uint length, out uint needed);
  public static byte[] Read(string path) {
    uint needed;
    bool result = GetFileSecurity(path, 4, null, 0, out needed);
    int error = Marshal.GetLastWin32Error();
    if (!result && error != 122) throw new Win32Exception(error);
    byte[] descriptor = new byte[needed];
    if (!GetFileSecurity(path, 4, descriptor, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return descriptor;
  }
}
'@
$rows = @()
foreach ($target in $observation.paths) {
  try {
    $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new([SnapshotAclReader]::Read($target), 0)
    $entries = @()
    for ($ordinal = 0; $ordinal -lt $descriptor.DiscretionaryAcl.Count; $ordinal++) {
      $ace = $descriptor.DiscretionaryAcl[$ordinal]
      if ($ace -is [System.Security.AccessControl.KnownAce] -and $observation.capabilitySids -contains $ace.SecurityIdentifier.Value) {
        $entries += [ordered]@{ ordinal = $ordinal; type = $ace.AceType.ToString(); flags = $ace.AceFlags.ToString(); mask = $ace.AccessMask; sid = $ace.SecurityIdentifier.Value }
      }
    }
    $rows += [ordered]@{ path = $target; protected = ($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0; nullDacl = $null -eq $descriptor.DiscretionaryAcl; entries = $entries }
  } catch {
    $rows += [ordered]@{ path = $target; observationError = $_.Exception.Message; nativeErrorCode = $_.Exception.GetBaseException().NativeErrorCode }
  }
}
ConvertTo-Json -InputObject $rows -Depth 8 -Compress
`;
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return {
      capabilities,
      capabilityError,
      states,
      paths: JSON.parse(output),
    };
  } catch (error) {
    return { observationError: String(error) };
  }
}

async function resolvePatchProfile(
  configured: boolean,
  optionalStorage: false | "inside" | "outside" | "administration" = false,
  existingStorage = false,
  exercise?: (
    context: PatchProfileContext,
    inspectModel: (
      source: string,
      temporaryDirectory: string,
    ) => Promise<string>,
  ) => Promise<void>,
  observations?: RpcMessage[],
): Promise<PatchProfileContext> {
  const root = await fixtures.create("patch-native-profile-");
  const home = join(root, "home");
  const repository = join(root, "repository");
  const extra = join(root, "extra-workspace");
  for (const path of [home, repository, extra, join(repository, ".codex")])
    await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", repository]);
  const administration = join(repository, ".git");
  let readOnlyPaths: readonly string[] = [administration];
  let modelOnlyReadOnlyPaths: readonly string[] = [];
  let controls: Awaited<ReturnType<typeof capturePatchGitControls>>;
  const storage =
    optionalStorage === "inside"
      ? join(repository, "cache-data")
      : optionalStorage === "administration"
        ? administration
        : extra;
  if (optionalStorage) {
    await mkdir(storage, { recursive: true });
    if (existingStorage)
      for (const part of ["objects", "tmp"]) await mkdir(join(storage, part));
    await symlink(
      storage,
      join(repository, "cache"),
      process.platform === "win32" ? "junction" : "dir",
    );
    execFileSync("git", ["config", "lfs.storage", "../cache"], {
      cwd: repository,
    });
    controls = await capturePatchGitControls(
      repository,
      async (_root, checkout, args, options) =>
        runGitRepositoryCommand("git", args, checkout, options),
      true,
    );
    expect(controls).toBeDefined();
    expect(controls!.snapshotStoragePaths).toEqual([]);
    readOnlyPaths = controls!.readOnlyPaths;
    modelOnlyReadOnlyPaths = controls!.modelOnlyReadOnlyPaths;
    if (optionalStorage === "administration")
      expect(readOnlyPaths).toContain(await realpath(storage));
    else expect(readOnlyPaths).not.toContain(await realpath(storage));
    expect(modelOnlyReadOnlyPaths).toEqual([
      join(await realpath(storage), "objects"),
      join(await realpath(storage), "tmp"),
    ]);
    await controls!.validate();
  }
  const configBefore = await readFile(join(administration, "config"));
  const windows = patchSnapshotWindowsConfig();
  await writeFile(
    join(home, "config.toml"),
    `model_provider = "synthetic"
model = "synthetic-local-only"
sandbox_mode = "workspace-write"
${windows}[analytics]
enabled = false
[features]
plugins = false
[model_providers.synthetic]
name = "Synthetic"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
[projects.${JSON.stringify(repository)}]
trust_level = "trusted"
[sandbox_workspace_write]
network_access = ${configured}
writable_roots = ${JSON.stringify(configured ? [extra] : [])}
exclude_tmpdir_env_var = ${configured}
exclude_slash_tmp = ${configured}
`,
  );
  await writeFile(
    join(repository, ".codex", "config.toml"),
    `[permissions.codex_security_patch]
extends = ":workspace"
[permissions.codex_security_patch.filesystem]
glob_scan_max_depth = 8
[permissions.codex_security_patch.filesystem.":workspace_roots"]
".git/hooks" = "write"
`,
  );
  const nativeCli = fileURLToPath(
    new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url),
  );
  if (observations) {
    let canonicalHome = home;
    try {
      canonicalHome = await realpath(home);
    } catch (error) {
      observations.push({
        phase: "home-observation-error",
        error: String(error),
      });
    }
    observations.push({
      phase: "fixture",
      home,
      canonicalHome,
      repository,
      administration,
      storage,
    });
  }
  const child = spawn("node", [nativeCli, "app-server"], {
    cwd: repository,
    env: {
      PATH: process.env["PATH"],
      ...(process.env["SystemRoot"] === undefined
        ? {}
        : { SystemRoot: process.env["SystemRoot"] }),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: home,
      TMPDIR: root,
      RUST_LOG: "off",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const stream = new PassThrough();
  const requests: RpcMessage[] = [];
  const responses: RpcMessage[] = [];
  let forwarding = true;
  let stderr = "";
  let nextId = 100;
  const pending = new Map<
    number,
    { resolve(value: RpcMessage): void; reject(error: Error): void }
  >();
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", (error) => stream.destroy(error));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line) as RpcMessage;
    responses.push(response);
    if (typeof response["id"] === "number" && response["id"] > 100) {
      const waiter = pending.get(response["id"]);
      pending.delete(response["id"]);
      if (response["error"])
        waiter?.reject(new Error(JSON.stringify(response["error"])));
      else waiter?.resolve(response["result"] as RpcMessage);
    } else if (forwarding) stream.write(`${line}\n`);
  });
  const rpc = (method: string, params: RpcMessage) =>
    new Promise<RpcMessage>((resolve, reject) => {
      const id = ++nextId;
      const serialized = `${JSON.stringify({ id, method, params })}\n`;
      if (method === "command/exec")
        observations?.push({ phase: "model-request", serialized });
      pending.set(id, {
        resolve(value) {
          if (method === "command/exec")
            observations?.push({
              phase: "model-result",
              id,
              result: {
                exitCode: value["exitCode"],
                stdout: value["stdout"],
                stderr: value["stderr"],
              },
            });
          resolve(value);
        },
        reject(error) {
          if (method === "command/exec")
            observations?.push({
              phase: "model-error",
              id,
              error: String(error),
            });
          reject(error);
        },
      });
      child.stdin.write(serialized);
    });
  const stopped = "Synthetic stop before model execution";
  let snapshotsPrepared = false;
  const input = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk)) as RpcMessage;
      requests.push(request);
      if (request["method"] === "turn/start")
        expect(snapshotsPrepared).toBe(true);
      // Resolve real native policies without executing commands or model turns.
      if (
        request["method"] === "command/exec" ||
        request["method"] === "turn/start"
      ) {
        const response =
          request["method"] === "command/exec"
            ? {
                id: request["id"],
                result: { exitCode: 0, stdout: "", stderr: "" },
              }
            : { id: request["id"], error: { message: stopped } };
        queueMicrotask(() => stream.write(`${JSON.stringify(response)}\n`));
        callback();
      } else child.stdin.write(chunk, callback);
    },
    final(callback) {
      forwarding = false;
      stream.end();
      callback();
    },
  });
  const timeout = setTimeout(() => {
    const error = new Error(`Native profile fixture timed out: ${stderr}`);
    stream.destroy(error);
    for (const waiter of pending.values()) waiter.reject(error);
    child.kill();
  }, 20_000);
  try {
    let snapshotProfile: RpcMessage | undefined;
    const reader = await readSkillCommandOutput(stream, {
      directory: repository,
      prompt: "Synthetic local-only profile resolution.",
      threadSource: "security_remediation",
      input,
      onPermissions(profile) {
        snapshotProfile = profile;
      },
      async onBeforeTurn() {
        expect(snapshotProfile).toBeDefined();
        expect(requests.at(-1)?.["method"]).toBe("command/exec");
        await new Promise<void>((resolve) => setImmediate(resolve));
        snapshotsPrepared = true;
      },
      permissions: {
        name: "codex_security_patch",
        readOnlyPaths,
        modelOnlyReadOnlyPaths,
      },
    });
    expect(reader.error, stderr).toBe(stopped);
    const start = requests.find(
      (request) => request["method"] === "thread/start",
    )!;
    const turn = requests.find(
      (request) => request["method"] === "turn/start",
    )!;
    const legacy = responses.find((response) => response["id"] === 2)![
      "result"
    ] as RpcMessage;
    const configuration = responses.find((response) => response["id"] === 4)![
      "result"
    ] as RpcMessage;
    const selected = await rpc("thread/start", {
      cwd: repository,
      ephemeral: true,
      approvalPolicy: "never",
      permissions: turn["params"].permissions,
      config: start["params"].config,
    });
    const expectedPolicy = {
      type: "workspaceWrite",
      writableRoots: configured ? [extra] : [],
      networkAccess: configured,
      excludeTmpdirEnvVar: configured,
      excludeSlashTmp: configured,
    };
    expect(
      configuration["config"].permissions.codex_security_patch.filesystem[
        ":workspace_roots"
      ],
    ).toEqual({ ".git/hooks": "write" });
    expect(
      configuration["layers"].some(
        (layer: RpcMessage) =>
          layer["name"].type === "project" && layer["disabledReason"] == null,
      ),
    ).toBe(true);
    expect(legacy["activePermissionProfile"]).toBeNull();
    expect(legacy["sandbox"]).toEqual(expectedPolicy);
    const preflight = requests.find(
      (request) => request["method"] === "command/exec",
    )!;
    expect(preflight["params"].sandboxPolicy).toEqual(expectedPolicy);
    expect(selected["sandbox"]).toEqual(expectedPolicy);
    expect(selected["sandbox"].writableRoots).not.toContain(
      join(administration, "hooks"),
    );
    const name = turn["params"].permissions as string;
    expect(name).not.toBe("codex_security_patch");
    expect(selected["activePermissionProfile"]).toEqual({
      id: name,
      extends: ":workspace",
    });
    const profiles = start["params"].config.permissions as Record<
      string,
      RpcMessage
    >;
    expect(Object.keys(profiles)).toEqual([name]);
    const snapshotFilesystem = {
      ...Object.fromEntries(
        readOnlyPaths.map((path) => [path, { ".": "read" }]),
      ),
      ...(configured ? { ":tmpdir": {}, ":slash_tmp": {} } : {}),
    };
    expect(snapshotProfile).toEqual({
      ...profiles[name],
      filesystem: snapshotFilesystem,
    });
    expect(profiles[name]!["filesystem"]).toEqual({
      ...snapshotFilesystem,
      ...Object.fromEntries(
        modelOnlyReadOnlyPaths.map((path) => [path, { ".": "read" }]),
      ),
    });
    expect(await readFile(join(administration, "config"))).toEqual(
      configBefore,
    );
    const context: PatchProfileContext = {
      name,
      administration,
      filesystem: profiles[name]!["filesystem"] as RpcMessage,
      modelProfile: profiles[name]!,
      snapshotProfile: snapshotProfile!,
      repository,
      home,
      storage,
      controls,
    };
    observations?.push({
      phase: "profiles",
      name,
      modelProfile: context.modelProfile,
      snapshotProfile: context.snapshotProfile,
      readOnlyPaths,
      modelOnlyReadOnlyPaths,
      snapshotStoragePaths: controls?.snapshotStoragePaths,
      selectedThread: {
        activePermissionProfile: selected["activePermissionProfile"],
        sandbox: selected["sandbox"],
      },
    });
    clearTimeout(timeout);
    if (exercise) {
      await rpc("config/value/write", {
        keyPath: `permissions.${name}`,
        value: context.modelProfile,
        mergeStrategy: "replace",
        filePath: join(home, "config.toml"),
      });
      await exercise(context, async (source, temporaryDirectory) => {
        // Model tools and command/exec share native permission preparation.
        const result = await rpc("command/exec", {
          command: ["node", "-e", source],
          cwd: repository,
          permissionProfile: name,
          env: {
            TEMP: temporaryDirectory,
            TMP: temporaryDirectory,
            TMPDIR: temporaryDirectory,
          },
          timeoutMs: 30_000,
        });
        expect(result["exitCode"] as number, result["stderr"] as string).toBe(
          0,
        );
        return result["stdout"] as string;
      });
    }
    return context;
  } finally {
    clearTimeout(timeout);
    forwarding = false;
    stream.destroy();
    lines.close();
    observations?.push({ phase: "app-server-stderr", stderr });
    child.stdin.end();
    const shutdown = setTimeout(() => child.kill(), 3000);
    await closed;
    clearTimeout(shutdown);
  }
}

test("native patch profiles ignore inactive repository grants and remain isolated between operations", async () => {
  const results = await Promise.allSettled([
    resolvePatchProfile(false),
    resolvePatchProfile(true),
  ]);
  const values = results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  const first = values[0]!;
  const second = values[1]!;
  expect(first.name).not.toBe(second.name);
  expect(first.filesystem).not.toHaveProperty(second.administration);
  expect(second.filesystem).not.toHaveProperty(first.administration);
}, 30_000);

test("native patch profiles omit unavailable optional storage permissions", async () => {
  await resolvePatchProfile(false, "outside");
}, 30_000);

test("optional storage keeps overlapping Git administration protected in snapshots", async () => {
  const context = await resolvePatchProfile(false, "administration");
  const environment = patchSnapshotEnvironment(
    await fixtures.create("patch-cache-overlap-"),
    { ...process.env, CODEX_HOME: context.home },
  );
  const source = `const fs=require("node:fs");try{fs.writeFileSync(${JSON.stringify(join(context.storage, "objects", "synthetic"))},"changed");fs.writeSync(1,"allowed");}catch(error){fs.writeSync(1,error.code);}`;
  const output = await runRepositoryCommand(
    "git",
    [
      "-c",
      `alias.inspect=!node -e '${source.replaceAll("'", "'\\''")}'`,
      "inspect",
    ],
    context.repository,
    {
      sandbox: {
        directory: context.repository,
        environment,
        profile: context.snapshotProfile,
      },
    },
  );
  expect(["EROFS", "EACCES", "EPERM"]).toContain(output);
  await context.controls!.validate();
}, 30_000);

for (const location of ["inside", "outside"] as const) {
  for (const existing of [false, true]) {
    test(`optional cache keeps model protection and inherited snapshot access: ${location}, existing ${existing}`, async () => {
      const observations: RpcMessage[] = [];
      const originalSpawn = childProcess.spawn;
      const observer = spyOn(childProcess, "spawn").mockImplementation(((
        ...input: Parameters<typeof originalSpawn>
      ) => {
        const [command, args, options] = input;
        const fixture = observations.find(
          (item) => item["phase"] === "fixture",
        );
        if (
          fixture &&
          [fixture["home"], fixture["canonicalHome"]].includes(
            options?.env?.["CODEX_HOME"],
          )
        ) {
          try {
            const profileIndex = args?.indexOf("--permission-profile") ?? -1;
            const profile =
              profileIndex < 0 ? undefined : args?.[profileIndex + 1];
            observations.push({
              phase: "native-spawn",
              command,
              args,
              cwd: options?.cwd,
              baseConfig: readFileSync(
                join(fixture["home"], "config.toml"),
                "utf8",
              ),
              ...(profile
                ? {
                    namedConfig: readFileSync(
                      join(fixture["home"], `${profile}.config.toml`),
                      "utf8",
                    ),
                  }
                : {}),
            });
          } catch (error) {
            observations.push({
              phase: "native-spawn",
              command,
              args,
              cwd: options?.cwd,
              observationError: String(error),
            });
          }
        }
        return originalSpawn(...input);
      }) as typeof originalSpawn);
      try {
        await resolvePatchProfile(
          location === "outside",
          location,
          existing,
          async (context, inspectModel) => {
            const temporaryDirectory = await fixtures.create(
              "patch-cache-temporary-",
            );
            const environment = patchSnapshotEnvironment(temporaryDirectory, {
              ...process.env,
              CODEX_HOME: context.home,
            });
            const paths = [
              join(context.storage, "objects"),
              join(context.storage, "tmp"),
            ];
            const file = join(paths[0]!, "synthetic");
            let modelCommands = 0;
            const inspectModelObserved = async (
              source: string,
              temporary: string,
            ) => {
              try {
                return await inspectModel(source, temporary);
              } finally {
                modelCommands++;
                if (existing || modelCommands === 1)
                  observations.push({
                    phase: "model-complete",
                    modelCommands,
                    acls: await cacheTransitionAcls(context),
                  });
              }
            };
            const inspect = async (source: string, profile: RpcMessage) => {
              const stderr: Buffer[] = [];
              try {
                return await runRepositoryCommand(
                  "git",
                  [
                    "-c",
                    `alias.inspect=!node -e '${source.replaceAll("'", "'\\''")}'`,
                    "inspect",
                  ],
                  context.repository,
                  {
                    sandbox: {
                      directory: context.repository,
                      environment,
                      profile,
                    },
                    onStderr(chunk) {
                      stderr.push(Buffer.from(chunk));
                    },
                  },
                );
              } finally {
                observations.push({
                  phase: "snapshot-complete",
                  stderr: Buffer.concat(stderr).toString("utf8"),
                  acls: await cacheTransitionAcls(context),
                });
              }
            };
            if (!existing) {
              for (const path of paths)
                await expect(lstat(path)).rejects.toMatchObject({
                  code: "ENOENT",
                });
              const beforeSnapshot = JSON.parse(
                await inspectModelObserved(
                  `const fs=require("node:fs");const attempts=${JSON.stringify(paths)}.map(path=>{let created=false,childCreated=false,wrote=false,createError,childError,writeError;try{created=fs.mkdirSync(path,{recursive:true})!==undefined;}catch(error){createError=error.code;}try{fs.mkdirSync(path+"/synthetic-child");childCreated=true;}catch(error){childError=error.code;}try{fs.writeFileSync(path+"/synthetic","changed");wrote=true;}catch(error){writeError=error.code;}return{created,childCreated,wrote,createError,childError,writeError};});fs.writeSync(1,JSON.stringify(attempts));`,
                  temporaryDirectory,
                ),
              );
              expect(beforeSnapshot).toEqual(
                paths.map(() =>
                  expect.objectContaining({
                    created: false,
                    childCreated: false,
                    wrote: false,
                    childError: expect.any(String),
                    writeError: expect.any(String),
                  }),
                ),
              );
              for (const path of paths) {
                if (process.platform === "win32") {
                  // Native ACL setup creates empty protected directory placeholders.
                  expect((await lstat(path)).isDirectory()).toBe(true);
                  expect(await readdir(path)).toEqual([]);
                } else
                  await expect(lstat(path)).rejects.toMatchObject({
                    code: "ENOENT",
                  });
              }
            }
            const snapshot = await inspect(
              `const fs=require("node:fs");for(const path of ${JSON.stringify(paths)})fs.mkdirSync(path,{recursive:true});fs.writeFileSync(${JSON.stringify(file)},"unchanged");fs.writeSync(1,"prepared");`,
              context.snapshotProfile,
            );
            expect(snapshot).toBe("prepared");
            await context.controls!.validate();
            const model = await inspectModelObserved(
              `const fs=require("node:fs");try{fs.writeFileSync(${JSON.stringify(file)},"changed");fs.writeSync(1,"allowed");}catch(error){fs.writeSync(1,error.code);}`,
              temporaryDirectory,
            );
            expect(["EROFS", "EACCES", "EPERM"]).toContain(model);
            expect(await readFile(file, "utf8")).toBe("unchanged");
            await context.controls!.validate();
            await rename(paths[0]!, `${paths[0]}-previous`);
            await mkdir(paths[0]!);
            await expect(context.controls!.validate()).rejects.toThrow(
              "changed location during the patch",
            );
          },
          observations,
        );
      } finally {
        observer.mockRestore();
        console.log(
          JSON.stringify({
            optionalCacheTransition: { location, existing, observations },
          }),
        );
      }
    }, 30_000);
  }
}

test("a failed prepared snapshot prevents the model turn and preserves its diagnostic", async () => {
  const stream = new PassThrough();
  const requests: RpcMessage[] = [];
  const input = new Writable({
    write(chunk, _encoding, callback) {
      requests.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  for (const reply of [
    { id: 1, result: {} },
    { id: 4, result: { config: {} } },
    {
      id: 2,
      result: {
        thread: { id: "synthetic" },
        sandbox: { type: "workspaceWrite" },
      },
    },
    { id: 5, result: { exitCode: 0, stdout: "", stderr: "" } },
  ])
    stream.write(`${JSON.stringify(reply)}\n`);
  stream.end();
  const diagnostic = "Synthetic snapshot error with original details";
  await expect(
    readSkillCommandOutput(stream, {
      directory: process.cwd(),
      prompt: "Synthetic patch",
      threadSource: "security_remediation",
      input,
      permissions: { name: "synthetic", readOnlyPaths: [] },
      async onBeforeTurn() {
        throw new Error(diagnostic);
      },
    }),
  ).rejects.toThrow(diagnostic);
  expect(requests.some((request) => request["method"] === "turn/start")).toBe(
    false,
  );
});
