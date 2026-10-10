import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { createTemporaryDirectories } from "./support/temporary-directories.js";
import {
  repositoryGit,
  runGitRepositoryCommand,
  runWorkflow,
} from "./cli-patch-fixtures.js";

const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);

test.each([
  { relativeCommon: false, rebind: false },
  { relativeCommon: true, rebind: false },
  { relativeCommon: false, rebind: true },
])(
  "honors a common-directory override without losing marker binding (relative: $relativeCommon, rebound: $rebind)",
  async ({ relativeCommon, rebind }) => {
    const main = await fixtures.create("patch-common-main-");
    const selected = await fixtures.create("patch-common-selected-");
    const other = await fixtures.create("patch-common-other-");
    const git = repositoryGit(main);
    git("init", "--initial-branch=main");
    git("config", "user.name", "Synthetic User");
    git("config", "user.email", "synthetic@example.test");
    await writeFile(join(main, "app.ts"), "before\n");
    git("add", "app.ts");
    git("commit", "-m", "Synthetic common-directory baseline");
    git("worktree", "add", "--detach", selected);
    git("worktree", "add", "--detach", other);
    const administration = await realpath(
      repositoryGit(selected)("rev-parse", "--absolute-git-dir"),
    );
    const otherAdministration = await realpath(
      repositoryGit(other)("rev-parse", "--absolute-git-dir"),
    );
    const common = await realpath(join(main, ".git"));
    const stale = "../../../missing-common\n";
    await writeFile(join(administration, "commondir"), stale);
    const environment = {
      GIT_COMMON_DIR: relativeCommon ? relative(selected, common) : common,
    };
    const selectedGit = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: selected,
        env: { ...process.env, ...environment },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    expect(selectedGit("status", "--porcelain")).toBe("");
    const head = selectedGit("rev-parse", "HEAD");
    const index = await readFile(join(administration, "index"));
    const otherIndex = await readFile(join(otherAdministration, "index"));
    const otherContents = await readFile(join(other, "app.ts"));
    const selectedMarker = await readFile(join(selected, ".git"));
    const otherMarker = await readFile(join(other, ".git"));
    const afterTurnCommands: string[][] = [];
    let launches = 0;
    const outcome = await runWorkflow(["patch", "Synthetic issue", "--json"], {
      currentDirectory: selected,
      environment,
      onRepositoryCommand: (command, args, cwd, options) => {
        if (launches > 0) afterTurnCommands.push([...args]);
        return runGitRepositoryCommand(command, args, cwd, {
          ...options,
          environment: { ...environment, ...options?.environment },
        });
      },
      onCodex: async (_args, output) => {
        launches++;
        expect(output?.appServer?.permissions?.readOnlyPaths).toContain(
          administration,
        );
        expect(output?.appServer?.permissions?.readOnlyPaths).toContain(common);
        if (rebind) await writeFile(join(selected, ".git"), otherMarker);
        await writeFile(join(selected, "app.ts"), "after\n");
        output?.stdout.write("Synthetic patch complete.\n");
        return 0;
      },
    });
    expect(outcome.exitCode, outcome.stderr).toBe(rebind ? 2 : 0);
    expect(launches).toBe(1);
    if (rebind) {
      expect(outcome.stderr).toContain(
        "Selected Git administration changed during the patch",
      );
      expect(
        afterTurnCommands.filter((args) =>
          args.some((arg) =>
            ["add", "read-tree", "update-index", "write-tree"].includes(arg),
          ),
        ),
      ).toEqual([]);
    } else {
      expect(JSON.parse(outcome.stdout).files).toEqual(["app.ts"]);
      expect(await readFile(join(selected, ".git"))).toEqual(selectedMarker);
    }
    expect(selectedGit("--git-dir", administration, "rev-parse", "HEAD")).toBe(
      head,
    );
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(repositoryGit(other)("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(administration, "index"))).toEqual(index);
    expect(await readFile(join(otherAdministration, "index"))).toEqual(
      otherIndex,
    );
    expect(await readFile(join(administration, "commondir"), "utf8")).toBe(
      stale,
    );
    expect(await readFile(join(selected, "app.ts"), "utf8")).toBe("after\n");
    expect(await readFile(join(other, "app.ts"))).toEqual(otherContents);
  },
);

for (const selector of ["GIT_DIR", "GIT_COMMON_DIR"] as const) {
  test.each([{ retarget: false }, { retarget: true }])(
    `binds an explicit ${selector} alias when config is absent (retargeted: $retarget)`,
    async ({ retarget }) => {
      const root = await fixtures.create("patch-selector-alias-");
      const support = await fixtures.create("patch-selector-support-");
      const git = repositoryGit(root);
      git("init", "--initial-branch=main");
      git("config", "user.name", "Synthetic User");
      git("config", "user.email", "synthetic@example.test");
      await writeFile(join(root, "app.ts"), "before\n");
      await writeFile(
        join(root, ".gitignore"),
        "selected-administration\noriginal-administration\n",
      );
      git("add", ".");
      git("commit", "-m", "Synthetic selector baseline");
      const replacement = join(support, "replacement");
      await cp(join(root, ".git"), replacement, { recursive: true });
      await unlink(join(root, ".git", "config"));
      const hooks = join(root, "operator-hooks");
      await mkdir(hooks);
      const effect = join(support, "hook-effect");
      const shellPath = `'${effect.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
      await writeFile(
        join(hooks, "post-index-change"),
        `#!/bin/sh\nprintf effect > ${shellPath}\n`,
        { mode: 0o755 },
      );
      git("--git-dir", replacement, "config", "core.hooksPath", hooks);
      git(
        "--git-dir",
        replacement,
        "--work-tree",
        root,
        "update-index",
        "--assume-unchanged",
        "app.ts",
      );
      git(
        "--git-dir",
        replacement,
        "--work-tree",
        root,
        "update-index",
        "--no-assume-unchanged",
        "app.ts",
      );
      expect(await readFile(effect, "utf8")).toBe("effect");
      await unlink(effect);
      const alias = join(root, "selected-administration");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await symlink(join(root, ".git"), alias, linkType);
      const environment = {
        [selector]: alias,
        ...(selector === "GIT_DIR" ? { GIT_WORK_TREE: root } : {}),
      };
      const head = git("rev-parse", "HEAD");
      const index = await readFile(join(root, ".git", "index"));
      const otherIndex = await readFile(join(replacement, "index"));
      let launches = 0;
      const afterTurnCommands: string[][] = [];
      const outcome = await runWorkflow(
        ["patch", "Synthetic issue", "--json"],
        {
          currentDirectory: root,
          environment,
          onRepositoryCommand: (command, args, cwd, options) => {
            if (launches > 0) afterTurnCommands.push([...args]);
            return runGitRepositoryCommand(command, args, cwd, {
              ...options,
              environment: { ...environment, ...options?.environment },
            });
          },
          onCodex: async (_args, output) => {
            launches++;
            if (retarget) {
              await rename(alias, join(root, "original-administration"));
              await symlink(replacement, alias, linkType);
            }
            await writeFile(join(root, "app.ts"), "after\n");
            output?.stdout.write("Synthetic patch complete.\n");
            return 0;
          },
        },
      );
      expect(outcome.exitCode, outcome.stderr).toBe(retarget ? 2 : 0);
      expect(launches).toBe(1);
      if (retarget) {
        expect(outcome.stderr).toContain(
          "Git configuration or hooks changed location during the patch",
        );
        expect(outcome.stderr).toContain(alias);
        expect(afterTurnCommands).toEqual([]);
      } else expect(JSON.parse(outcome.stdout).files).toEqual(["app.ts"]);
      expect(await readFile(effect).catch(() => null)).toBeNull();
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(await readFile(join(root, ".git", "index"))).toEqual(index);
      expect(await readFile(join(replacement, "index"))).toEqual(otherIndex);
      expect(await readFile(join(root, "app.ts"), "utf8")).toBe("after\n");
    },
  );
}
