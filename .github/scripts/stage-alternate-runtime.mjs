import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
assert.equal(process.version, "v22.13.0");
const [phase] = process.argv.slice(2);
assert.ok(phase === "download" || phase === "stage");
const runtime = process.env.DIAGNOSTIC_RUNTIME;
assert.ok(["stock", "candidate", "coordinator"].includes(runtime));
const root = process.cwd();
const output = join(root, "sdk/typescript/reports/alternate-diagnostic");
const nativeTree = "ad15223f0a2ed733cc7e42361ce3b108f1649594";
const sourceRun = 39863141389;
const sourceHead = "036728a5d73832ab6f019a78a3e655f4c46abbc9";
const candidate = join(process.env.RUNNER_TEMP, "alternate-native-candidate");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const fileHash = async (path) => sha256(await readFile(path));
await mkdir(output, { recursive: true });
assert.equal(
  git("rev-parse", "HEAD:plugins/codex-security/native"),
  nativeTree,
);

if (phase === "download") {
  const token = process.env.GITHUB_TOKEN;
  assert.ok(token, "The artifact download step requires its read-only token.");
  const artifacts = [
    {
      id: 12463720311,
      name: `native-universal-${sourceHead}`,
      digest:
        "9de7f81b78103e50b04329830d0dc2b5ebdc6f28b025e822382b1d37210ca7c8",
      destination: join(root, "plugins/codex-security/native/prebuilt"),
    },
  ];
  if (runtime === "candidate")
    artifacts.push({
      id: 12467482275,
      name: `native-candidate-${sourceHead}`,
      digest:
        "0137e389db9c54af99845d8bcd29ec9378147626053db1d03225ea1f85ae48bf",
      destination: candidate,
    });
  const downloaded = [];
  for (const artifact of artifacts) {
    const url = `https://api.github.com/repos/openai/codex-security/actions/artifacts/${artifact.id}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const response = await fetch(url, { headers });
    assert.equal(
      response.status,
      200,
      `Artifact metadata HTTP ${response.status}`,
    );
    const metadata = await response.json();
    assert.equal(metadata.id, artifact.id);
    assert.equal(metadata.name, artifact.name);
    assert.equal(metadata.expired, false);
    assert.equal(metadata.workflow_run.id, sourceRun);
    assert.equal(metadata.workflow_run.head_sha, sourceHead);
    assert.equal(metadata.digest, `sha256:${artifact.digest}`);
    const archiveResponse = await fetch(`${url}/zip`, { headers });
    assert.equal(
      archiveResponse.status,
      200,
      `Artifact archive HTTP ${archiveResponse.status}`,
    );
    const bytes = Buffer.from(await archiveResponse.arrayBuffer());
    assert.equal(sha256(bytes), artifact.digest);
    const archive = join(process.env.RUNNER_TEMP, `${artifact.id}.zip`);
    await writeFile(archive, bytes);
    await mkdir(artifact.destination, { recursive: true });
    execFileSync("tar", ["-xf", archive, "-C", artifact.destination], {
      stdio: "inherit",
    });
    downloaded.push({ ...artifact, archive, metadata });
  }
  await writeFile(
    join(output, "artifact-provenance.json"),
    JSON.stringify(
      {
        wrapperHead: git("rev-parse", "HEAD"),
        nativeTree,
        sourceRun,
        sourceHead,
        runtime,
        artifacts: downloaded,
        tools: {
          node: process.version,
          bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
          git: git("--version"),
          runnerOs: process.env.RUNNER_OS,
          runnerArch: process.env.RUNNER_ARCH,
          image: process.env.ImageOS,
          imageVersion: process.env.ImageVersion,
        },
        qualification:
          "Immutable artifacts from the earlier diagnostic run; native tests were not rerun here.",
      },
      null,
      2,
    ) + "\n",
  );
} else {
  const require = createRequire(join(root, "sdk/typescript/package.json"));
  const codexPackage = require.resolve("@openai/codex/package.json");
  const platformPackage = createRequire(codexPackage).resolve(
    "@openai/codex-win32-x64/package.json",
  );
  const manifest = JSON.parse(await readFile(codexPackage, "utf8"));
  assert.equal(manifest.version, "0.163.0");
  const directory = join(
    dirname(platformPackage),
    "vendor/x86_64-pc-windows-msvc/bin",
  );
  const command = join(directory, "codex.exe");
  const launcher = resolve(dirname(codexPackage), manifest.bin.codex);
  const expected = {
    "codex.exe":
      "ba582418d8d880e21b5f1f6578a79cd8b4144b8c17ac7e53f5f6979807d31d73",
    "codex-code-mode-host.exe":
      "c3bf06da78bfdc04c5a74eefc52ee0ef2a7cfd41703e7e1312d8aa2855c48a45",
    "codex-responses-api-proxy.exe":
      "e0e65b541d359c70512c1b02c3fd8f4f6a9a0f3b0f73c387bcb13617c5765377",
    "codex-windows-sandbox-setup.exe":
      "1cc3a4a54541c274c0cd981b90ad2ce55a9831f5e646903bbdc0c4b2ff62eb36",
    "codex-windows-sandbox-service.exe":
      "548d0aa4001f29453dd8e160dbd4db8b28c845842da6261b351280ed92554df8",
    "codex-command-runner.exe":
      "c294410bcd17da8f7be58248fe7c2d26f046e4179d6b8cde1f811232c290fc16",
    "codex-app-server.exe":
      "126351641b300fb21cfd877c1b2aa4034e602212945824e6bc1c3bd0a4a24032",
  };
  const stock = [];
  for (const file of Object.keys(expected)) {
    const path = join(directory, file);
    try {
      stock.push({ file, path, sha256: await fileHash(path) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      stock.push({ file, path, sha256: null, absent: true });
    }
  }
  assert.equal(
    await fileHash(command),
    "2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993",
  );
  assert.equal(
    await fileHash(launcher),
    "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70",
  );
  const staged = [];
  if (runtime === "candidate") {
    const hashes = JSON.parse(
      await readFile(join(candidate, "executables.json"), "utf8"),
    );
    const built = new Map(
      hashes.map(({ Path, Hash }) => [basename(Path), Hash.toLowerCase()]),
    );
    assert.equal(
      await fileHash(join(candidate, "native-source.patch")),
      "0ee07461f6045d2e46212fccd6f0d27bfb55cd32ab8bf2c692ac36e2efe27234",
    );
    for (const [file, digest] of Object.entries(expected)) {
      assert.equal(built.get(file), digest);
      const source = join(candidate, file);
      assert.equal(await fileHash(source), digest);
      const path = join(directory, file);
      const temporary = `${path}.diagnostic`;
      // Replace directory entries without changing pnpm's shared store hardlinks.
      await copyFile(source, temporary);
      await rename(temporary, path);
      assert.equal(await fileHash(path), digest);
      staged.push({ file, path, sha256: digest });
    }
    for (const file of [
      "upstream-source.txt",
      "wrapper-source.txt",
      "native-source.patch",
      "rust-toolchain.txt",
      "executables.json",
    ])
      await copyFile(join(candidate, file), join(output, file));
  }
  let directVersion = null,
    launcherVersion = null;
  if (runtime !== "coordinator") {
    directVersion = execFileSync(command, ["--version"], {
      encoding: "utf8",
    }).trim();
    launcherVersion = execFileSync(process.execPath, [launcher, "--version"], {
      encoding: "utf8",
    }).trim();
    assert.equal(launcherVersion, directVersion);
  }
  await writeFile(
    join(output, "runtime-selection.json"),
    JSON.stringify(
      {
        runtime,
        wrapperHead: git("rev-parse", "HEAD"),
        nativeTree,
        command,
        launcher,
        packageVersion: manifest.version,
        launcherSha256: await fileHash(launcher),
        executableSha256: await fileHash(command),
        stock,
        staged,
        directVersion,
        launcherVersion,
        qualification:
          "Candidate payload is diagnostic-only and replaces all seven installed executables. Package metadata is not candidate provenance. Coordinator mode does not invoke the native runtime for identity checks.",
      },
      null,
      2,
    ) + "\n",
  );
}
