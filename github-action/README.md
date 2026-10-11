# Codex Security GitHub Action

Run Codex Security scans in GitHub Actions. Scan a repository or pull request,
check findings against a severity threshold, and export JSON, coverage, and
SARIF reports.

## Quick start

Use a GitHub-hosted Ubuntu 24.04 x64 runner on GitHub.com and an OpenAI API key
with access to the selected model. For Amazon Bedrock, see the separate
[workflow example](../examples/github-actions/README.md).

Add your API key as a repository secret named `CODEX_SECURITY_API_KEY`, then
save this workflow in `.github/workflows/codex-security.yml`.
Replace `REPLACE_WITH_REVIEWED_COMMIT` with the full SHA of an Action commit.
The matching `action-vX.Y.Z` tag and distribution commit are listed in each
product release after the CLI and Action have both passed release checks.
When using a fork, replace `openai` with the fork owner.

The [repository workflow](examples/repository.yml) below uses `gpt-6-sol` and
an estimated $5 cost limit. Change `max-cost` to adjust the budget, or remove it
for no estimated cost limit. Requests already in progress can exceed the limit.
Daybreak is optional; see [Daybreak access and refusals](#daybreak-access-and-refusals).

<!-- action-workflow:repository:start -->

```yaml
name: Codex Security repository
on:
  workflow_dispatch:
  schedule:
    - cron: "23 7 * * 1" # Mondays at 07:23 UTC

permissions:
  contents: read

jobs:
  security:
    runs-on: ubuntu-24.04
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Scan the repository
        id: security
        uses: openai/codex-security@REPLACE_WITH_REVIEWED_COMMIT
        with:
          scope: repository
          model: gpt-6-sol
          effort: high
          max-cost: "5"
          fail-on-severity: none
          upload-artifacts: "true"
        env:
          OPENAI_API_KEY: ${{ secrets.CODEX_SECURITY_API_KEY }}
```

<!-- action-workflow:repository:end -->

The workflow runs weekly on Mondays at 07:23 UTC. To run it manually, use
**Actions → Codex Security repository → Run workflow**.
Findings are report-only by default. Valid partial results produce a warning;
scanner and required reporting errors fail the job. Set `fail-on-severity` to
require a complete scan and fail on findings at or above the selected severity.

### Ubuntu sandbox setup

For jobs running directly on GitHub-hosted Ubuntu 24.04 VMs, the Action installs
`bubblewrap` and `apparmor-profiles` and loads the supplied
`bwrap-userns-restrict` AppArmor profile. It then verifies that Codex can start
its sandbox before using the scan credential. No separate setup step is needed.

Self-hosted runners and job containers must provide a working Codex sandbox.
The Action checks sandbox startup in both, but does not install system packages
or change AppArmor there. See the [sandbox documentation](https://learn.chatgpt.com/docs/sandboxing).

## Daybreak access and refusals

Daybreak is optional. You can use the Action with a general-purpose model your
API key can access under standard safeguards. Some security tasks may trigger
model refusals or API cybersecurity safety blocks. **If a refusal or safety
block aborts the scan, the Action fails**, even with `fail-on-severity: none`.
The findings setting does not suppress scanner errors. Check the job summary and logs for the reason. A failed scan does not
mean the repository has no vulnerabilities.

For authorized security work that needs reduced refusals,
[request Daybreak access](https://openai.com/form/enterprise-trusted-access-for-cyber/).
After organization approval, enable the required program for the API project
and use a key from that project. Daybreak reduces some refusals but does not
remove every safeguard or guarantee that a scan will complete.

To explicitly select an approved Cyber access program, add
`cyber-access-program: daybreak_blue` to the scan step's `with` settings.
The input also accepts `standard` and `daybreak_red`; choose a program supported
by your model and API project. Leaving it unset preserves CLI defaults.
Selecting `standard` does not require Daybreak approval. Selecting a Daybreak
program does not grant access; an unavailable program or incompatible model
causes the scan to fail.

## Scan pull requests

Use the same API-key secret and Action commit as above. The
[pull-request workflow](examples/pull-request.yml) checks out the PR head with
full history and requires complete coverage. Make its **Codex Security** job a
required status check in your repository rules.

<!-- action-workflow:pull-request:start -->

```yaml
name: Codex Security PR
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]

permissions:
  contents: read

concurrency:
  group: codex-security-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  security:
    if: github.event.pull_request.head.repo.full_name == github.repository
    name: Scan changes
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    outputs:
      scan-status: ${{ steps.security.outputs.scan-status }}
      skip-reason: ${{ steps.security.outputs.skip-reason }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Scan PR changes
        id: security
        uses: openai/codex-security@REPLACE_WITH_REVIEWED_COMMIT
        with:
          scope: diff
          model: gpt-6-sol
          effort: high
          max-cost: "5"
          fail-on-severity: high
          upload-artifacts: "true"
        env:
          OPENAI_API_KEY: ${{ secrets.CODEX_SECURITY_API_KEY }}

  required-review:
    name: Codex Security
    needs: security
    if: always()
    runs-on: ubuntu-24.04
    steps:
      - name: Require a completed review or an empty diff
        env:
          SCAN_JOB_RESULT: ${{ needs.security.result }}
          SCAN_STATUS: ${{ needs.security.outputs.scan-status }}
          SKIP_REASON: ${{ needs.security.outputs.skip-reason }}
        run: |
          test "$SCAN_JOB_RESULT" = success
          if [ "$SCAN_STATUS" = completed ]; then
            exit 0
          fi
          test "$SCAN_STATUS" = skipped
          test "$SKIP_REASON" = empty-diff
```

<!-- action-workflow:pull-request:end -->

The scan job fails on high or critical findings, incomplete coverage, scanner
errors, or required reporting errors. Available findings and reports are
preserved when the scan is incomplete. File and line annotations are enabled
by default.

The workflow also reruns on PR edits, including base-branch changes, so it
reviews the diff against the selected base even when the head commit is unchanged.

The separate **Codex Security** job runs even if the scan job is skipped. It
passes only after a successful scan job that reports a completed scan or a
verified empty diff. A dry run, cancellation, or skipped scan job fails this
required check.

Use PR scanning for trusted contributors with branches in the calling repository.
To scan Dependabot PRs, also configure `CODEX_SECURITY_API_KEY` as a
[Dependabot secret](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions#accessing-secrets).
The same workflow uses that secret for Dependabot runs and the Actions secret for
other runs. Missing credentials fail with setup guidance.

The scan job skips fork PRs, so the required check fails for those PRs. Repositories
accepting fork contributions need an approved review process for them before
using this check as a merge requirement. `pull_request_target` and `workflow_run`
are not supported.

The scanner uses applicable `SECURITY.md` guidance from the checked-out revision,
including policy changes in the PR. Review those changes alongside the code.

## Scan settings

The Action defaults to `mode: standard` for repository, selected-path, and diff scans.
Keep unrelated credentials and deployment steps in separate jobs.

- Set `paths` to newline-separated files or folders to scan part of a repository.
  Names such as `src/[slug]/page.tsx` are literal paths; glob characters are not expanded.
  This requires repository scope.
- For diff scans outside PR events, set `diff-base`.
- Set `dry-run: 'true'` with `fail-on-severity: none` to check configuration and
  sandbox startup without an API key or model calls. Use a separate setup job;
  dry-run does not assess code or verify model access.

For a Deep scan of a repository or selected paths, add these inputs to the scan step:

```yaml
with:
  mode: deep
  max-time-hours: "1"
```

Deep mode does not support diff scans. `max-time-hours` limits Deep discovery;
finalization can take additional time. It is unset by default, which uses the
CLI's default of 96 hours. Set an explicit budget for Deep scans that leaves
room for finalization within your job timeout. The one-hour discovery budget
above leaves time for setup and finalization within the repository workflow's
two-hour job timeout.

## Reports

The Action writes a job summary and source annotations. Set
`upload-artifacts: 'true'` to add a report-download link to the job summary.
Reports are retained for seven days by default; use `retention-days` to change
this. Reports can contain source code and vulnerability details.

The Action uses the normal Actions job check. Its summary and final log message
distinguish findings above the failure threshold from a scan that could not
complete or a required reporting failure. With `fail-on-severity: none`, findings
are report-only; scanner and required reporting failures still fail the job.

When the CLI returns a valid finalized result with partial coverage, the Action
preserves the available findings and coverage explanations. It sets
`scan-status: incomplete`, `policy-status: not-evaluated`, and
`sarif-upload-ready: false`. With `fail-on-severity: none`, it warns and passes.
With any severity threshold, it fails because the review is incomplete, even
if there are no findings. It does not treat an incomplete review as a passed
or failed findings policy.

A verified empty diff succeeds with `scan-status: skipped` and
`skip-reason: empty-diff`, including when a severity threshold is configured.
A dry run checks local setup and requires `fail-on-severity: none`.
Use the [required PR check](#scan-pull-requests) to handle skipped scan jobs as
well as the Action's own results.

Scanner failures, interruption, unknown coverage, invalid or missing required
reports, and a changed checkout still fail the step. A partial coverage file
left behind by a failed scan does not make that failure advisory. Required
artifact-upload and runtime-cleanup failures also remain failures.

SARIF is optional. If it cannot be produced, the Action warns and sets
`report-status: partial` and `sarif-upload-ready: false`. Summaries, annotations,
and JSON reports remain available, and the scan outcome is preserved. A requested
artifact upload that fails still fails the job.

### GitHub code scanning

Grant the job `security-events: write` and, for private repositories,
`actions: read`, alongside `contents: read`. Set `id: security` on the scan step,
then add this step after it:

```yaml
- name: Upload security findings
  if: ${{ always() && steps.security.outputs.sarif-upload-ready == 'true' }}
  uses: github/codeql-action/upload-sarif@b96794f015dfd88f77b49b1c93e0fa7110f94c63 # v4.38.0
  with:
    sarif_file: ${{ steps.security.outputs.sarif-path }}
    sha: ${{ steps.security.outputs.scanned-sha }}
    ref: ${{ steps.security.outputs.analysis-ref }}
    category: codex-security-repository
```

Complete scans remain uploadable when findings exceed the severity threshold.
The SARIF step skips incomplete scans, empty diffs, and dry runs. Available
reports from incomplete scans can still be saved as Actions artifacts.
Use a distinct category for each scan scope, such as repository and PR scans.
The Action removes the CLI scan identifier from SARIF automation details so the
uploader can apply that category.
See [GitHub's SARIF upload requirements](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file)
for code scanning availability and permissions.

## Runtime

The Action installs a pinned CLI release from npm using a committed dependency
lock. It runs on Linux x64 with Node 24 and Python 3.11 or later.
GitHub-hosted Ubuntu 24.04 VMs supply Node and Python. Codex uses the system
Bubblewrap from `PATH`; see [Ubuntu sandbox setup](#ubuntu-sandbox-setup) for VM
setup and requirements for self-hosted runners and job containers.

npm and Python are found on the runner's `PATH`; `actions/setup-node` and `actions/setup-python` can select installations.
Python helpers preserve the selected virtual environment and library settings.
The runner's process tracking marker is retained by the scan coordinator and Deep Scan workers.
Authentication uses `OPENAI_API_KEY`.
Temporary runtime files are removed after the job; reports remain available to
downstream steps.

The Action uses the CLI’s validated JSON result for findings and scan status.
If the CLI exits without a usable result, the Action reports failure and leaves
report paths empty; it does not recover unvalidated partial files from disk.

## Troubleshooting

- **Checkout or history errors:** use the triggering revision, `fetch-depth: 0`
  for PRs, and `persist-credentials: false`.
- **Authentication errors:** check the repository secret and model access.
- **Sandbox startup errors:** for jobs running directly on GitHub-hosted Ubuntu
  24.04 VMs, inspect the package-install and AppArmor diagnostics. On self-hosted
  runners and in job containers, configure the sandbox before running the Action.
  Installing Bubblewrap alone does not load Ubuntu's required AppArmor profile.
- **Missing SARIF uploads:** inspect `scan-status`, `report-status`, and
  `sarif-upload-ready`.
- **Incomplete scans:** follow the summary's report link and inspect coverage
  before adjusting scope or budget. Incomplete scans fail when a severity
  threshold is set. Advisory runs warn without failing.

CLI diagnostics stream by default. Set `verbose: 'false'` for lifecycle and
elapsed-time messages only.

## Upgrading from Action 0.2.0

Previously, partial coverage could pass with a configured severity threshold.
It now fails. Keep `fail-on-severity: none` for advisory scans, or allow the
failure to block merging until the review completes. `dry-run: 'true'` also
requires `fail-on-severity: none`; put configuration checks in a separate job.

The Action now prepares the sandbox for jobs running directly on GitHub-hosted
Ubuntu 24.04 VMs. Remove the manual Bubblewrap/AppArmor setup step from those
jobs. Self-hosted runners and job containers still require a preconfigured sandbox.

The workflow examples use GPT-6 Sol cost support added after CLI `0.2.0`.
Choose the reviewed distribution commit from the coordinated CLI/Action release
containing these changes; pinning an older CLI does not enable the new pricing.

## Development

From the repository root:

```bash
npm --prefix github-action ci --ignore-scripts --no-audit --no-fund
npm --prefix github-action run docs
npm --prefix github-action run build
npm --prefix github-action run validate
# Test the published CLI with synthetic scans; no model calls:
npm --prefix github-action/runtime ci --ignore-scripts --no-audit --no-fund
npm --prefix github-action run test:cli
# Linux x64 with Node 24; no model calls:
node github-action/scripts/linux-smoke.mjs
```

The README workflow blocks are generated from `examples/*.yml`; edit those
files and run `npm run docs` to keep the examples synchronized.

Commit source changes and the generated `dist/*.cjs` bundles together.
Validation checks types, tests, Action metadata, documentation, and bundle
reproducibility. CI also tests the result adapter against the pinned CLI and its
SARIF exporter using synthetic scans, runs the packaged Linux smoke test, and
audits the Action and CLI dependency locks. The `@openai/codex-security` dependency in
`runtime/package.json` is the installed CLI version source. Main keeps the last
published CLI pin so its checks remain runnable while a release PR prepares the
next product version. To upgrade that development pin, update it and regenerate
`runtime/package-lock.json`, rebuild the bundles, and run validation.

Releases use the product version from `sdk/typescript/package.json`. Before npm
publication, the release workflow exercises the Action's compatibility suite
against the packed CLI candidate. After publication and provenance verification,
the Action release workflow starts from that exact CLI source commit, updates
the runtime pin and integrity lock, and fetches the locked runtime through
Socket Firewall with an empty cache before running the CLI. The lock keeps
public npm URLs for Action consumers. The workflow rebuilds the bundles and
runs the Action checks in a job with read-only repository permissions.
A fresh publisher takes only the tested runtime lock, rebuilds
from the same source, and verifies the bundle hashes without executing the CLI.
It creates a distribution commit and an immutable `action-vX.Y.Z` tag with the
same version as `npm-vX.Y.Z`.

The Action distribution commit differs from the CLI source commit because the
registry integrity lock is finalized after publication. Release metadata records
both commits, both tags, and the verified CLI integrity. A failed Action stage
can be rerun without republishing npm. Existing version tags are never moved.
See [the release process](../RELEASING.md) for the orchestration and recovery flow.

<!-- prettier-ignore-start -->

<!-- action-reference:start -->

## Inputs

Inputs are strings. Quote booleans and use newline-separated literal paths for lists.

| Input                  | Default                   | Meaning                                                                                                                                                                                                                      |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`           | `${{ github.workspace }}` | Checkout root. Use paths to select folders within the checkout.                                                                                                                                                              |
| `scope`                | `repository`              | repository or diff. Select diff for PR changes only; repository scans the full checkout.                                                                                                                                     |
| `paths`                | Unset                     | Newline-delimited literal repository-relative files or folders. Only for repository scope; no glob expansion.                                                                                                                |
| `diff-base`            | Unset                     | Diff base revision. Defaults to the PR merge base; required outside PRs when scope is diff.                                                                                                                                  |
| `mode`                 | `standard`                | standard or deep. Deep supports repository scans, including selected paths; not diff scans.                                                                                                                                  |
| `model`                | `gpt-5.6-sol`             | Model with access through your API key. Cost limits require CLI pricing support for the model.                                                                                                                               |
| `cyber-access-program` | Unset                     | Optional Cyber access program: standard, daybreak_blue, or daybreak_red. Unset preserves CLI defaults. Daybreak selections require approved organization and enabled API project access; model access is checked separately. |
| `effort`               | `xhigh`                   | Reasoning effort: minimal, low, medium, high, xhigh, or max (subject to model support).                                                                                                                                      |
| `max-cost`             | Unset                     | Positive estimated USD stop threshold per invocation. In-flight requests can exceed it; unset means no cost limit.                                                                                                           |
| `max-time-hours`       | Unset                     | Positive Deep discovery duration in hours, up to 96. Unset uses the CLI default. Finalization and job timeout are separate.                                                                                                  |
| `fail-on-severity`     | `none`                    | none, low, medium, high, or critical. A severity threshold also requires complete coverage. With none, valid partial scans warn; scanner and required reporting errors still fail.                                           |
| `verbose`              | `true`                    | Stream CLI diagnostics to the job log. Set false for lifecycle and elapsed-time messages only.                                                                                                                               |
| `dry-run`              | `false`                   | Validate local configuration without a scan or API key. Does not verify authentication or model access. Requires fail-on-severity: none; use a separate non-required job.                                                    |
| `summary`              | `true`                    | Write a human-readable job summary.                                                                                                                                                                                          |
| `annotations`          | `true`                    | Emit up to 50 source finding annotations; complete findings remain in reports.                                                                                                                                               |
| `upload-artifacts`     | `false`                   | Upload an allowlist of validated reports and link the artifact in the job summary. Reports may contain source and vulnerability details.                                                                                     |
| `artifact-name`        | `codex-security`          | Report artifact name; choose distinct names for matrix jobs and multiple invocations.                                                                                                                                        |
| `retention-days`       | `7`                       | Artifact retention, 1–90 days (subject to repository limits).                                                                                                                                                                |

## Outputs

All outputs are strings. An empty cost or count means unavailable, not zero.

| Output                | Meaning                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sarif-path`          | Absolute validated SARIF file path, or empty when unavailable or withheld.                                                                                                |
| `json-path`           | Absolute canonical findings JSON path, or empty when unavailable or withheld.                                                                                             |
| `coverage-path`       | Absolute coverage JSON path, or empty when unavailable or withheld.                                                                                                       |
| `results-directory`   | Runner-local reports directory; do not upload it recursively.                                                                                                             |
| `scan-status`         | completed, incomplete, failed, or skipped. Incomplete scans fail when a severity threshold is configured, otherwise warn. Skipped is reserved for empty diffs or dry-run. |
| `skip-reason`         | empty-diff or dry-run when no scan ran; otherwise empty.                                                                                                                  |
| `policy-status`       | passed, failed, or not-evaluated. Incomplete scans are not-evaluated, even when a severity threshold is configured.                                                       |
| `report-status`       | ready, partial, or failed. Missing optional SARIF yields partial without failing the scan; required reporting failures yield failed.                                      |
| `exit-code`           | CLI exit code, or empty if the CLI was not started. Valid partial results may return 2 without failing the Action step when fail-on-severity is none.                     |
| `scanned-sha`         | Verified checkout commit SHA.                                                                                                                                             |
| `analysis-ref`        | GitHub ref matching the scanned revision.                                                                                                                                 |
| `sarif-upload-ready`  | true only for complete, validated reports with a publishable immutable revision. Remains true after severity-policy failure.                                              |
| `critical-count`      | Available critical findings, or empty before results are available.                                                                                                       |
| `high-count`          | Available high findings, or empty before results are available.                                                                                                           |
| `medium-count`        | Available medium findings, or empty before results are available.                                                                                                         |
| `low-count`           | Available low findings, or empty before results are available.                                                                                                            |
| `informational-count` | Available informational findings, or empty before results are available.                                                                                                  |
| `estimated-cost`      | Estimated USD cost reported by the CLI. Empty means unavailable, not zero.                                                                                                |

<!-- action-reference:end -->

<!-- prettier-ignore-end -->
