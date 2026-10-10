import { afterEach, describe, expect, test } from "bun:test";
import {
  cp,
  symlink,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { runCodexSkillCommand } from "../src/cli.js";
import { capture } from "./cli-fixtures.js";
import { createTemporaryDirectories } from "./support/temporary-directories.js";
import {
  repositoryGit,
  runGitRepositoryCommand,
  runWorkflow,
} from "./cli-patch-fixtures.js";

describe("patch Git administration", () => {
  const fixtures = createTemporaryDirectories(true);
  afterEach(fixtures.cleanup);

  test("selects the same protected profile for the native thread and sandbox startup probe", async () => {
    const directory = await fixtures.create("patch-profile-protocol-");
    const source = `
const assert = require("node:assert/strict");
const lines = require("node:readline").createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    assert.equal(request.params.capabilities.experimentalApi, true);
    send({ id: 1, result: {} });
  } else if (request.method === "thread/start") {
    assert.deepEqual(request.params, { threadSource: "security_remediation", approvalPolicy: "never", permissions: "codex_security_patch" });
    send({ id: 2, result: { thread: { id: "patch-thread" }, sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false } } });
  } else if (request.method === "command/exec") {
    assert.equal(request.params.permissionProfile, "codex_security_patch");
    assert.equal(Object.hasOwn(request.params, "sandboxPolicy"), false);
    assert.equal(request.params.cwd, ${JSON.stringify(directory)});
    assert.deepEqual(request.params.command, [process.execPath, "-e", ""]);
    send({ id: 5, result: { exitCode: 0, stdout: "", stderr: "" } });
  } else if (request.method === "turn/start") {
    assert.equal(request.params.threadId, "patch-thread");
    assert.equal(Object.hasOwn(request.params, "sandboxPolicy"), false);
    send({ id: 3, result: { turn: { id: "patch-turn" } } });
    send({ method: "item/completed", params: { threadId: "patch-thread", turnId: "patch-turn", item: { type: "agentMessage", text: "Synthetic patch complete." } } });
    send({ method: "turn/completed", params: { threadId: "patch-thread", turn: { id: "patch-turn", status: "completed" } } });
  }
});
`;
    const stdout = capture();
    const stderr = capture();
    expect(
      await runCodexSkillCommand(
        ["-e", source],
        {
          command: "patch",
          stdout: stdout.stream,
          stderr: stderr.stream,
          appServer: {
            directory,
            prompt: "Fix the synthetic issue.",
            threadSource: "security_remediation",
            permissions: "codex_security_patch",
          },
        },
        { command: process.execPath },
        { PATH: process.env["PATH"] },
      ),
    ).toBe(0);
    expect(stdout.text()).toBe("Synthetic patch complete.\n");
    expect(stderr.text()).toBe("");
  });

  test.each([
    ["new", 0],
    ["new", 1],
    ["new", 130],
    ["recursive", 0],
    ["replacement", 0],
  ] as const)(
    "checks %s Git control state before bookkeeping after turn exit %d",
    async (mode, status) => {
      const root = await fixtures.create("patch-git-administration-");
      const git = repositoryGit(root);
      git("init", "--initial-branch=main");
      git("config", "user.name", "Synthetic User");
      git("config", "user.email", "synthetic@example.test");
      const nestedPath = mode === "recursive" ? "nested/child" : "nested";
      const nested = join(root, nestedPath);
      await mkdir(nested, { recursive: true });
      const child = repositoryGit(nested);
      child("init", "--initial-branch=main");
      child("config", "user.name", "Synthetic User");
      child("config", "user.email", "synthetic@example.test");
      await writeFile(join(nested, "app.txt"), "baseline\n");
      child("add", ".");
      child("commit", "-m", "Synthetic child baseline");
      const revision = child("rev-parse", "HEAD");
      const metadata = join(root, "data", "metadata");
      await mkdir(join(root, "data"));
      await rename(join(nested, ".git"), metadata);
      git(
        "--git-dir",
        metadata,
        "config",
        "core.worktree",
        `../../${nestedPath}`,
      );
      git(
        "--git-dir",
        metadata,
        "config",
        "core.hooksPath",
        "../data/metadata/hooks",
      );
      await writeFile(
        join(metadata, "hooks", "post-index-change"),
        `#!/bin/sh\nprintf 'synthetic-hook\\n' >> ${relative(nested, root).split(sep).join("/")}/.git/hook-ran\n`,
        { mode: 0o755 },
      );
      await rm(join(nested, "app.txt"));
      await writeFile(join(root, "outer.txt"), "baseline\n");
      git("add", "data", "outer.txt");
      let topRevision = revision;
      if (mode === "recursive") {
        const parent = repositoryGit(join(root, "nested"));
        parent("init", "--initial-branch=main");
        parent("config", "user.name", "Synthetic User");
        parent("config", "user.email", "synthetic@example.test");
        parent(
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${revision},child`,
        );
        parent("commit", "-m", "Synthetic parent gitlink");
        topRevision = parent("rev-parse", "HEAD");
      }
      git(
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${topRevision},nested`,
      );
      git("commit", "-m", "Synthetic metadata as ordinary input files");
      const marker = `${relative(nested, metadata).split(sep).join("/")}`;
      if (mode === "replacement")
        await writeFile(join(nested, ".git"), `gitdir: ${marker}\n`);
      let beforeHooks: Buffer | null = null;
      const head = git("rev-parse", "HEAD");
      const index = await readFile(join(root, ".git", "index"));
      let afterTurn = false;
      const bookkeeping: string[][] = [];
      const outcome = await runWorkflow(
        ["patch", "Synthetic issue", "--json"],
        {
          currentDirectory: root,
          onRepositoryCommand: (command, args, cwd, options) => {
            if (
              afterTurn &&
              args.some((value) =>
                ["add", "read-tree", "update-index", "write-tree"].includes(
                  value,
                ),
              )
            )
              bookkeeping.push([...args]);
            return runGitRepositoryCommand(command, args, cwd, options);
          },
          onCodex: async (args, output) => {
            const definition = args.find((value) =>
              value.startsWith("permissions.codex_security_patch="),
            );
            expect(definition).toBeDefined();
            const profile = (
              parseToml(definition!) as {
                permissions: {
                  codex_security_patch: {
                    extends: string;
                    filesystem: Record<string, { ".": string }>;
                  };
                };
              }
            ).permissions.codex_security_patch;
            expect(profile.extends).toBe(":workspace");
            expect(
              profile.filesystem[
                await realpath(git("rev-parse", "--absolute-git-dir"))
              ],
            ).toEqual({ ".": "read" });
            expect(output?.appServer?.permissions).toBe("codex_security_patch");
            beforeHooks = await readFile(join(root, ".git", "hook-ran")).catch(
              () => null,
            );
            if (mode === "replacement") {
              const retired = join(root, "data", "retired");
              await rename(metadata, retired);
              await cp(retired, metadata, { recursive: true });
            }
            await writeFile(join(nested, ".git"), `gitdir: ${marker}\n`);
            await writeFile(join(nested, "app.txt"), "fixed\n");
            await writeFile(join(root, "outer.txt"), "fixed\n");
            if (status !== 0)
              output?.stderr.write(`Synthetic turn exited ${status}.\n`);
            output?.stdout.write("Synthetic patch completed.\n");
            afterTurn = true;
            return status;
          },
        },
      );
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toContain(
        "Git metadata outside the pre-patch administration directories",
      );
      if (status !== 0)
        expect(outcome.stderr).toContain(`Synthetic turn exited ${status}.`);
      expect(bookkeeping).toEqual([]);
      expect(
        await readFile(join(root, ".git", "hook-ran")).catch(() => null),
      ).toEqual(beforeHooks);
      if (mode === "replacement") expect(beforeHooks).not.toBeNull();
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(await readFile(join(root, ".git", "index"))).toEqual(index);
      expect(await readFile(join(root, "outer.txt"), "utf8")).toBe("fixed\n");
    },
  );
  test("protects referenced configuration and hooks while preserving trusted execution", async () => {
    const root = await fixtures.create("patch-referenced-[literal]-");
    const git = repositoryGit(root);
    git("init", "--initial-branch=main");
    git("config", "user.name", "Synthetic User");
    git("config", "user.email", "synthetic@example.test");
    const hooks = join(root, "hook-files");
    const target = join(root, "hook-target");
    await mkdir(hooks);
    await writeFile(
      target,
      "#!/bin/sh\nprintf 'trusted\\n' >> .git/trusted-hook\n",
      { mode: 0o755 },
    );
    const hook = join(hooks, "post-index-change");
    if (process.platform === "win32") await cp(target, hook);
    else await symlink("../hook-target", hook);
    const configuration = join(root, "patch-config");
    await writeFile(
      configuration,
      "[core]\n hooksPath = hook-files\n[include]\n path = missing-config\n",
    );
    git("config", "include.path", "../patch-config");
    await writeFile(join(root, "app.txt"), "before\n");
    git("add", ".");
    git("commit", "-m", "Synthetic trusted hook configuration");
    let before = "";
    const outcome = await runWorkflow(["patch", "Synthetic issue", "--json"], {
      currentDirectory: root,
      onRepositoryCommand: runGitRepositoryCommand,
      onCodex: async (args, output) => {
        const definition = args.find((value) =>
          value.startsWith("permissions.codex_security_patch="),
        )!;
        const profile = (
          parseToml(definition) as {
            permissions: {
              codex_security_patch: {
                filesystem: Record<string, { ".": string }>;
              };
            };
          }
        ).permissions.codex_security_patch;
        const controls = profile.filesystem;
        for (const path of [
          configuration,
          hooks,
          ...(process.platform === "win32" ? [] : [target]),
        ])
          expect(controls[await realpath(path)]).toEqual({ ".": "read" });
        expect(controls[join(await realpath(root), "missing-config")]).toEqual({
          ".": "read",
        });
        expect(controls[await realpath(root)]).toBeUndefined();
        before = await readFile(join(root, ".git", "trusted-hook"), "utf8");
        await writeFile(join(root, "app.txt"), "after\n");
        output?.stdout.write("Fixed.\n");
        return 0;
      },
    });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    const after = await readFile(join(root, ".git", "trusted-hook"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect(await readFile(join(root, "app.txt"), "utf8")).toBe("after\n");
  });
});
