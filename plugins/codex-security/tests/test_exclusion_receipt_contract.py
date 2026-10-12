from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from workbench_test_support import (
    empty_target_scan,
    load_script,
    run_workbench,
    write_completed_contract,
)

FINALIZER = load_script("finalize_scan_contract")
IDENTITY = load_script("candidate_identity")


def exclusion_scan(tmp_path: Path, disposition: str, receipt: str, field="explicitExclusions"):
    state, target, scan_id, scan_dir = empty_target_scan(tmp_path)
    write_completed_contract(scan_dir, scan_id, target)
    findings = json.loads((scan_dir / "findings.json").read_text())
    findings["findings"] = []
    (scan_dir / "findings.json").write_text(json.dumps(findings))
    pending = {
        "id": "saved-proof-gap",
        "candidateId": "candidate-é",
        "sourceWorkerId": "reviewer",
        "reason": "Original candidate proof gap remains unanswered.",
        "paths": ["app.py"],
        "candidate": {"evidence": "Saved evidence", "future": [1, {"value": None}]},
        "futureGapMetadata": {"preserve": ["all", "values"]},
    }
    refs = {
        "valid": ["artifacts/review.bin"],
        "missing": ["artifacts/missing.bin"],
        "unsafe": ["../outside.bin"],
        "malformed": None,
        "none": [],
    }[receipt]
    decision = {
        "id": "review-decision",
        "label": "Reviewed candidate",
        "pattern": "app.py",
        "reason": "Saved terminal decision.",
        "candidateId": pending["candidateId"],
        "sourceWorkerId": pending["sourceWorkerId"],
        "disposition": disposition,
        "receiptRefs": refs,
        "futureDecisionMetadata": {"retained": True},
    }
    coverage = json.loads((scan_dir / "coverage.json").read_text())
    coverage.update(
        completeness="partial",
        surfaces=[],
        explicitExclusions=[],
        deferred=[pending] if receipt in {"missing", "unsafe", "malformed"} else [],
    )
    coverage[field] = [decision]
    (scan_dir / "coverage.json").write_text(json.dumps(coverage))
    if receipt == "valid":
        (scan_dir / "artifacts").mkdir(exist_ok=True)
        (scan_dir / "artifacts/review.bin").write_bytes(bytes([0, 255, 128, 10]))
    return state, scan_id, scan_dir, pending, decision


def publish(state: Path, scan_id: str, scan_dir: Path, entrypoint: str):
    if entrypoint == "workbench":
        run_workbench(state, "complete-scan", "--scan-id", scan_id)
    else:
        completed = subprocess.run(
            [sys.executable, FINALIZER.__file__, "--scan-dir", str(scan_dir)],
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr


@pytest.mark.parametrize("entrypoint", ["standalone", "workbench"])
@pytest.mark.parametrize("disposition", ["rejected", "not_applicable"])
@pytest.mark.parametrize("receipt", ["valid", "missing", "unsafe", "malformed", "none"])
def test_exclusion_proof_recovery_matches_public_entrypoints(
    tmp_path: Path, entrypoint: str, disposition: str, receipt: str
):
    state, scan_id, scan_dir, pending, decision = exclusion_scan(tmp_path, disposition, receipt)
    publish(state, scan_id, scan_dir, entrypoint)
    coverage = json.loads((scan_dir / "coverage.json").read_text())
    reopened = receipt in {"missing", "unsafe", "malformed"}
    assert len(IDENTITY.unresolved_candidates(coverage, [])) == int(reopened)
    assert (
        coverage["explicitExclusions"][0]["futureDecisionMetadata"]
        == decision["futureDecisionMetadata"]
    )
    assert coverage["explicitExclusions"][0]["disposition"] == (
        "needs_follow_up" if reopened else disposition
    )
    report = (scan_dir / "report.md").read_text()
    assert (pending["reason"] in report) is reopened
    if reopened:
        assert pending in coverage["deferred"]
        assert coverage["completeness"] == "partial"
    sarif = json.loads((scan_dir / "exports/results.sarif").read_text())
    assert sarif["runs"][0]["results"] == []
    before = {
        name: (scan_dir / name).read_bytes()
        for name in (
            "scan-manifest.json",
            "findings.json",
            "coverage.json",
            "report.md",
            "exports/results.sarif",
        )
    }
    FINALIZER.finalize_scan(scan_dir)
    assert all((scan_dir / name).read_bytes() == contents for name, contents in before.items())


@pytest.mark.parametrize("entrypoint", ["standalone", "workbench"])
@pytest.mark.parametrize("field", ["surfaces", "explicitExclusions"])
@pytest.mark.parametrize("change", ["delete", "modify"])
def test_exclusion_and_surface_proof_are_sealed_and_verified(
    tmp_path: Path, entrypoint: str, field: str, change: str
):
    state, scan_id, scan_dir, _, _ = exclusion_scan(tmp_path, "rejected", "valid", field)
    publish(state, scan_id, scan_dir, entrypoint)
    manifest = json.loads((scan_dir / "scan-manifest.json").read_text())
    receipt = scan_dir / "artifacts/review.bin"
    if change == "delete":
        receipt.unlink()
    else:
        receipt.write_bytes(b"Changed proof")
    with pytest.raises(FINALIZER.ContractError):
        FINALIZER.finalize_scan(scan_dir)
    exported = subprocess.run(
        [sys.executable, FINALIZER.__file__, "--scan-dir", str(scan_dir), "--sarif-only"],
        capture_output=True,
        text=True,
    )
    assert exported.returncode != 0
    assert "artifacts/review.bin" in {item["path"] for item in manifest["scan"]["artifacts"]}


def test_sealed_exclusion_cannot_reference_proof_outside_its_artifact_inventory(tmp_path: Path):
    state, scan_id, scan_dir, _, _ = exclusion_scan(tmp_path, "rejected", "valid")
    publish(state, scan_id, scan_dir, "standalone")
    path = scan_dir / "scan-manifest.json"
    manifest = json.loads(path.read_text())
    manifest["scan"]["artifacts"] = [
        item for item in manifest["scan"]["artifacts"] if item["path"] != "artifacts/review.bin"
    ]
    path.write_text(json.dumps(manifest))
    with pytest.raises(FINALIZER.ContractError, match="missing from sealed artifacts"):
        FINALIZER.finalize_scan(scan_dir)
