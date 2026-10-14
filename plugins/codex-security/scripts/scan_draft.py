"""Assemble new file-authored scan envelopes before their first write."""

from __future__ import annotations

from typing import Any


def build_scan_draft(
    *, scan: dict[str, Any], findings: list[dict[str, Any]], coverage: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Wrap this run's semantics with one identity without reading or repairing files."""
    scan_id = scan["id"]
    return {
        "scan-manifest.json": {
            "documentType": "codex-security.scan-manifest",
            "schemaVersion": "1.0",
            "scan": {**scan, "findingsRef": "findings.json", "coverageRef": "coverage.json"},
        },
        "findings.json": {
            "documentType": "codex-security.findings",
            "schemaVersion": "1.0",
            "scanId": scan_id,
            "findings": findings,
        },
        "coverage.json": {
            **coverage,
            "documentType": "codex-security.coverage",
            "schemaVersion": "1.0",
            "scanId": scan_id,
        },
    }
