import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createFixture } from "../secret-discovery/fixtures.mts"
import { measure, outcome } from "./metrics.mts"
import { stageFixture } from "./replay.mts"

test("counts merged findings, repeated cases, false positives, and misses", () => {
  const fixture = createFixture()
  const finding = (indices: number[]) => ({
    taxonomy: { category: "hardcoded credentials", cwe: ["CWE-798"] },
    locations: indices.map((i) => ({
      path: fixture.positives[i].path,
      startLine: fixture.positives[i].line,
    })),
  })
  const grade = measure(
    {
      findings: [
        finding([0, 1]),
        finding([1, 2]),
        finding([0]),
        {
          taxonomy: { category: "hardcoded credentials", cwe: ["CWE-798"] },
          locations: [{ path: "src/runtime_config.py", startLine: 3 }],
        },
      ],
      coverage: { completeness: "partial" },
    },
    fixture,
  )
  assert.equal(grade.recall, 3 / 6)
  assert.equal(grade.findingCount, 4)
  assert.equal(grade.duplicateFindings, 1)
  assert.equal(grade.repeatedCaseMatches, 2)
  assert.equal(grade.falsePositiveCount, 1)
  assert.ok(grade.errors.includes("incomplete coverage"))
  assert.ok(grade.errors.includes("missing or invalid code evidence"))
})

test("failed attempts retain their denominator without inventing scan recall", () => {
  for (const status of [
    "failed",
    "timeout",
    "cost_limit",
    "interrupted",
  ] as const) {
    const result = outcome(status, null, 6)
    assert.equal(result.completed, 0)
    assert.equal(result.failed, 1)
    assert.equal(result.expectedCases, 6)
    assert.equal(result.deliveredRecall, 0)
    assert.equal(result.grade, null)
  }
})

test("grades SDK key categories and operation citations without losing location checks", () => {
  const fixture = createFixture()
  const findings = fixture.positives.map((expected) => ({
    taxonomy: {
      category:
        expected.id === "private-key"
          ? "Cryptographic key exposure"
          : "Credential exposure",
      cwe: [expected.cwes[0]],
    },
    locations: [
      {
        path: expected.path,
        startLine: expected.line,
        endLine: expected.endLine,
        role: "root_control",
      },
      ...(expected.consumerLine === null
        ? []
        : [
            {
              path: expected.path,
              startLine: expected.consumerLine - 2,
              endLine: expected.consumerLine,
              role: "sensitive_operation",
            },
          ]),
    ],
    codeEvidence: [
      {
        path: expected.path,
        startLine: expected.line,
        code: fixture.files[expected.path]
          .split("\n")
          .slice(expected.line - 1, expected.endLine)
          .join("\n"),
      },
    ],
  }))
  const result = { findings, coverage: { completeness: "complete" } }
  const grade = measure(result, fixture)
  assert.equal(grade.passed, true)
  assert.equal(grade.recall, 1)
  assert.equal(grade.falsePositiveCount, 0)
  // Function framing alone is not a credential-use citation.
  findings[0].locations[1].endLine = findings[0].locations[1].startLine
  assert.equal(measure(result, fixture).falsePositiveCount, 1)
})

test("replays fixture bytes without allowing imported paths outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "scan-comparison-test-"))
  const repo = join(root, "repository")
  const fixture = createFixture()
  try {
    await stageFixture(repo, fixture)
    for (const [name, contents] of Object.entries(fixture.files)) {
      assert.equal(await readFile(join(repo, name), "utf8"), contents)
    }
    for (const name of ["../escape.txt", join(root, "escape.txt")]) {
      await assert.rejects(
        stageFixture(repo, {
          ...fixture,
          files: { [name]: "outside" },
        }),
        /escapes the repository/,
      )
    }
    await assert.rejects(readFile(join(root, "escape.txt")), { code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
