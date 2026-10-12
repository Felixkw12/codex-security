import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

test.each([
  { scope: "root", siblingOnly: false, literal: false },
  { scope: "component", siblingOnly: false, literal: false },
  { scope: "component", siblingOnly: true, literal: true },
])(
  "assesses and publishes ignored siblings from $scope (only sibling: $siblingOnly, literal: $literal)",
  async ({ scope, siblingOnly, literal }) => {
    const { directory, git, remote } = await publicationRepository(fixtures);
    const component = join(directory, "component");
    await mkdir(component);
    await writeFile(join(component, "app.ts"), "original\n");
    await writeFile(join(directory, "unrelated.txt"), "unchanged\n");
    await writeFile(
      join(directory, ".gitignore"),
      "generated.txt\nlocal-cache.txt\n",
    );
    await writeFile(
      join(directory, "local-cache.txt"),
      "Local cached content\n",
    );
    const support = await fixtures.create("patch-component-filter-");
    const filter = join(support, "clean.cjs");
    await writeFile(
      filter,
      'process.stdout.write(require("node:fs").readFileSync(0,"utf8").toUpperCase());\n',
    );
    git(
      "config",
      "filter.synthetic.clean",
      `node ${JSON.stringify(filter.replaceAll("\\", "/"))}`,
    );
    git("config", "filter.synthetic.required", "true");
    await writeFile(
      join(directory, ".gitattributes"),
      "component/app.ts filter=synthetic\n",
    );
    git("add", ".");
    git("commit", "-m", "Synthetic component snapshot baseline");
    const caller = scope === "root" ? directory : component;
    const environment = literal ? { GIT_LITERAL_PATHSPECS: "1" } : {};
    let assessments = 0;
    let pushes = 0;
    let streamedBlobs = 0;
    const expectedFiles = siblingOnly
      ? ["generated.txt"]
      : ["component/app.ts", "generated.txt"];
    const outcome = await runWorkflow(
      [
        "patch",
        "Synthetic issue",
        "--assess-patch-risk",
        "--create-pr",
        "--json",
      ],
      {
        currentDirectory: caller,
        environment,
        onRepositoryCommand: (command, args, cwd, options) => {
          if (command !== "git")
            return args[1] === "list"
              ? "[]"
              : "https://github.example.test/example/repository/pull/1";
          if (args[0] === "push") {
            pushes++;
            return "";
          }
          if (args[0] === "cat-file" && options?.onStdout !== undefined) {
            streamedBlobs++;
            expect(options.directory).toBe(caller);
            expect(options.environment?.["GIT_WORK_TREE"]).toBe(directory);
            return runRepositoryCommand(command, args, cwd, options);
          }
          return runGitRepositoryCommand(command, args, cwd, {
            ...options,
            environment: { ...environment, ...options?.environment },
          });
        },
        onCodex: async (_args, output) => {
          if (output!.appServer!.prompt.includes("immutable patch artifact")) {
            assessments++;
            const artifact = JSON.parse(
              output!
                .appServer!.prompt.split("\n")
                .find((line) => line.startsWith('{"path":'))!,
            );
            expect(artifact.changedFiles).toEqual(expectedFiles);
            const verification = await fixtures.create(
              "patch-component-assessment-",
            );
            const verify = repositoryGit(verification);
            verify(
              "clone",
              "-c",
              "core.autocrlf=false",
              "--no-hardlinks",
              directory,
              ".",
            );
            verify("apply", "--check", artifact.path);
            verify("apply", artifact.path);
            expect(
              await readFile(join(verification, "generated.txt"), "utf8"),
            ).toBe("generated fix\n");
            expect(
              await readFile(join(verification, "component/app.ts"), "utf8"),
            ).toBe(siblingOnly ? "ORIGINAL\n" : "FIXED\n");
            output!.stdout.write(patchRiskAssessment().report);
          } else {
            expect(output!.appServer!.directory).toBe(caller);
            await writeFile(
              join(directory, "generated.txt"),
              "generated fix\n",
            );
            git("add", "-f", "generated.txt");
            if (!siblingOnly)
              await writeFile(join(component, "app.ts"), "fixed\n");
            output!.stdout.write("Synthetic patch complete.\n");
          }
          return 0;
        },
      },
    );
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(assessments).toBe(1);
    expect(pushes).toBe(1);
    expect(streamedBlobs).toBe(expectedFiles.length);
    expect(git("show", "HEAD:generated.txt")).toBe("generated fix");
    expect(git("show", "HEAD:component/app.ts")).toBe(
      siblingOnly ? "ORIGINAL" : "FIXED",
    );
    expect(git("show", "HEAD:unrelated.txt")).toBe("unchanged");
    expect(await readFile(join(directory, "local-cache.txt"), "utf8")).toBe(
      "Local cached content\n",
    );
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(repositoryGit(remote)("for-each-ref", "--format=%(refname)")).toBe(
      "",
    );
  },
);

test.each(["absolute", "relative", "relative configuration"])(
  "prepares saved component publication with %s Git settings",
  async (mode) => {
    const { directory, git, remote } = await publicationRepository(fixtures);
    const component = join(directory, "component");
    await mkdir(component);
    await writeFile(join(component, "app.ts"), "original\n");
    await writeFile(
      join(component, "settings"),
      "[synthetic]\n marker=component\n",
    );
    await writeFile(join(directory, "settings"), "[synthetic]\n marker=root\n");
    git("add", ".");
    git("commit", "-m", "Synthetic saved component baseline");
    const environment: NodeJS.ProcessEnv = {
      GIT_DIR: mode === "absolute" ? join(directory, ".git") : "../.git",
      GIT_WORK_TREE: mode === "absolute" ? directory : "..",
      ...(mode === "relative configuration"
        ? { GIT_CONFIG_GLOBAL: "settings" }
        : {}),
    };
    const configured =
      mode === "relative configuration"
        ? runGitRepositoryCommand(
            "git",
            ["config", "--get", "synthetic.marker"],
            component,
            { environment },
          )
        : undefined;
    const result = resultWithFindings(["high"]);
    result.findings.findings[0]!.locations[0]!.path = "app.ts";
    let patches = 0;
    let pushes = 0;
    const outcome = await runWorkflow(
      ["patch", "--scan", "scan-1", "--create-pr", "--json"],
      {
        currentDirectory: component,
        environment,
        onWorkbench: () => savedScan(result, "scan-1", component),
        onRepositoryCommand: (command, args, cwd, options) => {
          const context = {
            ...options,
            environment: { ...environment, ...options?.environment },
          };
          if (command !== "git") {
            if (configured !== undefined)
              expect(
                runGitRepositoryCommand(
                  "git",
                  ["config", "--get", "synthetic.marker"],
                  cwd,
                  context,
                ),
              ).toBe(configured);
            return args[1] === "list"
              ? "[]"
              : "https://github.example.test/example/repository/pull/1";
          }
          if (args[0] === "push") {
            pushes++;
            return "";
          }
          return runGitRepositoryCommand(command, args, cwd, context);
        },
        onCodex: async (_args, output) => {
          patches++;
          expect(output!.appServer!.directory).toBe(component);
          await writeFile(join(component, "app.ts"), "fixed\n");
          output!.stdout.write(
            JSON.stringify({
              patches: [
                {
                  occurrenceId: "occ_1",
                  status: "verified",
                  files: ["app.ts"],
                  verification: "Synthetic component check.",
                },
              ],
            }),
          );
          return 0;
        },
      },
    );
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(patches).toBe(1);
    expect(pushes).toBe(1);
    expect(git("show", "HEAD:component/app.ts")).toBe("fixed");
    expect(git("show", "HEAD:settings")).toContain("marker=root");
    expect(git("show", "HEAD:component/settings")).toContain(
      "marker=component",
    );
    expect(repositoryGit(remote)("for-each-ref", "--format=%(refname)")).toBe(
      "",
    );
  },
);

for (const raw of [false, true]) {
  test.skipIf(raw && process.platform !== "linux").each([false, true])(
    `inline assessment retains ${raw ? "raw-byte" : "ordinary"} filename edits (mixed: %p)`,
    async (mixed) => {
      const { directory, git } = await publicationRepository(fixtures);
      const component = join(directory, "component");
      await mkdir(component);
      const name = raw
        ? Buffer.concat([
            Buffer.from("component/name-"),
            Buffer.from([0xff]),
            Buffer.from(".ts"),
          ])
        : Buffer.from("component/ordinary.ts");
      const path = Buffer.concat([Buffer.from(`${directory}/`), name]);
      const alias = "component/name-\ufffd.ts";
      await writeFile(path, "original\n");
      await writeFile(join(directory, alias), "untouched alias\n");
      git("add", ".");
      git("commit", "-m", "Synthetic byte-path assessment baseline");
      const head = git("rev-parse", "HEAD");
      const index = await readFile(join(directory, ".git/index"));
      let assessments = 0;
      const outcome = await runWorkflow(
        ["patch", "Synthetic issue", "--assess-patch-risk", "--json"],
        {
          currentDirectory: component,
          onRepositoryCommand: runGitRepositoryCommand,
          onCodex: async (_args, output) => {
            if (
              output!.appServer!.prompt.includes("immutable patch artifact")
            ) {
              assessments++;
              const artifact = JSON.parse(
                output!
                  .appServer!.prompt.split("\n")
                  .find((line) => line.startsWith('{"path":'))!,
              );
              const verification = await fixtures.create(
                "patch-byte-assessment-",
              );
              const verify = repositoryGit(verification);
              verify(
                "clone",
                "-c",
                "core.autocrlf=false",
                "--no-hardlinks",
                directory,
                ".",
              );
              verify("apply", "--check", artifact.path);
              verify("apply", artifact.path);
              expect(
                await readFile(
                  Buffer.concat([Buffer.from(`${verification}/`), name]),
                  "utf8",
                ),
              ).toBe("fixed\n");
              expect(await readFile(join(verification, alias), "utf8")).toBe(
                "untouched alias\n",
              );
              expect(
                await readFile(join(verification, "src/finding-1.ts"), "utf8"),
              ).toBe(mixed ? "other fix\n" : "original\n");
              output!.stdout.write(patchRiskAssessment().report);
            } else {
              expect(output!.appServer!.directory).toBe(component);
              await writeFile(path, "fixed\n");
              if (mixed)
                await writeFile(
                  join(directory, "src/finding-1.ts"),
                  "other fix\n",
                );
              output!.stdout.write("Synthetic byte-path patch.\n");
            }
            return 0;
          },
        },
      );
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      expect(assessments).toBe(1);
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(await readFile(join(directory, ".git/index"))).toEqual(index);
      expect(await readFile(join(directory, alias), "utf8")).toBe(
        "untouched alias\n",
      );
    },
  );
}
