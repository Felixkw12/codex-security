import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createTemporaryDirectories } from "./support/temporary-directories.js";
import {
  repositoryGit,
  runGitRepositoryCommand,
  runWorkflow,
} from "./cli-patch-fixtures.js";

const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);

test.each([
  { mode: "default", outside: false, replace: false, rootHook: false },
  { mode: "relative", outside: false, replace: false, rootHook: false },
  { mode: "absolute", outside: false, replace: false, rootHook: false },
  { mode: "relative", outside: true, replace: false, rootHook: false },
  { mode: "relative", outside: false, replace: true, rootHook: false },
  { mode: "relative", outside: true, replace: false, rootHook: true },
  { mode: "relative", outside: true, replace: true, rootHook: true },
])(
  "binds $mode hooks to their execution worktree (root hook: $rootHook, outside cwd: $outside, replaced: $replace)",
  async ({ mode, outside, replace, rootHook }) => {
    const root = await fixtures.create("patch-hook-selected-");
    const foreign = await fixtures.create("patch-hook-unselected-");
    const support = await fixtures.create("patch-hook-support-");
    const nested = join(root, "nested");
    await mkdir(nested);
    const initialize = async (directory: string) => {
      const git = repositoryGit(directory);
      git("init", "--initial-branch=main");
      git("config", "user.name", "Synthetic User");
      git("config", "user.email", "synthetic@example.test");
      await writeFile(join(directory, "app.txt"), "before\n");
      git("add", ".");
      git("commit", "-m", "Synthetic hook baseline");
      return git;
    };
    const nestedGit = await initialize(nested);
    const git = await initialize(root);
    const foreignGit = await initialize(foreign);
    const hookWorktree = rootHook ? root : nested;
    const hookGit = rootHook ? git : nestedGit;
    const hookDirectory =
      mode === "default"
        ? join(hookWorktree, ".git", "hooks")
        : mode === "relative"
          ? join(hookWorktree, "hooks")
          : join(support, "hooks");
    await mkdir(hookDirectory, { recursive: true });
    const hook = join(hookDirectory, "post-index-change");
    const effect = join(support, "hook-effect");
    const shellPath = `'${effect.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    const hookScript = (value: string) =>
      `#!/bin/sh\nprintf '${value}\\n' >> ${shellPath}\n`;
    await writeFile(hook, hookScript("operator"), { mode: 0o755 });
    if (mode !== "default")
      hookGit(
        "config",
        "core.hooksPath",
        mode === "relative" ? "hooks" : hookDirectory,
      );
    // All three paths identify a functional trusted hook before the patch runs.
    hookGit("update-index", "--assume-unchanged", "app.txt");
    hookGit("update-index", "--no-assume-unchanged", "app.txt");
    expect(await readFile(effect, "utf8")).toContain("operator");
    const rootHead = git("rev-parse", "HEAD");
    const nestedHead = nestedGit("rev-parse", "HEAD");
    const foreignHead = foreignGit("rev-parse", "HEAD");
    const rootIndex = await readFile(join(root, ".git", "index"));
    const nestedIndex = await readFile(join(nested, ".git", "index"));
    const foreignIndex = await readFile(join(foreign, ".git", "index"));
    const environment = outside
      ? { ...process.env, GIT_DIR: join(root, ".git"), GIT_WORK_TREE: root }
      : process.env;
    let launches = 0;
    let permissions:
      { name: string; readOnlyPaths: readonly string[] } | undefined;
    let beforeTurnEffects = "";
    const bookkeeping: string[][] = [];
    const outcome = await runWorkflow(["patch", "Synthetic issue", "--json"], {
      currentDirectory: outside ? foreign : root,
      environment,
      onRepositoryCommand: (command, args, cwd, options) => {
        if (
          launches > 0 &&
          args.some((arg) =>
            ["add", "read-tree", "update-index", "write-tree"].includes(arg),
          )
        )
          bookkeeping.push([...args]);
        return runGitRepositoryCommand(command, args, cwd, {
          ...options,
          environment: { ...environment, ...options?.environment },
        });
      },
      onCodex: async (_args, output) => {
        launches++;
        permissions = output?.appServer?.permissions;
        beforeTurnEffects = await readFile(effect, "utf8");
        if (replace) {
          await rename(hook, join(support, "original-hook"));
          await writeFile(hook, hookScript("rewritten"), { mode: 0o755 });
        }
        await writeFile(join(nested, "app.txt"), "after\n");
        output?.stdout.write("Synthetic patch complete.\n");
        return 0;
      },
    });
    expect(launches).toBe(1);
    expect(outcome.exitCode, outcome.stderr).toBe(replace ? 2 : 0);
    expect(permissions).toBeDefined();
    expect(permissions!.name).toBe("codex_security_patch");
    expect(
      permissions!.readOnlyPaths.some((path) => {
        const from = relative(path, hook);
        return (
          from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from)
        );
      }),
    ).toBe(true);
    const afterEffects = await readFile(effect, "utf8");
    if (replace) {
      expect(outcome.stderr).toContain(
        "Git configuration or hooks changed location during the patch",
      );
      expect(bookkeeping).toEqual([]);
      expect(afterEffects).toBe(beforeTurnEffects);
      expect(await readFile(hook, "utf8")).toBe(hookScript("rewritten"));
    } else {
      expect(afterEffects.length).toBeGreaterThan(beforeTurnEffects.length);
      expect(bookkeeping.length).toBeGreaterThan(0);
      expect(
        afterEffects
          .split("\n")
          .filter(Boolean)
          .every((line) => line === "operator"),
      ).toBe(true);
    }
    expect(git("rev-parse", "HEAD")).toBe(rootHead);
    expect(nestedGit("rev-parse", "HEAD")).toBe(nestedHead);
    expect(foreignGit("rev-parse", "HEAD")).toBe(foreignHead);
    expect(await readFile(join(root, ".git", "index"))).toEqual(rootIndex);
    expect(await readFile(join(nested, ".git", "index"))).toEqual(nestedIndex);
    expect(await readFile(join(foreign, ".git", "index"))).toEqual(
      foreignIndex,
    );
    expect(await readFile(join(root, "app.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(foreign, "app.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(nested, "app.txt"), "utf8")).toBe("after\n");
  },
);

// Exercise POSIX filesystem traversal through a symlink before "..".
test
  .skipIf(process.platform === "win32")
  .each(["actual-hook", "ordinary-shadow"])(
  "preserves physical symlink traversal when the model replaces %s",
  async (mutation) => {
    const root = await fixtures.create("patch-physical-hook-");
    const support = await fixtures.create("patch-physical-hook-support-");
    const hooks = join(root, "actual", "hooks");
    const actualHook = join(hooks, "post-index-change");
    const shadow = join(root, "hooks", "post-index-change");
    const effect = join(support, "hook-effect");
    const link = join(root, "link");
    await mkdir(join(root, "actual", "child"), { recursive: true });
    await mkdir(hooks);
    await mkdir(join(root, "hooks"));
    await symlink("actual/child", link);
    const shellPath = `'${effect.replaceAll("'", "'\\''")}'`;
    const script = (value: string) =>
      `#!/bin/sh\nprintf '${value}\\n' >> ${shellPath}\n`;
    await writeFile(actualHook, script("operator"), { mode: 0o755 });
    await writeFile(shadow, "ordinary source\n");
    await writeFile(join(root, "app.txt"), "before\n");
    const git = repositoryGit(root);
    git("init", "--initial-branch=main");
    git("config", "user.name", "Synthetic User");
    git("config", "user.email", "synthetic@example.test");
    git("add", ".");
    git("commit", "-m", "Synthetic physical hook baseline");
    git("config", "core.hooksPath", "link/../hooks");
    expect(
      git("rev-parse", "--path-format=absolute", "--git-path", "hooks"),
    ).toBe(hooks);
    git("update-index", "--assume-unchanged", "app.txt");
    git("update-index", "--no-assume-unchanged", "app.txt");
    expect(await readFile(effect, "utf8")).toContain("operator");
    const head = git("rev-parse", "HEAD");
    const index = await readFile(join(root, ".git", "index"));
    const actualReplacement = mutation === "actual-hook";
    // Node resolves symlink/.. physically; Bun's realpath normalizes it lexically.
    const source = `
import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capturePatchGitControls } from ${JSON.stringify(new URL("../src/patch-git-controls.ts", import.meta.url).href)};
const root = ${JSON.stringify(root)};
const controls = await capturePatchGitControls(root, async (repository, checkout, args, encoding) => {
  // Use the child adapter's relative hook query without changing its working directory.
  const query = args.length === 4 && args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-path" && args[3] === "hooks"
    ? ["rev-parse", "--git-path", "hooks"] : args;
  return execFileSync("git", query, { cwd: repository }).toString(encoding ?? "utf8");
}, true);
if (!controls) throw new Error("Synthetic repository was not discovered.");
const beforeTurnEffects = await readFile(${JSON.stringify(effect)}, "utf8");
const edited = ${JSON.stringify(actualReplacement ? actualHook : shadow)};
await rename(edited, ${JSON.stringify(join(support, "original-input"))});
await writeFile(edited, ${JSON.stringify(actualReplacement ? script("rewritten") : "edited ordinary source\n")}, { mode: ${actualReplacement ? 0o755 : 0o644} });
await writeFile(join(root, "app.txt"), "after\\n");
const bookkeeping = [];
let error;
let files = [];
try {
  await controls.validate();
  const stage = (args) => {
    bookkeeping.push(args);
    return execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_INDEX_FILE: ${JSON.stringify(join(support, "snapshot-index"))} } }).toString().trim();
  };
  stage(["read-tree", "HEAD"]);
  stage(["--literal-pathspecs", "add", "--all"]);
  const tree = stage(["write-tree"]);
  files = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD", tree], { cwd: root }).toString().split("\\0").filter(Boolean);
} catch (failure) { error = failure.message; }
process.stdout.write(JSON.stringify({ paths: controls.readOnlyPaths, error, bookkeeping, beforeTurnEffects, files }));
`;
    const result = JSON.parse(
      execFileSync(
        "node",
        ["--experimental-strip-types", "--input-type=module", "-e", source],
        { encoding: "utf8" },
      ),
    ) as {
      paths: string[];
      error?: string;
      bookkeeping: string[][];
      beforeTurnEffects: string;
      files: string[];
    };
    expect(result.paths).toContain(actualHook);
    expect(result.paths).not.toContain(shadow);
    const afterEffects = await readFile(effect, "utf8");
    if (actualReplacement) {
      expect(result.error).toContain(
        "Git configuration or hooks changed location during the patch",
      );
      expect(result.bookkeeping).toEqual([]);
      expect(afterEffects).toBe(result.beforeTurnEffects);
      expect(await readFile(actualHook, "utf8")).toBe(script("rewritten"));
      expect(await readFile(shadow, "utf8")).toBe("ordinary source\n");
    } else {
      expect(result.error).toBeUndefined();
      expect(result.files).toEqual(["app.txt", "hooks/post-index-change"]);
      expect(result.bookkeeping.length).toBeGreaterThan(0);
      expect(afterEffects.length).toBeGreaterThan(
        result.beforeTurnEffects.length,
      );
      expect(
        afterEffects
          .split("\n")
          .filter(Boolean)
          .every((line) => line === "operator"),
      ).toBe(true);
      expect(await readFile(actualHook, "utf8")).toBe(script("operator"));
      expect(await readFile(shadow, "utf8")).toBe("edited ordinary source\n");
    }
    expect(await readlink(link)).toBe("actual/child");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(join(root, "app.txt"), "utf8")).toBe("after\n");
  },
);
