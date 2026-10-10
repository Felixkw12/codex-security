import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectories } from "./support/temporary-directories.js";
import { runGitRepositoryCommand, runWorkflow } from "./cli-patch-fixtures.js";

const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);

test.each([
  "missing selector",
  "existing selector",
  "replace effective config",
] as const)(
  "patch inventories effective configuration with GIT_CONFIG: %s",
  async (mode) => {
    const root = await fixtures.create("patch-config-selector-");
    const support = await fixtures.create("patch-config-selector-support-");
    const globalConfig = join(support, "empty-global");
    await writeFile(globalConfig, "");
    const baseEnvironment = {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        env: { ...process.env, ...baseEnvironment },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "--initial-branch=main");
    git("config", "user.name", "Synthetic User");
    git("config", "user.email", "synthetic@example.test");
    const source = join(root, "app.ts");
    const selector = join(root, "selector-settings");
    const effectiveConfig = join(root, "effective-settings");
    const hooks = join(root, "operator-hooks");
    const hook = join(hooks, "post-index-change");
    const effect = join(support, "effect");
    await mkdir(hooks);
    const shellPath = `'${effect.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    const script = `#!/bin/sh\nprintf effect >> ${shellPath}\n`;
    await writeFile(hook, script, { mode: 0o755 });
    const configuration = `[core]\n hooksPath = ${JSON.stringify(hooks.replaceAll("\\", "/"))}\n`;
    await writeFile(effectiveConfig, configuration);
    await writeFile(source, "before\n");
    const selectorText = "[synthetic]\n value = ordinary selector data\n";
    if (mode !== "missing selector") await writeFile(selector, selectorText);
    git("add", ".");
    git("commit", "-m", "Synthetic selector baseline");
    git("config", "include.path", "../effective-settings");
    git("update-index", "--assume-unchanged", "app.ts");
    git("update-index", "--no-assume-unchanged", "app.ts");
    expect(await readFile(effect, "utf8")).toContain("effect");
    await unlink(effect);
    const head = git("rev-parse", "HEAD");
    const index = await readFile(join(root, ".git", "index"));
    const localConfig = await readFile(join(root, ".git", "config"));
    const environment = {
      ...baseEnvironment,
      GIT_CONFIG: selector,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.quotePath",
      GIT_CONFIG_VALUE_0: "false",
    };
    const calls: {
      args: string[];
      environment: NodeJS.ProcessEnv;
      afterTurn: boolean;
    }[] = [];
    let launches = 0;
    let controls: readonly string[] = [];
    let effectsBefore = "";
    const outcome = await runWorkflow(["patch", "Synthetic issue", "--json"], {
      currentDirectory: root,
      environment,
      onRepositoryCommand: (command, args, cwd, options) => {
        const effectiveEnvironment = {
          ...environment,
          ...options?.environment,
        };
        calls.push({
          args: [...args],
          environment: effectiveEnvironment,
          afterTurn: launches > 0,
        });
        return runGitRepositoryCommand(command, args, cwd, {
          ...options,
          environment: effectiveEnvironment,
        });
      },
      onCodex: async (_args, output, childEnvironment) => {
        launches++;
        controls = output?.appServer?.permissions?.readOnlyPaths ?? [];
        expect(childEnvironment?.["GIT_CONFIG"]).toBe(selector);
        expect(childEnvironment?.["GIT_CONFIG_COUNT"]).toBe("1");
        expect(childEnvironment?.["GIT_CONFIG_KEY_0"]).toBe("core.quotePath");
        expect(childEnvironment?.["GIT_CONFIG_VALUE_0"]).toBe("false");
        effectsBefore = await readFile(effect, "utf8").catch(() => "");
        await writeFile(source, "after\n");
        if (mode === "existing selector") {
          await writeFile(
            `${selector}.replacement`,
            "[synthetic]\n value = edited ordinary data\n",
          );
          await rename(`${selector}.replacement`, selector);
        } else if (mode === "replace effective config") {
          await writeFile(
            `${effectiveConfig}.replacement`,
            `${configuration}[synthetic]\n value = changed configuration\n`,
          );
          await rename(`${effectiveConfig}.replacement`, effectiveConfig);
        }
        output?.stdout.write("Synthetic patch complete.\n");
        return 0;
      },
    });
    expect(launches, outcome.stderr).toBe(1);
    expect(controls).toContain(join(root, ".git"));
    expect(controls).toContain(effectiveConfig);
    expect(controls).toContain(hook);
    expect(controls).not.toContain(selector);
    const inventory = calls.filter(({ args }) => args.includes("config"));
    expect(inventory.some(({ args }) => args.includes("--list"))).toBe(true);
    expect(inventory.some(({ args }) => args.includes("--get-regexp"))).toBe(
      true,
    );
    expect(inventory.some(({ args }) => args.includes("--type=path"))).toBe(
      true,
    );
    for (const call of calls) {
      expect(call.environment["GIT_CONFIG"]).toBe(
        call.args.includes("config") ? undefined : selector,
      );
      expect(call.environment["GIT_CONFIG_GLOBAL"]).toBe(globalConfig);
      expect(call.environment["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      expect(call.environment["GIT_CONFIG_COUNT"]).toBe("1");
      expect(call.environment["GIT_CONFIG_KEY_0"]).toBe("core.quotePath");
      expect(call.environment["GIT_CONFIG_VALUE_0"]).toBe("false");
    }
    const effectsAfter = await readFile(effect, "utf8").catch(() => "");
    if (mode === "replace effective config") {
      expect(outcome.exitCode, outcome.stderr).toBe(2);
      expect(outcome.stderr).toContain(
        "Git configuration or hooks changed location during the patch",
      );
      expect(calls.filter(({ afterTurn }) => afterTurn)).toEqual([]);
      expect(effectsAfter).toBe(effectsBefore);
      expect(await readFile(effectiveConfig, "utf8")).toContain(
        "changed configuration",
      );
      expect(await readFile(selector, "utf8")).toBe(selectorText);
    } else {
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      expect(JSON.parse(outcome.stdout).files).toEqual([
        "app.ts",
        ...(mode === "existing selector" ? ["selector-settings"] : []),
      ]);
      expect(effectsAfter.length).toBeGreaterThan(effectsBefore.length);
      expect(await readFile(effectiveConfig, "utf8")).toBe(configuration);
      if (mode === "missing selector")
        await expect(readFile(selector)).rejects.toHaveProperty(
          "code",
          "ENOENT",
        );
      else
        expect(await readFile(selector, "utf8")).toBe(
          "[synthetic]\n value = edited ordinary data\n",
        );
    }
    expect(environment.GIT_CONFIG).toBe(selector);
    expect(await readFile(source, "utf8")).toBe("after\n");
    expect(await readFile(hook, "utf8")).toBe(script);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(join(root, ".git", "config"))).toEqual(localConfig);
  },
);
