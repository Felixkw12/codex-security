# Bounded scan comparison

Run the public SDK's Standard and Deep workflows against the same generated
repository. This reuses the secret-discovery eval's six positive cases, negative
controls, and grader. It tests the complete scanner, including publication and
Deep reduction. It adds no dependencies or public CLI commands.

This is a small measurement smoke test. It does not measure general vulnerability
recall, reproduce an external benchmark, or establish that one mode is better.
The fixture is synthetic and the model is nondeterministic.

## Run

Follow the [SDK setup](../../sdk/typescript/TESTING.md), including its native
payload. Then run from the repository root:

```sh
pnpm --dir sdk/typescript run build:plugin
pnpm --dir sdk/typescript run build
pnpm --dir sdk/typescript exec tsc -p ../../evals/scan-comparison/tsconfig.json
node --experimental-strip-types --test evals/scan-comparison/test_*.mts
node --experimental-strip-types evals/scan-comparison/run.mts
```

The live command uses `OPENAI_API_KEY` or `CODEX_API_KEY` and consumes model
usage. It pins GPT-5.6-Sol, xhigh effort, the OpenAI provider, standard Cyber
access, and the lockfile's Codex executable. Each configuration gets one attempt,
a $3 limit on the SDK's short-context cost estimate, and a 10-minute cancellation
signal. The reported upper cost estimate can exceed $3 because context pricing
is uncertain. In-flight requests can also exceed the limit. Deep uses one worker,
zero subagents, at most two discovery runs,
and five minutes of discovery time. Both configurations allow two native agent
threads. These are bounded settings, not the default Deep configuration.

Web search is disabled. The scan prompt restricts inspection to the generated
repository and runtime, and disallows network use. Native SDK permissions still
apply. This harness does not impose the core-only eval's stronger filesystem
isolation. Expected labels are held by the harness and never passed to the
scanner. Review the saved session settings and scan artifacts before interpreting
a run on a managed machine, where additional policies can apply.

Results stay under ignored `reports/scan-comparison/run-*`. Each mode has its
own outcome, elapsed time, observed usage, estimated cost range and pricing
source, final grade, and SDK artifacts. The configuration records source and
plugin revisions, runtime versions, file hashes, and fixture identity. Costs
are API-equivalent estimates, not billed amounts. Failed runs retain their
last observed usage, which may omit in-flight requests. Missing cost is `null`,
never zero. Interrupted runs retain an outcome for the started configuration.

`fixture.json` saves the generated inputs after the model work stops. Replay
the exact bytes with:

```sh
node --experimental-strip-types evals/scan-comparison/run.mts /absolute/path/to/fixture.json
```

Use the same source revision and lockfiles for a repeat. Inspect each attempt
separately, including failed attempts. Do not pool different models, settings,
source revisions, or fixture hashes.

## Reading the metrics

Recall counts positive cases retained in final findings, using the existing
grader's taxonomy and location rules. Evidence and coverage errors remain
separate in `grade.errors`, so a high recall value alone is not a passing grade.
`falsePositiveCount` is the grader's contract check, including incorrect taxonomy
and locations. Review those findings before calling them confirmed false alarms.

`duplicateFindings` counts matched reports that add no new case after earlier
reports. `repeatedCaseMatches` also counts overlapping reports that each add
another case. Neither deduplicates unrelated unexpected findings.

`completed` and `failed` are counts for the one attempt in that configuration.
A completed workflow can still have incomplete coverage. A failed attempt has
no final grade, and `deliveredRecall` is zero with all six cases retained in its
denominator. This does not claim that the interrupted model found nothing.
Raw partial artifacts remain available for inspection. The command exits nonzero
on operational failure, not on a missed finding.

## External comparisons

A reproducible comparison needs exact repository revisions and case labels,
scanner/plugin revisions, provider and model identifiers, effort, mode and
worker settings, budgets, tool permissions, per-case results, failed attempts,
rerun policy, and grading rules. Cost needs a pricing date, cache treatment,
worker attribution, and a clear distinction between estimates and bills.
Elapsed time needs a defined aggregation across cases and parallel workers.

When those inputs are unavailable, label the external numbers non-reproducible
from the published material. A successful run of this fixture does not validate
or refute them.
