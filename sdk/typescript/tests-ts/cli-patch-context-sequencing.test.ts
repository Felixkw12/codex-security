import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runRepositoryCommand } from "../src/cli.js";
import {
  patchRiskAssessment,
  publicationRepository,
  repositoryGit,
  resultWithFindings,
  runGitRepositoryCommand,
  runWorkflow,
  savedScan,
} from "./cli-patch-fixtures.js";
import { createTemporaryDirectories } from "./support/temporary-directories.js";
const fixtures = createTemporaryDirectories(true);
afterEach(fixtures.cleanup);
for (const policy of ["set", "exclude", "control"] as const) {
  for (const action of [
    "no-op",
    "edit",
    "risk",
    "publish",
    "batch",
    "batch-risk",
    "batch-publish",
  ] as const) {
    test(`prepared snapshot context preserves ${policy} filter policy for ${action}`, async () => {
      const batch = action.startsWith("batch");
      const risk = action.endsWith("risk");
      const publish = action.endsWith("publish");
      const { directory, remote } = await publicationRepository(fixtures);
      const home = await fixtures.create("patch-policy-home-");
      await chmod(home, 0o700);
      const emptyConfig = join(home, "empty.gitconfig");
      await writeFile(emptyConfig, "");
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_HOME: home,
        GIT_CONFIG: undefined,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_SYSTEM: emptyConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        SNAPSHOT_STYLE: "host",
      };
      const effective =
        policy === "set" ? "policy" : policy === "exclude" ? "unset" : "host";
      await writeFile(
        join(home, "config.toml"),
        `${process.platform === "win32" ? 'windows={sandbox="unelevated"}\n' : ""}[shell_environment_policy]\ninherit="all"\n${policy === "exclude" ? 'exclude=["SNAPSHOT_STYLE"]\n' : ""}${policy === "set" ? '[shell_environment_policy.set]\nSNAPSHOT_STYLE="policy"\n' : ""}`,
      );
      const clean = join(home, "clean.cjs");
      await writeFile(
        clean,
        'const fs=require("node:fs");process.stdout.write(fs.readFileSync(0,"utf8")+(process.env.SNAPSHOT_STYLE??"unset")+"\\n");\n',
      );
      const git = (args: string[], selected = environment) =>
        execFileSync("git", args, {
          cwd: directory,
          env: selected,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      git([
        "config",
        "filter.synthetic.clean",
        `node ${JSON.stringify(clean.replaceAll("\\", "/"))}`,
      ]);
      await writeFile(
        join(directory, ".gitattributes"),
        "data filter=synthetic\n",
      );
      await writeFile(join(directory, "data"), "Unchanged filter input\n");
      // Publication starts with an index recorded using the selected filter policy.
      const recorded = publish
        ? {
            ...environment,
            SNAPSHOT_STYLE: policy === "exclude" ? undefined : effective,
          }
        : environment;
      git(["add", "."], recorded);
      git(["commit", "-m", "Synthetic filter baseline"], recorded);
      const index = await readFile(join(directory, ".git", "index"));
      const trees: string[] = [];
      let turns = 0,
        assessments = 0;
      const outcome = await runWorkflow(
        [
          "patch",
          ...(batch ? ["--scan", "scan-1"] : ["Synthetic issue"]),
          ...(risk ? ["--assess-patch-risk"] : []),
          ...(publish ? ["--create-pr"] : []),
          "--json",
        ],
        {
          currentDirectory: directory,
          environment,
          manualCodexPreparation: true,
          onWorkbench: () =>
            savedScan(
              resultWithFindings(["high", "medium"]),
              "scan-1",
              directory,
            ),
          onRepositoryCommand: async (command, args, cwd, options) => {
            if (command !== "git")
              return args[1] === "list"
                ? "[]"
                : "https://github.example.test/example/repository/pull/1";
            const result = await runRepositoryCommand(command, args, cwd, {
              ...options,
              environment: { ...environment, ...options?.environment },
            });
            if (args.includes("write-tree")) trees.push(result.trim());
            return result;
          },
          onCodex: async (_args, output) => {
            if (
              output?.appServer?.prompt.includes("immutable patch artifact")
            ) {
              assessments++;
              const artifact = JSON.parse(
                output.appServer.prompt
                  .split("\n")
                  .find((line) => line.startsWith('{"path":'))!,
              );
              const patch = await readFile(artifact.path, "utf8");
              expect(patch).toContain("+fixed");
              expect(patch).not.toContain("diff --git a/data");
              output.stdout.write(patchRiskAssessment().report);
              return 0;
            }
            output!.appServer!.onPermissions!({
              directory,
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
            await output!.appServer!.onBeforeTurn?.();
            turns++;
            if (action !== "no-op")
              await writeFile(
                join(directory, `src/finding-${turns}.ts`),
                `fixed ${turns}\n`,
              );
            output!.stdout.write(
              batch
                ? JSON.stringify({
                    patches: [
                      {
                        occurrenceId: `occ_${turns}`,
                        status: "verified",
                        files: [`src/finding-${turns}.ts`],
                        verification: "Synthetic edit verified.",
                      },
                    ],
                  })
                : "Synthetic turn complete.\n",
            );
            return 0;
          },
        },
      );
      expect(turns, outcome.stderr).toBe(batch ? 2 : 1);
      expect(await readFile(join(directory, "data"), "utf8")).toBe(
        "Unchanged filter input\n",
      );
      if (action === "no-op") {
        expect(outcome.exitCode, outcome.stdout + outcome.stderr).toBe(2);
        expect(JSON.parse(outcome.stdout).error.code).toBe("NO_PATCH_APPLIED");
        expect(trees).toHaveLength(2);
        expect(trees[0]).toBe(trees[1]);
      } else {
        expect(outcome.exitCode, outcome.stdout + outcome.stderr).toBe(0);
        expect(JSON.parse(outcome.stdout).files).toEqual(
          batch
            ? ["src/finding-1.ts", "src/finding-2.ts"]
            : ["src/finding-1.ts"],
        );
      }
      expect(assessments).toBe(risk ? 1 : 0);
      if (publish) {
        const published = repositoryGit(remote);
        const branch = published(
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/codex-security/",
        );
        expect(published("show", `${branch}:src/finding-1.ts`)).toBe("fixed 1");
        if (batch)
          expect(published("show", `${branch}:src/finding-2.ts`)).toBe(
            "fixed 2",
          );
        expect(published("show", `${branch}:data`)).toBe(
          `Unchanged filter input\n${effective}`,
        );
      } else
        expect(await readFile(join(directory, ".git", "index"))).toEqual(index);
    }, 30_000);
  }
}

test.skipIf(process.platform === "win32")(
  "an unreadable patched file still fails required snapshotting",
  async () => {
    const { directory } = await publicationRepository(fixtures);
    const source = join(directory, "src/finding-1.ts");
    let turns = 0;
    try {
      const outcome = await runWorkflow(
        ["patch", "Synthetic issue", "--json"],
        {
          currentDirectory: directory,
          onRepositoryCommand: runGitRepositoryCommand,
          onCodex: async (_args, output) => {
            turns++;
            await writeFile(source, "fixed\n");
            await chmod(source, 0);
            output!.stdout.write("Synthetic edit complete.\n");
            return 0;
          },
        },
      );
      expect(turns).toBe(1);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stdout + outcome.stderr).toContain("Permission denied");
      await expect(readFile(source)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(source, 0o600);
    }
  },
);
