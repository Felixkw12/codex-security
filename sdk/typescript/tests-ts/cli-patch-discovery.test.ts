import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectories } from "./support/temporary-directories.js";
import {
  repositoryGit,
  runGitRepositoryCommand,
  runWorkflow,
} from "./cli-patch-fixtures.js";

const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);

async function repository(prefix: string) {
  const root = await fixtures.create(prefix);
  const git = repositoryGit(root);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Synthetic User");
  git("config", "user.email", "synthetic@example.test");
  await mkdir(join(root, "source", "deep"), { recursive: true });
  await writeFile(join(root, "app.ts"), "before\n");
  await writeFile(join(root, "source", "deep", "input.ts"), "fixture source\n");
  git("add", ".");
  git("commit", "-m", "Synthetic discovery baseline");
  return { root, git };
}

for (const raw of [false, true]) {
  test.skipIf(raw && process.platform !== "linux")(
    `patch discovery does not traverse symlinked ancestors of ordinary tracked files${raw ? " with raw bytes" : ""}`,
    async () => {
      const selected = await repository("patch-discovery-selected-");
      const foreign = await repository("patch-discovery-foreign-");
      // A deeper checkout detects traversals that skip only the final symlink itself.
      const nestedPath = join(foreign.root, "deep");
      await mkdir(nestedPath);
      const nested = repositoryGit(nestedPath);
      nested("init", "--initial-branch=main");
      nested("config", "user.name", "Synthetic User");
      nested("config", "user.email", "synthetic@example.test");
      await writeFile(join(nestedPath, "input.ts"), "foreign source\n");
      nested("add", ".");
      nested("commit", "-m", "Synthetic nested foreign baseline");
      const foreignHead = foreign.git("rev-parse", "HEAD");
      const foreignIndex = await readFile(join(foreign.root, ".git", "index"));
      const nestedHead = nested("rev-parse", "HEAD");
      const nestedIndex = await readFile(join(nestedPath, ".git", "index"));
      const link = raw
        ? Buffer.concat([
            Buffer.from(`${selected.root}/source-`),
            Buffer.from([0xff]),
          ])
        : join(selected.root, "source");
      if (raw) {
        await rename(join(selected.root, "source"), link);
        selected.git("add", "--all");
        selected.git("commit", "-m", "Synthetic raw directory baseline");
      }
      const selectedIndex = await readFile(
        join(selected.root, ".git", "index"),
      );
      const removed = await fixtures.create("patch-discovery-removed-");
      await rename(link, join(removed, "source"));
      await symlink(
        foreign.root,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      const originalLink = await readlink(link);
      let launches = 0;
      const outcome = await runWorkflow(
        ["patch", "Synthetic issue", "--json"],
        {
          currentDirectory: selected.root,
          onRepositoryCommand: runGitRepositoryCommand,
          onCodex: async (_args, output) => {
            launches++;
            await writeFile(join(selected.root, "app.ts"), "after\n");
            output?.stdout.write("Synthetic patch complete.\n");
            return 0;
          },
        },
      );
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      expect(launches).toBe(1);
      expect(JSON.parse(outcome.stdout).files).toEqual(["app.ts"]);
      expect(await readlink(link)).toBe(originalLink);
      expect(await readFile(join(selected.root, ".git", "index"))).toEqual(
        selectedIndex,
      );
      expect(foreign.git("rev-parse", "HEAD")).toBe(foreignHead);
      expect(await readFile(join(foreign.root, ".git", "index"))).toEqual(
        foreignIndex,
      );
      expect(nested("rev-parse", "HEAD")).toBe(nestedHead);
      expect(await readFile(join(nestedPath, ".git", "index"))).toEqual(
        nestedIndex,
      );
      expect(await readFile(join(nestedPath, "input.ts"), "utf8")).toBe(
        "foreign source\n",
      );
      expect(await readFile(join(selected.root, "app.ts"), "utf8")).toBe(
        "after\n",
      );
    },
  );
}

test.each(["synthetic fixture data\n", "gitdir: ../absent-administration\n"])(
  "patch discovery keeps non-repository Git marker fixture %j usable",
  async (contents) => {
    const selected = await repository("patch-discovery-marker-");
    const marker = join(selected.root, "source", ".git");
    await writeFile(marker, contents);
    const index = await readFile(join(selected.root, ".git", "index"));
    let launches = 0;
    const outcome = await runWorkflow(["patch", "Synthetic issue", "--json"], {
      currentDirectory: selected.root,
      onRepositoryCommand: runGitRepositoryCommand,
      onCodex: async (_args, output) => {
        launches++;
        await writeFile(join(selected.root, "app.ts"), "after\n");
        output?.stdout.write("Synthetic patch complete.\n");
        return 0;
      },
    });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(launches).toBe(1);
    expect(JSON.parse(outcome.stdout).files).toEqual(["app.ts"]);
    expect(await readFile(marker, "utf8")).toBe(contents);
    expect(await readFile(join(selected.root, ".git", "index"))).toEqual(index);
    expect(await readFile(join(selected.root, "app.ts"), "utf8")).toBe(
      "after\n",
    );
  },
);

test.each([false, true])(
  "patch discovery rejects newly selected foreign Git administration before bookkeeping (invalid ancestor: %p)",
  async (invalidAncestor) => {
    const selected = await repository("patch-discovery-guard-");
    const foreign = await repository("patch-discovery-unselected-");
    foreign.git("config", "core.worktree", foreign.root);
    const selectedHead = selected.git("rev-parse", "HEAD");
    const selectedIndex = await readFile(join(selected.root, ".git", "index"));
    const foreignHead = foreign.git("rev-parse", "HEAD");
    const foreignIndex = await readFile(join(foreign.root, ".git", "index"));
    if (invalidAncestor)
      await writeFile(
        join(selected.root, "source", ".git"),
        "synthetic fixture data\n",
      );
    const marker = join(
      selected.root,
      "source",
      ...(invalidAncestor ? ["deep"] : []),
      ".git",
    );
    const contents = `gitdir: ${join(foreign.root, ".git")}\n`;
    let launches = 0;
    const bookkeeping: string[][] = [];
    const outcome = await runWorkflow(["patch", "Synthetic issue", "--json"], {
      currentDirectory: selected.root,
      onRepositoryCommand: (command, args, cwd, options) => {
        if (
          launches > 0 &&
          args.some((value) =>
            ["add", "read-tree", "update-index", "write-tree"].includes(value),
          )
        )
          bookkeeping.push([...args]);
        return runGitRepositoryCommand(command, args, cwd, options);
      },
      onCodex: async (_args, output) => {
        launches++;
        await writeFile(join(selected.root, "app.ts"), "after\n");
        await writeFile(marker, contents);
        output?.stdout.write("Synthetic patch complete.\n");
        return 0;
      },
    });
    expect(outcome.exitCode, outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain(
      "Git metadata outside the pre-patch administration directories",
    );
    expect(launches).toBe(1);
    expect(bookkeeping).toEqual([]);
    expect(selected.git("rev-parse", "HEAD")).toBe(selectedHead);
    expect(await readFile(join(selected.root, ".git", "index"))).toEqual(
      selectedIndex,
    );
    expect(foreign.git("rev-parse", "HEAD")).toBe(foreignHead);
    expect(await readFile(join(foreign.root, ".git", "index"))).toEqual(
      foreignIndex,
    );
    expect(await readFile(marker, "utf8")).toBe(contents);
    expect(await readFile(join(selected.root, "app.ts"), "utf8")).toBe(
      "after\n",
    );
  },
);
