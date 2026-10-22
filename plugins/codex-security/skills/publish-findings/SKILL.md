---
name: publish-findings
description: Import selected Wiz package vulnerabilities, SAST, repository secrets, and IaC findings to Codex Security Cloud after previewing the destination and evidence. Supports plain or gzip-compressed JSON and normalized JSONL; does not import workload secrets or cloud configuration, run a scan, or assess findings.
---

# Publish external findings

Use the installed `codex-security publish findings` command for preview and upload. It owns source mapping, Cloud authentication, source versions, and saved request retries. Do not implement another HTTP uploader or put credentials in command arguments.

## Select the evidence and destination

Resolve the user's destination to a connected GitHub or GitHub Enterprise repository URL or Cloud repository ID, including custom Enterprise hosts. Confirm the intended Cloud account and an authorized repository environment. Use the existing file-backed ChatGPT login; explain a missing or incompatible login rather than changing credential storage automatically.

Read [Wiz import formats](references/wiz-import.md#finding-formats) before preparing input. Prefer the user's configured Wiz plugin or authorized [Wiz MCP](https://www.wiz.io/blog/introducing-wiz-mcp) connection; use an authorized Wiz API connection when MCP lacks the required records. A supplied export is also supported. Inspect actual records, finish the requested pagination, and save only the selected evidence with its original occurrence IDs. Summaries, Wiz Issues, and local CLI scan results are not automatically supported finding records.

Use a stable Wiz tenant/finding namespace as `--source-key`; a project filter does not create a new identity. Confirm the selected assets or builds belong to the destination repository. Do not infer source branches or revisions from the current checkout, invent missing evidence, or publish vendor credentials, unrelated records, or local assessments as original scanner evidence. Do not retrieve or test credentials or apply suggested fixes.

For another Cloud deployment, read [Deployment settings](references/wiz-import.md#deployment-settings) before previewing. Keep the selected deployment and login throughout the upload.

## Preview and approve

```sh
codex-security publish findings /path/to/selected-wiz-findings.json \
  --to cloud --repository https://github.com/example/project --provider wiz \
  --source-key TENANT_ID/vulnerability-finding --dry-run --format json
```

Show the Cloud API endpoint, account, repository, environments, source namespace, severity counts, and exclusions. Identify the evidence file and make the complete JSON preview available for inspection without pasting a large report into the conversation. Explain that vendor evidence is not a Codex assessment.

Obtain explicit confirmation for this concrete upload, including skipped records. Then run the same command without `--dry-run`, adding `--yes`. Authorization to inspect or assess findings alone does not authorize sending them to Cloud. Keep approval when the user has already approved this preview and the input and destination are unchanged.

## Upload and report

Read [Results and recovery](references/wiz-import.md#results-and-recovery), including when the process exits nonzero. After a lost response or retryable failure, repeat the command with unchanged input and destination so the publisher resumes saved requests. A lost response does not mean nothing reached Cloud. A repository reset requires fresh discovery and confirmation before a new publication.

Report verified, unacknowledged, excluded, and failed records distinctly, retaining source IDs and recovery details. Receipts and source-record readback confirm stored vendor evidence; they do not establish a Codex assessment or visibility in the shared Cloud Findings view. Include the returned `cloudUrl` as a clickable repository link when available; do not invent a UI link from the API endpoint.
