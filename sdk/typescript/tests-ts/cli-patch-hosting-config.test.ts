import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createTemporaryDirectories } from "./support/temporary-directories.js";
import {
  publicationRepository,
  runGitRepositoryCommand,
  runWorkflow,
} from "./cli-patch-fixtures.js";

const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);

test.each([
  "home",
  "xdg",
  "explicit",
  "empty explicit",
  ...(process.platform === "win32" ? ["appdata", "mixed case"] : []),
])("preserves gh configuration after caller removal: %s", async (kind) => {
  const { directory, git } = await publicationRepository(fixtures);
  const caller = join(directory, "component");
  await mkdir(caller);
  await writeFile(join(caller, "app.ts"), "before\n");
  git("add", ".");
  git("commit", "-m", "Synthetic caller baseline");
  const support = await fixtures.create("patch-gh-configuration-");
  const home = join(support, "home");
  const config =
    kind === "home"
      ? join(home, ".config", "gh")
      : kind === "appdata"
        ? join(support, "GitHub CLI")
        : kind === "explicit"
          ? join(support, "explicit")
          : join(support, "gh");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "config.yml"), "prompt: disabled\n");
  const environment: NodeJS.ProcessEnv = {
    GH_CONFIG_DIR: kind === "empty explicit" ? "" : undefined,
    GLAB_CONFIG_DIR: undefined,
    XDG_CONFIG_HOME: undefined,
    AppData: undefined,
    HOME: relative(caller, home),
    USERPROFILE: relative(caller, home),
    GIT_CONFIG_GLOBAL: join(support, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if (kind === "appdata") environment["AppData"] = relative(caller, support);
  else if (kind !== "home") {
    environment["XDG_CONFIG_HOME"] = relative(caller, support);
    if (kind === "explicit")
      environment["GH_CONFIG_DIR"] = relative(caller, config);
    if (kind === "mixed case") {
      delete environment["XDG_CONFIG_HOME"];
      environment["xdg_config_home"] = relative(caller, support);
    }
  }
  let removed = false;
  let readsAfterRemoval = 0;
  const outcome = await runWorkflow(
    ["patch", "Synthetic issue", "--create-pr", "--json"],
    {
      currentDirectory: caller,
      environment,
      onRepositoryCommand: async (command, args, cwd, options) => {
        if (command === "git")
          return runGitRepositoryCommand(command, args, cwd, options);
        if (removed) {
          readsAfterRemoval++;
          expect(options?.environment?.["GH_CONFIG_DIR"]).toBe(config);
          expect(
            await readFile(
              join(options!.environment!["GH_CONFIG_DIR"]!, "config.yml"),
              "utf8",
            ),
          ).toBe("prompt: disabled\n");
        }
        return args[1] === "create"
          ? "https://github.example.test/example/repository/pull/1"
          : "[]";
      },
      onCodex: async (_args, output) => {
        await rm(caller, { recursive: true });
        removed = true;
        output?.stdout.write("Synthetic patch complete.\n");
        return 0;
      },
    },
  );
  expect(outcome.exitCode, outcome.stderr).toBe(0);
  expect(readsAfterRemoval).toBeGreaterThan(0);
});
