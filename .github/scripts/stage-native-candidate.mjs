import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
const runtime = process.env.DIAGNOSTIC_RUNTIME;
assert.ok(runtime === "stock" || runtime === "candidate");
const root = process.cwd();
const output = join(root, "sdk/typescript/reports/native-candidate-diagnostic");
await mkdir(output, { recursive: true });
const require = createRequire(join(root, "sdk/typescript/package.json"));
const codexPackage = require.resolve("@openai/codex/package.json");
const platformPackage = createRequire(codexPackage).resolve(
  "@openai/codex-win32-x64/package.json",
);
const manifest = JSON.parse(await readFile(codexPackage, "utf8"));
assert.equal(manifest.version, "0.163.0");
const executableDirectory = join(
  dirname(platformPackage),
  "vendor/x86_64-pc-windows-msvc/bin",
);
const command = join(executableDirectory, "codex.exe");
const launcher = resolve(dirname(codexPackage), manifest.bin.codex);
const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const before = await sha256(command);
const staged = [];
if (runtime === "candidate") {
  const candidate = join(process.env.RUNNER_TEMP, "native-candidate");
  const hashes = JSON.parse(
    await readFile(join(candidate, "executables.json"), "utf8"),
  );
  const expected = new Map(
    hashes.map(({ Path, Hash }) => [basename(Path), Hash.toLowerCase()]),
  );
  for (const name of [
    "codex",
    "codex-code-mode-host",
    "codex-responses-api-proxy",
    "codex-windows-sandbox-setup",
    "codex-windows-sandbox-service",
    "codex-command-runner",
    "codex-app-server",
  ]) {
    const file = `${name}.exe`;
    const source = join(candidate, file);
    const digest = await sha256(source);
    assert.equal(digest, expected.get(file));
    const temporary = join(executableDirectory, `${file}.diagnostic`);
    // Replace the installed directory entry, preserving pnpm's store hardlinks.
    await copyFile(source, temporary);
    await rename(temporary, join(executableDirectory, file));
    staged.push({
      file,
      sha256: await sha256(join(executableDirectory, file)),
    });
  }
  for (const file of [
    "upstream-source.txt",
    "wrapper-source.txt",
    "native-source.patch",
    "rust-toolchain.txt",
    "executables.json",
    "native-tests.log",
  ])
    await copyFile(join(candidate, file), join(output, file));
}
const directVersion = execFileSync(command, ["--version"], {
  encoding: "utf8",
}).trim();
const launcherVersion = execFileSync(
  process.execPath,
  [launcher, "--version"],
  {
    encoding: "utf8",
  },
).trim();
assert.equal(launcherVersion, directVersion);
await writeFile(
  join(output, "runtime-selection.json"),
  JSON.stringify(
    {
      runtime,
      wrapperHead: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      command,
      launcher,
      packageVersion: manifest.version,
      launcherSha256: await sha256(launcher),
      stockExecutableSha256: before,
      executableSha256: await sha256(command),
      directVersion,
      launcherVersion,
      staged,
      qualification:
        "Candidate replaces the installed binary payload only in this disposable diagnostic job; npm metadata is not a candidate release or provenance claim.",
    },
    null,
    2,
  ) + "\n",
);
