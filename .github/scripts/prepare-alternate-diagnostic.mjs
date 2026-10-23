import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const [rootInput, outputInput, ...flags] = process.argv.slice(2);
assert.ok(rootInput && outputInput);
const modeIndex = flags.indexOf("--mode");
assert.ok(modeIndex >= 0);
const mode = flags[modeIndex + 1];
assert.ok(mode === "snapshot" || mode === "coordinator");
const run = flags.includes("--run");
assert.equal(flags.length, run ? 3 : 2);
const root = resolve(rootInput);
const output = resolve(outputInput);
const relativeSource =
  mode === "snapshot"
    ? "sdk/typescript/tests-ts/cli-patch-snapshot-context.test.ts"
    : "sdk/typescript/tests-ts/cli-patch-alternate-objects.test.ts";
const sourcePath = join(root, relativeSource);
const source = await readFile(sourcePath, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const expectedSourceSha256 =
  mode === "snapshot"
    ? "74ed3a0a570224f07e1c1a379b576a6dfc5da3a8d2d7053c743b43c77e74fbce"
    : "91c7141db20bd2fe310da518e2fb8a3030aa0c731f1dce06462640f10f3aa049";
assert.equal(sha256(source), expectedSourceSha256);
await mkdir(output, { recursive: true });

let originalFixture = source;
if (mode === "snapshot") {
  const start = source.indexOf('test.each([\n  ...[\n    "GIT_CONFIG_GLOBAL",');
  const end = source.indexOf('\ntest.each([\n  "stored credentials",', start);
  const prefixEnd = source.indexOf("\ntest\n");
  assert.ok(start >= 0 && end > start && prefixEnd > 0);
  originalFixture =
    source.slice(0, prefixEnd) + "\n" + source.slice(start, end);
}
let generated = originalFixture;
const insert = (before, after) => {
  assert.equal(generated.split(before).length, 2, "Insertion point changed");
  generated = generated.replace(before, after);
};

if (mode === "snapshot") {
  insert(
    "    const trees: string[] = [];\n",
    `    const trees: string[] = [];
    const diagnosticCommands: Record<string, unknown>[] = [];
    let diagnosticReadOnlyPaths: readonly string[] = [];
`,
  );
  insert(
    "        expect(trees).toEqual([]);\n",
    `        expect(trees).toEqual([]);
        diagnosticReadOnlyPaths = output!.appServer!.permissions!.readOnlyPaths;
`,
  );
  insert(
    `        const result = await runRepositoryCommand(command, args, cwd, {
          ...options,
          environment: { ...environment, ...options?.environment },
        });
        if (args.includes("write-tree")) trees.push(result.trim());
        return result;`,
    `        const bindingNames = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
          "GIT_CONFIG_NOSYSTEM", "GIT_INDEX_FILE", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
          "HOME", "USERPROFILE", "XDG_CONFIG_HOME"];
        const diagnostic: Record<string, unknown> = {
          command, args: [...args], cwd,
          sandbox: options?.sandbox === undefined ? null : {
            directory: options.sandbox.directory,
            gitEnvironment: Object.fromEntries(bindingNames.map((name) => [name,
              options.sandbox!.gitEnvironment?.[name] ?? null])),
            profile: options.sandbox.profile,
          },
          stderr: "",
        };
        diagnosticCommands.push(diagnostic);
        try {
          const result = await runRepositoryCommand(command, args, cwd, {
            ...options,
            environment: { ...environment, ...options?.environment },
            onStderr(chunk) {
              diagnostic.stderr = String(diagnostic.stderr) + chunk.toString();
              options?.onStderr?.(chunk);
            },
          });
          diagnostic.completed = true;
          if (args.includes("write-tree")) {
            diagnostic.tree = result.trim();
            trees.push(result.trim());
          }
          return result;
        } catch (error) {
          diagnostic.completed = false;
          diagnostic.error = String(error);
          diagnostic.errorCode = (error as NodeJS.ErrnoException).code ?? null;
          throw error;
        }`,
  );
  insert(
    '    expect(await readFile(join(repository, "data"), "utf8")).toBe(\n',
    `    await writeFile(join(${JSON.stringify(output)}, "snapshot-" + filtered + ".json"),
      JSON.stringify({ selector, state, filtered, sourceSha256: ${JSON.stringify(expectedSourceSha256)},
        repository, pool, originalAlternateBinding: environment[selector],
        readOnlyPaths: diagnosticReadOnlyPaths, commands: diagnosticCommands, trees,
        outcome: { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr },
      }, null, 2) + "\\n").catch((error) => console.error(error));
    expect(await readFile(join(repository, "data"), "utf8")).toBe(\n`,
  );
} else {
  insert(
    'import { execFileSync } from "node:child_process";',
    'import { execFileSync, spawnSync } from "node:child_process";',
  );
  insert("  mkdir,\n", "  lstat,\n  mkdir,\n  readlink,\n");
  insert(
    "  expected.push(pool);\n",
    `  expected.push(pool);
  if (mode === "directory link parent traversal") {
    const alias = join(support, "alias");
    const raw = alias + sep + ".." + sep + "pool";
    const physicalPool = join(support, "physical", "pool");
    const observations: Record<string, unknown>[] = [];
    const record = async (operation: string, path: string, action: () => Promise<unknown>) => {
      try { observations.push({ operation, path, result: await action() }); }
      catch (error) { observations.push({ operation, path, error: String(error),
        code: (error as NodeJS.ErrnoException).code ?? null }); }
    };
    for (const [label, path] of [["alias", alias], ["raw", raw],
      ["physical", physicalPool], ["lexical", fixture.pool]] as const) {
      await record(label + ":lstat", path, async () => {
        const value = await lstat(path, { bigint: true });
        return { dev: String(value.dev), ino: String(value.ino), mode: String(value.mode),
          isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() };
      });
      await record(label + ":realpath", path, () => realpath(path));
      if (label === "alias") await record("alias:readlink", path, () => readlink(path));
    }
    const commands: Record<string, unknown>[] = [];
    for (const [label, binding] of [["original", value], ["physical", quoted(physicalPool)],
      ["lexical", quoted(fixture.pool)]] as const) {
      for (const args of [["-c", "core.quotePath=false", "count-objects", "-v"],
        ["cat-file", "-p", fixture.object]]) {
        const command = { label, binding, args, cwd };
        try {
          const result = spawnSync("git", args, { cwd,
            env: { ...environment, GIT_ALTERNATE_OBJECT_DIRECTORIES: binding },
            encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          commands.push({ ...command, status: result.status, signal: result.signal,
            stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
        } catch (error) {
          const failure = error as Error & { status?: number; signal?: string;
            stdout?: string; stderr?: string };
          commands.push({ ...command, status: failure.status ?? null,
            signal: failure.signal ?? null, stdout: failure.stdout ?? null,
            stderr: failure.stderr ?? null, error: String(error) });
        }
      }
    }
    await writeFile(join(${JSON.stringify(output)}, "coordinator-paths.json"),
      JSON.stringify({ sourceSha256: ${JSON.stringify(expectedSourceSha256)},
        root, support, object: fixture.object, originalAlternateBinding: value,
        observations, commands }, null, 2) + "\\n").catch((error) => console.error(error));
  }
`,
  );
}

const scratchPath = join(
  dirname(sourcePath),
  `alternate-${mode}-diagnostic.test.ts`,
);
await writeFile(scratchPath, generated, { flag: "wx" });
await writeFile(join(output, "fixture-original.ts"), originalFixture);
await writeFile(join(output, "fixture-generated.ts"), generated);
const sourceHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const namePattern =
  mode === "snapshot"
    ? "^native no-op snapshots preserve coordinator Git configuration: .*GIT_ALTERNATE_OBJECT_DIRECTORIES"
    : "^patch grants caller-selected alternate objects: directory link parent traversal$";
// run-ci-tests.mts gives Windows cases 120 seconds; the snapshot fixture keeps
// its original explicit 180-second timeout, which overrides this default.
const args = [
  "test",
  "--timeout",
  "120000",
  "--seed",
  mode === "snapshot" ? "14577" : "14579",
  "--test-name-pattern",
  namePattern,
  scratchPath,
];
const receipt = {
  mode,
  sourceHead,
  sourcePath,
  sourceSha256: expectedSourceSha256,
  scratchPath,
  scratchSha256: sha256(generated),
  originalFixtureSha256: sha256(originalFixture),
  command: ["bun", ...args],
  cases:
    mode === "snapshot"
      ? [
          'native no-op snapshots preserve coordinator Git configuration: {"selector":"GIT_ALTERNATE_OBJECT_DIRECTORIES","state":"set","filtered":false}',
          'native no-op snapshots preserve coordinator Git configuration: {"selector":"GIT_ALTERNATE_OBJECT_DIRECTORIES","state":"set","filtered":true}',
        ]
      : [
          "patch grants caller-selected alternate objects: directory link parent traversal",
        ],
  instrumentation:
    mode === "snapshot"
      ? "Existing command argv, fixture-owned bindings, profile, readonly paths, stderr and outcome; no added native commands or permission entries."
      : "Supplemental owner-side path metadata and Git reads before the original assertion; original binding, fixture, assertions and workflow remain intact.",
  qualification:
    "Diagnostic scratch only; no full inherited environment capture or runtime adoption.",
};
await writeFile(
  join(output, "preparation-receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt, null, 2));
if (run) {
  assert.equal(process.platform, "win32");
  const result = spawnSync("bun", args, {
    cwd: join(root, "sdk/typescript"),
    stdio: "inherit",
    env: process.env,
  });
  await writeFile(
    join(output, "execution-receipt.json"),
    JSON.stringify(
      {
        ...receipt,
        exitCode: result.status,
        signal: result.signal,
        error: result.error?.message,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = result.status ?? 1;
}
