import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { readSkillCommandOutput } from "../src/cli.js";
import { createTemporaryDirectories } from "./support/temporary-directories.js";

const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);

type RpcMessage = Record<string, any>;

async function resolvePatchProfile(configured: boolean) {
  const root = await fixtures.create("patch-native-profile-");
  const home = join(root, "home");
  const repository = join(root, "repository");
  const extra = join(root, "extra-workspace");
  for (const path of [home, repository, extra, join(repository, ".codex")])
    await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", repository]);
  const administration = join(repository, ".git");
  const configBefore = await readFile(join(administration, "config"));
  await writeFile(
    join(home, "config.toml"),
    `model_provider = "synthetic"
model = "synthetic-local-only"
sandbox_mode = "workspace-write"
[analytics]
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
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const stopped = "Synthetic stop before model execution";
  const input = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk)) as RpcMessage;
      requests.push(request);
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
    const reader = await readSkillCommandOutput(stream, {
      directory: repository,
      prompt: "Synthetic local-only profile resolution.",
      threadSource: "security_remediation",
      input,
      permissions: {
        name: "codex_security_patch",
        readOnlyPaths: [administration],
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
    expect(profiles[name]!["filesystem"]).toEqual({
      [administration]: { ".": "read" },
      ...(configured ? { ":tmpdir": {}, ":slash_tmp": {} } : {}),
    });
    expect(await readFile(join(administration, "config"))).toEqual(
      configBefore,
    );
    return {
      name,
      administration,
      filesystem: profiles[name]!["filesystem"] as RpcMessage,
    };
  } finally {
    clearTimeout(timeout);
    forwarding = false;
    stream.destroy();
    lines.close();
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
