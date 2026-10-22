import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const [rootInput, outputInput, ...flags] = process.argv.slice(2);
if (!rootInput || !outputInput)
  throw new Error(
    "Usage: node prepare-diagnostic.mjs REPOSITORY OUTPUT_DIRECTORY [--sibling] [--run]",
  );
if (flags.some((flag) => !["--sibling", "--run"].includes(flag)))
  throw new Error("Unknown diagnostic script option.");
const root = resolve(rootInput);
const output = resolve(outputInput);
const sourcePath = join(
  root,
  "sdk/typescript/tests-ts/cli-patch-snapshot-context.test.ts",
);
const original = await readFile(sourcePath, "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const sourceSha256 = sha256(original);
if (
  ![
    "beab8e476a1f24fd4e1af5dbdbf377170cdd2b3516fade87139a347048151ef4",
    "4e1c52f04ff0eacb05572754b96e6452ceebb6381065aa58107b94e7256503da",
  ].includes(sourceSha256)
)
  throw new Error(
    "Source differs from the reviewed published patch-stack fixtures.",
  );
const fixtureStart = original.indexOf(
  'test.each([\n  ...[\n    "GIT_CONFIG_GLOBAL",',
);
const fixtureEnd = original.indexOf(
  '\ntest.each([\n  "stored credentials",',
  fixtureStart,
);
if (fixtureStart < 0 || fixtureEnd < 0)
  throw new Error("Fixture boundaries changed.");
let fixture = original.slice(fixtureStart, fixtureEnd);
const replaceOnce = (before, after) => {
  if (fixture.split(before).length !== 2)
    throw new Error("Diagnostic insertion point changed.");
  fixture = fixture.replace(before, after);
};
replaceOnce(
  '])(\n  "native no-op snapshots',
  `].filter(({ selector, state, filtered }) =>
  (selector === "GIT_CONFIG_GLOBAL" && state === "set") ||
  (selector === "GIT_CONFIG_NOSYSTEM" && state === "empty" && filtered) ||
  (selector === "GIT_ALTERNATE_OBJECT_DIRECTORIES" && state === "set" && !filtered),
))(\n  "native no-op snapshots`,
);
replaceOnce(
  "    const trees: string[] = [];\n",
  `    const trees: string[] = [];
    const diagnosticCommands: Record<string, unknown>[] = [];
    let diagnosticReadOnlyPaths: readonly string[] = [];
`,
);
replaceOnce(
  "        expect(trees).toEqual([]);\n",
  `        expect(trees).toEqual([]);
        diagnosticReadOnlyPaths = output!.appServer!.permissions!.readOnlyPaths;
`,
);
replaceOnce(
  '        expect(trees).toEqual([git("rev-parse", "HEAD^{tree}")]);',
  `        try {
          expect(trees).toEqual([git("rev-parse", "HEAD^{tree}")]);
        } catch (error) {
          console.error("Snapshot tree boundary diagnostic: " + JSON.stringify({
            selector, state, filtered, readOnlyPaths: diagnosticReadOnlyPaths,
            commands: diagnosticCommands, trees,
          }));
          throw error;
        }`,
);
replaceOnce(
  `        const result = await runRepositoryCommand(command, args, cwd, {
          ...options,
          environment: { ...environment, ...options?.environment },
        });
        if (args.includes("write-tree")) trees.push(result.trim());
        return result;`,
  `        // This local-only probe records fixture-owned bindings, not inherited env.
        const bindingNames = ["GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
          "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
          "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_INDEX_FILE",
          "GIT_ATTR_SOURCE", "GIT_ATTR_NOSYSTEM", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
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
          diagnostic.errorCode = (error as NodeJS.ErrnoException).code ?? null;
          throw error;
        }`,
);
replaceOnce(
  '    expect(await readFile(join(repository, "data"), "utf8")).toBe(\n',
  `    await writeFile(join(${JSON.stringify(output)}, selector + "-" + state + "-" + filtered + ".json"),
      JSON.stringify({ selector, state, filtered, sourceSha256: ${JSON.stringify(sourceSha256)},
        repository, readOnlyPaths: diagnosticReadOnlyPaths, commands: diagnosticCommands,
        trees, outcome: { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr },
      }, null, 2) + "\\n");
    expect(await readFile(join(repository, "data"), "utf8")).toBe(\n`,
);
const prefix = original.slice(0, original.indexOf("\ntest\n"));
const require = createRequire(join(root, "sdk/typescript/package.json"));
let generated = prefix + "\n" + fixture + "\n";
generated = generated.replace(/from "([^"\n]+)"/g, (match, specifier) => {
  if (specifier.startsWith("node:") || specifier === "bun:test") return match;
  const resolved = specifier.startsWith(".")
    ? resolve(dirname(sourcePath), specifier)
    : require.resolve(specifier);
  return `from ${JSON.stringify(pathToFileURL(resolved).href)}`;
});
await mkdir(output, { recursive: true });
const scratchPath = join(
  flags.includes("--sibling") ? dirname(sourcePath) : output,
  "snapshot-boundary-diagnostic.test.ts",
);
await writeFile(scratchPath, generated, { flag: "wx" });
const receipt = {
  sourcePath,
  sourceSha256,
  sourceHead: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  scratchPath,
  scratchSha256: sha256(generated),
  cases: [
    "GLOBAL/set/filtered:true",
    "GLOBAL/set/filtered:false",
    "NOSYSTEM/empty/filtered:true",
    "ALTERNATE_OBJECT_DIRECTORIES/set/filtered:false",
  ],
  instrumentation:
    "Existing command argv, fixture-owned Git bindings, profile, readonly paths, successful and failed command stderr; no additional Git commands; all original assertions retained.",
  qualifications:
    "Diagnostic scratch only. Does not edit repository source or change native permissions. No complete inherited environment is recorded.",
};
await writeFile(
  join(output, "preparation-receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt, null, 2));
if (flags.includes("--run")) {
  const args = ["test", "--timeout", "180000", scratchPath];
  const result = spawnSync("bun", args, {
    cwd: join(root, "sdk/typescript"),
    stdio: "inherit",
    env: process.env,
  });
  await writeFile(
    join(output, "execution-receipt.json"),
    JSON.stringify(
      {
        command: ["bun", ...args],
        sourceHead: receipt.sourceHead,
        sourceSha256,
        scratchSha256: receipt.scratchSha256,
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
