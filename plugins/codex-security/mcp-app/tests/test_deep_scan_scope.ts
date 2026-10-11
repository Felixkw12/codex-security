import assert from "node:assert/strict";
import test from "node:test";
import { finding } from "./scan-draft-fixture.ts";
import { fixture } from "./scan-draft-recovery-fixture.ts";
import { readJson } from "./support/json.ts";
const findings = [
  finding("api", "api/source.py"),
  finding("jobs", "background jobs/source.py"),
  finding("unrelated", "unrelated/source.py"),
  finding("prefix", "api-other/source.py"),
];

for (const [mode, complete] of [
  ["deep", true],
  ["deep", false],
  ["standard", true],
] as const) {
  test(`${mode} parent publication keeps its scope behavior (complete=${complete})`, async (t) => {
    const f = await fixture(t, mode);
    f.context.targetContract = {
      ...f.context.targetContract,
      scope: {
        requiredIncludePaths: ["api", "background jobs"],
        requiredExcludePaths: [],
      },
    };
    const input = { ...f.draft({}, true), complete, findings };
    await f.write(input);
    const result = await readJson(f.root, "findings.json");
    assert.deepEqual(
      result.findings.map(
        (row: { identity: { anchor: string } }) => row.identity.anchor,
      ),
      mode === "deep"
        ? ["api", "jobs"]
        : ["api", "jobs", "unrelated", "prefix"],
    );
    assert.equal(input.findings.length, 4);
  });
}

test("Deep publication keeps a finding with any matching location and supports exact files", async (t) => {
  const f = await fixture(t, "deep");
  f.context.targetContract = {
    ...f.context.targetContract,
    scope: {
      requiredIncludePaths: ["api/source.py", "background jobs"],
      requiredExcludePaths: [],
    },
  };
  const mixed = finding("mixed", "unrelated/source.py");
  mixed.locations.push({ path: "api/source.py", startLine: 1, endLine: 2 });
  await f.write({
    ...f.draft({}, true),
    findings: [...findings, mixed, finding("other-api", "api/other.py")],
  });
  const result = await readJson(f.root, "findings.json");
  assert.deepEqual(
    result.findings.map(
      (row: { identity: { anchor: string } }) => row.identity.anchor,
    ),
    ["api", "jobs", "mixed"],
  );
  assert.deepEqual(result.findings.at(-1).locations, mixed.locations);
});
