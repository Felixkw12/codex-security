import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  publicationRepository,
  readAppliedText,
  repositoryGit,
  runGitRepositoryCommand,
  runWorkflow,
} from "./cli-patch-fixtures.js";
import { createTemporaryDirectories } from "./support/temporary-directories.js";

describe("deinitialized patch submodule availability", () => {
  const fixtures = createTemporaryDirectories(true);
  afterEach(fixtures.cleanup);

  async function fixture() {
    const outer = await publicationRepository(fixtures);
    const { directory, git } = outer;
    const hooks = await fixtures.create("patch-submodule-hooks-");
    git("config", "core.hooksPath", hooks);
    const nested = join(directory, "nested");
    await mkdir(nested);
    const inner = repositoryGit(nested);
    inner("init", "--initial-branch=main");
    inner("config", "user.name", "Synthetic User");
    inner("config", "user.email", "synthetic@example.test");
    inner("config", "core.hooksPath", hooks);
    await writeFile(join(nested, "app.ts"), "original\n");
    inner("add", ".");
    inner("commit", "-m", "Synthetic nested baseline");
    const childRemote = await fixtures.create("patch-submodule-origin-");
    git("clone", "--bare", nested, childRemote);
    inner("remote", "add", "origin", childRemote);
    inner("fetch", "origin");
    git("config", "-f", ".gitmodules", "submodule.nested.path", "nested");
    git("config", "-f", ".gitmodules", "submodule.nested.url", childRemote);
    git("add", ".gitmodules", "nested");
    git("commit", "-m", "Synthetic registered submodule");
    git("submodule", "init");
    git("submodule", "absorbgitdirs", "--", "nested");
    const retained = inner("rev-parse", "--absolute-git-dir");
    const pushes: string[][] = [];
    let creations = 0;
    let modelRuns = 0;
    const run = (
      args: string[],
      onCodex?: NonNullable<Parameters<typeof runWorkflow>[1]>["onCodex"],
    ) =>
      runWorkflow(args, {
        currentDirectory: directory,
        onRepositoryCommand: (command, arguments_, cwd, options) => {
          if (command === "git") {
            if (arguments_[0] === "push") pushes.push([...arguments_]);
            return runGitRepositoryCommand(command, arguments_, cwd, options);
          }
          if (arguments_[1] === "list") return "[]";
          if (arguments_[1] === "create") creations += 1;
          return "https://github.example.test/example/repository/pull/1";
        },
        onCodex: async (arguments_, output) => {
          modelRuns += 1;
          if (onCodex === undefined)
            throw new Error("Resume must not rerun the patch model.");
          return onCodex(arguments_, output);
        },
      });
    const update = async (published = false) => {
      await writeFile(join(nested, "app.ts"), "fixed\n");
      inner("commit", "-am", "Synthetic nested update");
      const commit = inner("rev-parse", "HEAD");
      if (published) inner("push", "origin", "HEAD:main");
      git("add", "nested");
      git("submodule", "deinit", "--force", "--", "nested");
      return commit;
    };
    return {
      ...outer,
      childRemote,
      retained,
      run,
      update,
      pushes,
      counts: () => ({ creations, modelRuns }),
      branch: () =>
        git(
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/codex-security",
        ),
    };
  }

  const unavailable = [
    "missing object",
    "no remote refs",
    "deleted registration file",
    "unregistered gitlink",
  ] as const;
  test.each(unavailable)(
    "refuses %s on initial publication and resume",
    async (kind) => {
      const current = await fixture();
      const { directory, git, retained } = current;
      const initial = await current.run(
        ["patch", "Synthetic issue", "--create-pr", "--json"],
        async (_args, output) => {
          let commit = await current.update();
          if (kind === "missing object") {
            commit = "1".repeat(commit.length);
            expect(() =>
              git("--git-dir", retained, "cat-file", "-t", commit),
            ).toThrow();
            git("update-index", "--cacheinfo", `160000,${commit},nested`);
          } else if (kind === "no remote refs") {
            for (const ref of git(
              "--git-dir",
              retained,
              "for-each-ref",
              "--format=%(refname)",
              "refs/remotes",
            )
              .split("\n")
              .filter(Boolean))
              git("--git-dir", retained, "update-ref", "-d", ref);
          } else if (kind === "deleted registration file") {
            await rm(join(directory, ".gitmodules"));
          } else {
            git("update-index", "--force-remove", "nested");
            await mkdir(join(directory, "unregistered"));
            git(
              "update-index",
              "--add",
              "--cacheinfo",
              `160000,${commit},unregistered`,
            );
          }
          output?.stdout.write("Synthetic patch complete.");
          return 0;
        },
      );
      expect(initial.exitCode).toBe(2);
      expect(initial.stderr).toContain(
        "not available in its remote-tracking refs",
      );
      const branch = current.branch();
      expect(branch).not.toBe("");
      const saved = git("rev-parse", `refs/heads/${branch}`);
      const resumed = await current.run([
        "patch",
        "--resume-pr",
        branch,
        "--json",
      ]);
      expect(resumed.exitCode).toBe(2);
      expect(resumed.stderr).toContain(
        "not available in its remote-tracking refs",
      );
      expect(git("rev-parse", `refs/heads/${branch}`)).toBe(saved);
      expect(git("ls-remote", "origin")).toBe("");
      expect(current.pushes).toEqual([]);
      expect(current.counts()).toEqual({ creations: 0, modelRuns: 1 });
    },
  );

  test.each([false, true])(
    "publishes an available commit with deleted current registration: %p",
    async (deleteRegistration) => {
      const current = await fixture();
      let commit = "";
      const result = await current.run(
        ["patch", "Synthetic issue", "--create-pr", "--json"],
        async (_args, output) => {
          commit = await current.update(true);
          if (deleteRegistration)
            await rm(join(current.directory, ".gitmodules"));
          output?.stdout.write("Synthetic patch complete.");
          return 0;
        },
      );
      expect(result.exitCode).toBe(0);
      expect(current.counts()).toEqual({ creations: 1, modelRuns: 1 });
      const branch = current.branch();
      expect(
        repositoryGit(current.remote)("ls-tree", branch, "nested"),
      ).toContain(`160000 commit ${commit}\tnested`);
      if (deleteRegistration) {
        expect(
          repositoryGit(current.remote)("ls-tree", branch, ".gitmodules"),
        ).toBe("");
      } else {
        const clone = await fixtures.create("patch-submodule-published-");
        current.git("clone", "--branch", branch, current.remote, clone);
        repositoryGit(clone)(
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "update",
          "--init",
        );
        expect(await readAppliedText(join(clone, "nested", "app.ts"))).toBe(
          "fixed\n",
        );
      }
    },
  );

  test.each([
    ["push.recurseSubmodules", "no"],
    ["submodule.recurse", "false"],
  ])("preserves explicit %s=%s", async (key, value) => {
    const current = await fixture();
    current.git("config", key, value);
    const result = await current.run(
      ["patch", "Synthetic issue", "--create-pr", "--json"],
      async (_args, output) => {
        const commit = "1".repeat((await current.update()).length);
        current.git("update-index", "--cacheinfo", `160000,${commit},nested`);
        output?.stdout.write("Synthetic patch complete.");
        return 0;
      },
    );
    expect(result.exitCode).toBe(0);
    expect(current.pushes).toHaveLength(1);
    expect(current.pushes[0]).not.toContain("--recurse-submodules=check");
    expect(current.git("config", "--get", key)).toBe(value);
    expect(current.counts()).toEqual({ creations: 1, modelRuns: 1 });
  });
});
