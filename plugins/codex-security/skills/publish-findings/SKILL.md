---
name: publish-findings
description: Import selected Wiz package vulnerabilities, SAST, repository secrets, and IaC findings locally or to Codex Security Cloud after previewing the destination and evidence. Prefers native JSON; also supports normalized JSONL, repository package-vulnerability CSV, and gzip; does not import workload secrets or cloud configuration, run a scan, assess findings, or synchronize triage decisions.
---

# Publish external findings

Use the installed `codex-security publish findings` command for preview and import. Select `--to local` for the local workbench or `--to cloud` for Cloud. The command owns source mapping, persistence, and Cloud authentication and retries. Do not implement another store or uploader or put credentials in command arguments.

## Select the evidence

Read [Wiz import formats](references/wiz-import.md#finding-formats) before preparing input. Use an authorized [Wiz MCP](https://www.wiz.io/blog/introducing-wiz-mcp) or Wiz API connection; a configured plugin may provide it, but do not assume an official Codex plugin is available. Prefer supported native JSON. Inspect actual records, finish the requested pagination, and save only the selected evidence with its original occurrence IDs. A supplied export is also supported. Summaries, Wiz Issues, and local CLI scan results are not automatically supported finding records.

Validate the acquisition path against actual responses from an authorized Wiz tenant; local parser checks do not establish that qualification. Direct CSV input covers repository package vulnerabilities (SCA) only, not SAST or cloud posture findings, and does not provide a complete Wiz code-to-cloud integration.

Use the same acquisition format for repeated imports. Normalized JSONL and the documented CSV profile are compatibility inputs; do not convert richer JSON to SARIF. Check identity rules before switching formats: another format can create a separate record or replace richer evidence. Imports do not reconcile equivalent findings across formats. `--format json` controls command output, not the input format.

Use a stable Wiz tenant/finding namespace as `--source-key`; a project filter does not create a new identity. Confirm the selected assets or builds belong to the destination repository. Do not infer source branches or revisions from the current checkout, invent missing evidence, or import vendor credentials, unrelated records, or local assessments as original scanner evidence. Do not retrieve or test credentials or apply suggested fixes.

## Import locally

Use a local repository path with `--repository`. No Cloud login is required.

```sh
codex-security publish findings /path/to/selected-wiz-findings.json \
  --to local --repository /path/to/project --provider wiz \
  --source-key TENANT_ID/vulnerability-finding --dry-run --format json
```

Show the repository, source namespace, normalized evidence, and exclusions. After confirmation, repeat without `--dry-run`, adding `--yes`. Keep approval when the user already approved this preview and the input and destination are unchanged.

Read the stored evidence with `codex-security findings imported /path/to/project --format json`; the repository defaults to the current directory. Report created, updated, unchanged, and excluded counts, including exclusion reasons when the command exits 1.

Local records remain unassessed source evidence, separate from `findings list` and completed scans. Repeated imports use the same repository/provider/source-key/source-ID identity; omitted records remain stored. When a source repository URL and local Git remotes are available, the URL must match a remote. Local import does not publish to Cloud or automatically investigate or patch findings.

## Publish to Cloud

Resolve the user's destination to a connected GitHub or GitHub Enterprise repository URL or Cloud repository ID, including custom Enterprise hosts. Confirm the intended Cloud account and an authorized repository environment. Use the existing file-backed ChatGPT login; explain a missing or incompatible login rather than changing credential storage automatically.

For another Cloud deployment, read [Deployment settings](references/wiz-import.md#deployment-settings) before previewing. Keep the selected deployment and login throughout the upload.

### Preview and approve

```sh
codex-security publish findings /path/to/selected-wiz-findings.json \
  --to cloud --repository https://github.com/example/project --provider wiz \
  --source-key TENANT_ID/vulnerability-finding --dry-run --format json
```

Show the Cloud API endpoint, account, repository, environments, source namespace, severity counts, and exclusions. Identify the evidence file and make the complete JSON preview available for inspection without pasting a large report into the conversation. Explain that vendor evidence is not a Codex assessment.

Obtain explicit confirmation for this concrete upload, including skipped records. Then run the same command without `--dry-run`, adding `--yes`. Authorization to inspect or assess findings alone does not authorize sending them to Cloud. Keep approval when the user already approved this preview and the input and destination are unchanged.

### Upload and report

Read [Results and recovery](references/wiz-import.md#results-and-recovery), including when the process exits nonzero. After a lost response or retryable failure, repeat the command with unchanged input and destination so the publisher resumes saved requests. A lost response does not mean nothing reached Cloud. A repository reset requires fresh discovery and confirmation before a new publication.

Report verified, unacknowledged, excluded, and failed records distinctly, retaining source IDs and recovery details. Receipts and source-record readback confirm stored vendor evidence; they do not establish a Codex assessment or visibility in the shared Cloud Findings view. Include the returned `cloudUrl` as a clickable repository link when available; do not invent a UI link from the API endpoint.
