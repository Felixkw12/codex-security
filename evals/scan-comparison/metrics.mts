import { gradeResult, type Result } from "../secret-discovery/grade.mts"
import type { createFixture } from "../secret-discovery/fixtures.mts"

type Fixture = ReturnType<typeof createFixture>

export function measure(result: Result, fixture: Fixture, repo?: string) {
  const grade = gradeResult(result, fixture, repo)
  const matches = (result.findings ?? []).map((finding) =>
    gradeResult({ findings: [finding] }, fixture)
      .cases.filter((entry) => entry.found)
      .map((entry) => entry.id),
  )
  const seen = new Set<string>()
  let duplicateFindings = 0
  for (const ids of matches) {
    if (ids.length && ids.every((id) => seen.has(id))) duplicateFindings += 1
    for (const id of ids) seen.add(id)
  }
  return {
    ...grade,
    findingCount: result.findings?.length ?? 0,
    duplicateFindings,
    // Counts overlapping reports even when each also adds a new exposure.
    repeatedCaseMatches: fixture.positives.reduce(
      (total, entry) =>
        total +
        Math.max(0, matches.filter((ids) => ids.includes(entry.id)).length - 1),
      0,
    ),
  }
}

export function outcome(
  status: "completed" | "failed" | "timeout" | "cost_limit" | "interrupted",
  grade: ReturnType<typeof measure> | null,
  expectedCases: number,
) {
  const found = grade?.cases.filter((entry) => entry.found).length ?? 0
  return {
    status,
    completed: Number(status === "completed"),
    failed: Number(status !== "completed"),
    expectedCases,
    retainedCases: found,
    // Failed attempts remain in the denominator, without assigning scan recall.
    deliveredRecall: found / expectedCases,
    grade,
  }
}
