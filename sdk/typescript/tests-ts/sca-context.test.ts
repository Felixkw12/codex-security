import { afterEach, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dependencyPackageContexts } from "../src/sca-context.js";
import { discoverScaInputs, initialOsvScanResult } from "../src/sca-osv.js";
import { dependencyScanResult } from "../src/sca.js";
import {
  dependencyAssessmentSummary,
  dependencyInventorySummary,
  prioritizedDependencyMatches,
} from "../src/sca-summary.js";
import { renderScaReport } from "../src/sca-report.js";
import { createTemporaryDirectories } from "./support/temporary-directories.js";

const { create, cleanup } = createTemporaryDirectories();
afterEach(cleanup);

async function packageAt(
  path: string,
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
) {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({
      name,
      version,
      dependencies,
      main: "index.js",
      private: true,
    }),
  );
  await writeFile(
    join(path, "index.js"),
    "throw new Error('Package code must never execute during evidence collection');",
  );
}

async function fixture() {
  const root = await realpath(await create("dependency-context-"));
  const repository = join(root, "repository");
  await packageAt(repository, "synthetic-project", "1.0.0", {
    "synthetic-parent": "2.0.0",
  });
  const parent = join(
    repository,
    "node_modules/.pnpm/synthetic-parent@2.0.0/node_modules/synthetic-parent",
  );
  const leaf = join(
    repository,
    "node_modules/.pnpm/leaf@3.0.0/node_modules/@synthetic/leaf",
  );
  await packageAt(parent, "synthetic-parent", "2.0.0", {
    "@synthetic/leaf": "3.0.0",
  });
  await packageAt(leaf, "@synthetic/leaf", "3.0.0");
  await symlink(
    parent,
    join(repository, "node_modules/synthetic-parent"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await mkdir(join(dirname(parent), "@synthetic"));
  await symlink(
    leaf,
    join(dirname(parent), "@synthetic/leaf"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = dependencyScanResult(
    initialOsvScanResult(join(root, "output")),
    { path: repository, revision: "synthetic", dirty: false },
    join(root, "output"),
  );
  result.components = [
    {
      id: "leaf",
      name: "@synthetic/leaf",
      version: "3.0.0",
      ecosystem: "npm",
      sourcePath: "pnpm-lock.yaml",
      dependencyGroups: [],
    },
  ];
  result.matches = ["low", "critical", "high"].map((severity, index) => ({
    id: `match-${index}`,
    componentId: "leaf",
    advisoryIds: [`SYNTHETIC-${index}`],
    aliases: [],
    sourceAdvisories: [],
    severity,
    fixedVersions: ["3.0.1"],
    advisoryModifiedAt: [],
  }));
  return { root, repository, result, parent, leaf };
}

test("resolves exact pnpm transitive source and an introduction chain without executing package code", async () => {
  const { result, leaf } = await fixture();
  const contexts = await dependencyPackageContexts(result);
  expect(contexts[0]).toMatchObject({
    projectName: "synthetic-project",
    private: true,
    dependencyGroups: ["runtime"],
  });
  expect(join(result.repository.path, contexts[0]!.installedPath!)).toBe(leaf);
  expect(
    contexts[0]!.dependencyChain.map((item) => `${item.name}@${item.version}`),
  ).toEqual([
    "synthetic-project@1.0.0",
    "synthetic-parent@2.0.0",
    "@synthetic/leaf@3.0.0",
  ]);
  expect(contexts[0]!.limitations.join(" ")).toContain("not a complete graph");
  result.packageContexts = contexts;
  expect(dependencyInventorySummary(result).join("\n")).toContain(
    "Local chain:",
  );
});

test("does not attribute a different installed version to a scanner match", async () => {
  const { result } = await fixture();
  result.components[0]!.version = "0.1.0";
  expect(
    (await dependencyPackageContexts(result))[0]!.installedPath,
  ).toBeNull();
});

test("repository package links do not authorize reading a dependency outside the target", async () => {
  const { root, repository, result } = await fixture();
  const external = join(root, "external");
  await packageAt(external, "external-package", "1.0.0");
  await symlink(
    external,
    join(repository, "node_modules/external-package"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await packageAt(repository, "synthetic-project", "1.0.0", {
    "external-package": "1.0.0",
  });
  Object.assign(result.components[0]!, {
    name: "external-package",
    version: "1.0.0",
  });
  expect(
    (await dependencyPackageContexts(result))[0]!.installedPath,
  ).toBeNull();
});

test("orders advisories by severity while preserving their individual identities", async () => {
  const { result } = await fixture();
  expect(prioritizedDependencyMatches(result).map((match) => match.id)).toEqual(
    ["match-1", "match-2", "match-0"],
  );
  expect(result.matches.map((match) => match.id)).toEqual([
    "match-0",
    "match-1",
    "match-2",
  ]);
});

test("findings and next actions precede inventory and inconclusive results remain explicit", async () => {
  const { result } = await fixture();
  result.assessments = [
    {
      matchId: "match-1",
      status: "completed",
      verdict: "needs_review",
      triage: null,
      error: null,
    },
  ];
  expect(dependencyAssessmentSummary(result)).toBe(
    "0 confirmed, 0 not actionable, 1 inconclusive, 0 failed, 2 unfinished",
  );
  const report = renderScaReport(result);
  expect(report.indexOf("Candidate fixed versions")).toBeLessThan(
    report.indexOf("## Observed components"),
  );
  expect(report.indexOf("SYNTHETIC-1")).toBeLessThan(
    report.indexOf("SYNTHETIC-0"),
  );
});

test("identifies the local Cargo root without reclassifying an unresolved path dependency", async () => {
  const repository = await create("dependency-cargo-context-");
  await writeFile(
    join(repository, "Cargo.toml"),
    '[package]\nname="synthetic-root"\nversion="0.1.0"\n',
  );
  await writeFile(
    join(repository, "Cargo.lock"),
    'version=4\n[[package]]\nname="synthetic-root"\nversion="0.1.0"\n[[package]]\nname="external-path"\nversion="0.1.0"\n',
  );
  const discovered = await discoverScaInputs(repository);
  expect(discovered.firstPartyPackages).toEqual([
    {
      name: "synthetic-root",
      version: "0.1.0",
      sourcePath: "Cargo.lock",
      manifestPath: "Cargo.toml",
    },
  ]);
  expect(discovered.localReferences.map((item) => item.name)).toEqual([
    "external-path",
  ]);
  expect(discovered.limitations.join(" ")).toContain(
    "local first-party package",
  );
});

test("collects installed dependencies when the local project has no package name", async () => {
  const { repository, result } = await fixture();
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "synthetic-parent": "2.0.0" },
    }),
  );
  const contexts = await dependencyPackageContexts(result);
  expect(contexts[0]!.projectName).toBeNull();
  expect(contexts[0]!.installedPath).not.toBeNull();
});

test("invalid optional Cargo metadata does not prevent lockfile matching", async () => {
  const repository = await create("dependency-cargo-context-");
  await writeFile(join(repository, "Cargo.toml"), "invalid manifest [");
  await writeFile(
    join(repository, "Cargo.lock"),
    'version=4\n[[package]]\nname="synthetic-root"\nversion="0.1.0"\n',
  );
  const discovered = await discoverScaInputs(repository);
  expect(discovered.inputs[0]!.status).toBe("scanned");
  expect(discovered.localReferences).toHaveLength(1);
  expect(discovered.firstPartyPackages).toHaveLength(0);
});

test.each(["directory", "cyclic link"] as const)(
  "unreadable optional npm manifest (%s) leaves matching evidence usable",
  async (kind) => {
    const { repository, result } = await fixture();
    const manifest = join(repository, "package.json");
    await rm(manifest);
    if (kind === "directory") await mkdir(manifest);
    else await symlink("package.json", manifest, "file");
    const contexts = await dependencyPackageContexts(result);
    expect(contexts[0]!.installedPath).toBeNull();
    expect(contexts[0]!.limitations).not.toHaveLength(0);
    expect(result.matches).toHaveLength(3);
  },
);
