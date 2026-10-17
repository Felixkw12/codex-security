"""Preserve selected Deep Scan publications across main contract normalization."""

from __future__ import annotations

import copy
import hashlib
import json
from argparse import Namespace

import pytest
from test_deep_scan_publication_authority import stage_publication
from test_deep_scan_successful_publication import publication_scan as publication_scan


def selected_publication(api, connection, scan, *, legacy_completeness=None):
    if legacy_completeness is not None:
        scan.coverage["completeness"] = legacy_completeness
        coverage_path = scan.scan_dir / "coverage.json"
        coverage = json.loads(coverage_path.read_bytes())
        coverage["completeness"] = legacy_completeness
        coverage_path.write_text(json.dumps(coverage))
    result = scan.scan_dir / "accepted.json"
    result.write_text(
        json.dumps(
            {
                "scanId": scan.scan_id,
                "complete": True,
                "findings": scan.findings,
                "sourceCoverage": scan.coverage,
            }
        )
    )
    row = api["require_scan"](connection, scan.scan_id)
    prepared = api["_prepare_scan_finalization"](
        scan.scan_dir,
        expected_coverage_mode=api["expected_coverage_mode"](row),
        completion_binding=api["workbench_completion_binding"](row, api["now"]()),
    )
    manifest = copy.deepcopy(prepared[2])
    coverage = copy.deepcopy(prepared[4])
    if legacy_completeness is not None:
        coverage["completeness"] = legacy_completeness
        coverage_bytes = (json.dumps(coverage, indent=2, sort_keys=True) + "\n").encode()
        for artifact in manifest["scan"]["artifacts"]:
            if artifact["path"] == "coverage.json":
                artifact["sha256"] = hashlib.sha256(coverage_bytes).hexdigest()
    for key in ("completedAt", "sealedAt"):
        manifest["scan"].pop(key, None)
    encoded = json.dumps(
        [manifest, prepared[3], coverage], sort_keys=True, separators=(",", ":")
    ).encode()
    selection = {
        "version": 1,
        "resultPath": result.name,
        "resultSha256": hashlib.sha256(result.read_bytes()).hexdigest(),
        "publicationSha256": hashlib.sha256(encoded).hexdigest(),
        "terminalReason": "saturated",
        "omittedWorkerIds": [],
        "selectedAt": scan.timestamp,
    }
    with connection:
        connection.execute(
            "UPDATE deep_scan_runs SET workflow_version = 'deep-security-scan/v2', "
            "coordinator_generation = 2, finalization_input_json = ? WHERE scan_id = ?",
            (json.dumps(selection), scan.scan_id),
        )
    return result


@pytest.mark.parametrize("legacy_completeness", ["complete", "partial", "unknown"])
@pytest.mark.parametrize("cut", ["before", "after"])
def test_selected_replays_historical_publication_across_normalization(
    workbench_api, workbench_db, publication_scan, monkeypatch, legacy_completeness, cut
):
    scan = publication_scan()
    selected_publication(workbench_api, workbench_db, scan, legacy_completeness=legacy_completeness)
    selection = workbench_db.execute(
        "SELECT finalization_input_json FROM deep_scan_runs"
    ).fetchone()[0]
    namespace = workbench_api["complete_scan_locked"].__globals__
    write = namespace["_write_prepared_scan_finalization"]

    def interrupted_write(*args, **kwargs):
        if cut == "after":
            write(*args, **kwargs)
        raise RuntimeError("Interrupted parent completion")

    args = Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None)
    with monkeypatch.context() as patch:
        patch.setitem(namespace, "_write_prepared_scan_finalization", interrupted_write)
        with pytest.raises(RuntimeError, match="Interrupted parent completion"):
            workbench_api["complete_scan"](workbench_db, args)
    assert workbench_db.execute("SELECT status FROM scans").fetchone()[0] == "running"
    if cut == "after":
        assert "completeness" not in json.loads((scan.scan_dir / "coverage.json").read_bytes())
    workbench_api["complete_scan"](workbench_db, args)
    assert workbench_db.execute("SELECT status FROM scans").fetchone()[0] == "complete"
    assert (
        workbench_db.execute("SELECT finalization_input_json FROM deep_scan_runs").fetchone()[0]
        == selection
    )
    sealed = {p: p.read_bytes() for p in scan.scan_dir.rglob("*.json")}
    workbench_api["complete_scan"](workbench_db, args)
    assert {p: p.read_bytes() for p in sealed} == sealed


@pytest.mark.parametrize("damage", [None, "findings", "coverage", "selected"])
@pytest.mark.parametrize("legacy_completeness", [None, "complete", "partial", "unknown"])
def test_selected_completion_validates_saved_publication(
    workbench_api, workbench_db, publication_scan, damage, legacy_completeness
):
    scan = publication_scan()
    selected = selected_publication(
        workbench_api, workbench_db, scan, legacy_completeness=legacy_completeness
    )
    if damage == "selected":
        selected.write_bytes(selected.read_bytes() + b"\n")
    elif damage is not None:
        path = scan.scan_dir / f"{damage}.json"
        document = json.loads(path.read_bytes())
        if damage == "findings":
            document["findings"][0]["remediation"] = "Substituted repair."
        else:
            document["completeness"] = "partial"
            document["deferred"] = [
                {"id": "changed-coverage", "reason": "Substituted unresolved review."}
            ]
        path.write_text(json.dumps(document))
    before = {p: p.read_bytes() for p in scan.scan_dir.rglob("*.json")}
    state = "\n".join(workbench_db.iterdump())
    args = Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None)
    if damage is None:
        workbench_api["complete_scan"](workbench_db, args)
        sealed = {p: p.read_bytes() for p in scan.scan_dir.rglob("*.json")}
        workbench_api["complete_scan"](workbench_db, args)
        assert {p: p.read_bytes() for p in sealed} == sealed
    else:
        with pytest.raises(SystemExit, match="publication|changed after acceptance"):
            workbench_api["complete_scan"](workbench_db, args)
        assert "\n".join(workbench_db.iterdump()) == state
        assert {p: p.read_bytes() for p in before} == before


def test_selected_historical_publication_still_binds_receipt_bytes(
    workbench_api, workbench_db, publication_scan
):
    scan = publication_scan()
    receipt = scan.scan_dir / "artifacts" / "review.json"
    receipt.parent.mkdir()
    receipt.write_text('{"review": "original"}\n')
    scan.coverage["surfaces"] = [
        {
            "id": "saved-review",
            "label": "Synthetic saved review",
            "disposition": "no_issue_found",
            "receiptRefs": ["artifacts/review.json"],
        }
    ]
    (scan.scan_dir / "coverage.json").write_text(json.dumps(scan.coverage))
    selected_publication(workbench_api, workbench_db, scan, legacy_completeness="complete")
    receipt.write_text('{"review": "substituted"}\n')
    state = "\n".join(workbench_db.iterdump())
    files = {p: p.read_bytes() for p in scan.scan_dir.rglob("*.json")}
    with pytest.raises(SystemExit, match="publication"):
        workbench_api["complete_scan"](
            workbench_db, Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None)
        )
    assert "\n".join(workbench_db.iterdump()) == state
    assert {p: p.read_bytes() for p in files} == files


@pytest.mark.parametrize("damage", [None, "draft", "selected"])
@pytest.mark.parametrize("legacy_completeness", [None, "partial"])
def test_selected_republication_checks_identity_before_writing_checkpoints(
    workbench_api, workbench_db, publication_scan, damage, legacy_completeness
):
    scan = publication_scan()
    result = selected_publication(
        workbench_api, workbench_db, scan, legacy_completeness=legacy_completeness
    )
    staged = stage_publication(
        scan,
        generation=2,
        result_path=result,
        title="Substituted aggregate" if damage == "draft" else scan.findings[0]["title"],
    )
    if damage == "selected":
        result.write_bytes(result.read_bytes() + b"\n")
    before = {p: p.read_bytes() for p in scan.scan_dir.rglob("*.json")}
    state = "\n".join(workbench_db.iterdump())
    if damage is None:
        result = workbench_api["saved_results"].write_scan_draft(
            workbench_api["_WORKBENCH_DB_CONTEXT"], workbench_db, staged
        )
        assert result["status"] == "draft_written"
        workbench_api["complete_scan"](
            workbench_db, Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None)
        )
        return
    with pytest.raises(
        workbench_api["ContractError"], match="publication|changed after acceptance"
    ):
        workbench_api["saved_results"].write_scan_draft(
            workbench_api["_WORKBENCH_DB_CONTEXT"], workbench_db, staged
        )
    assert {p: p.read_bytes() for p in scan.scan_dir.rglob("*.json")} == before
    assert "\n".join(workbench_db.iterdump()) == state


def test_selected_zero_discovery_deadline_preserves_the_published_draft(
    workbench_api, workbench_db, publication_scan
):
    scan = publication_scan()
    scan.findings = []
    scan.coverage["deferred"] = [
        {
            "id": "deadline",
            "reason": "The configured discovery time limit elapsed before source review completed.",
        }
    ]
    selection = {
        "version": 1,
        "resultPath": None,
        "terminalReason": "capped",
        "omittedWorkerIds": [],
        "selectedAt": scan.timestamp,
    }
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_runs SET workflow_version = 'deep-security-scan/v2', "
            "coordinator_generation = 2, status = 'running', phase = 'terminal', "
            "terminal_reason = 'capped', completed_at = NULL, "
            "created_at = '2000-01-01T00:00:00Z', max_time_hours = 1, "
            "finalization_input_json = ? WHERE scan_id = ?",
            (json.dumps(selection), scan.scan_id),
        )
    draft_dir = scan.scan_dir / "drafts"
    draft_dir.mkdir()
    draft_path = draft_dir / "00000000-0000-4000-8000-000000000001.json"
    draft_path.write_text(
        json.dumps(
            {
                "manifest": json.loads((scan.scan_dir / "scan-manifest.json").read_text()),
                "findings": {"findings": []},
                "coverage": scan.coverage,
                "deepScanPublication": {"coordinatorGeneration": 2, "resultPath": None},
            }
        )
    )
    workbench_api["saved_results"].write_scan_draft(
        workbench_api["_WORKBENCH_DB_CONTEXT"],
        workbench_db,
        Namespace(
            scan_id=scan.scan_id,
            claim_token=None,
            draft_path=str(draft_path),
            checkpoint_path=None,
            expected_draft_digest=None,
        ),
    )
    selection_json = workbench_db.execute(
        "SELECT finalization_input_json FROM deep_scan_runs"
    ).fetchone()[0]
    assert "publicationSha256" in json.loads(selection_json)
    before = {path: path.read_bytes() for path in scan.scan_dir.rglob("*.json")}
    finish = Namespace(
        scan_id=scan.scan_id,
        terminal_reason="capped",
        omitted_worker_id=[],
        manifest_path=str(scan.scan_dir / "scan-manifest.json"),
        staged_manifest_path=None,
        coordinator_generation=2,
    )
    deep = workbench_api["deep_scan"]
    deep.finish_deep_scan(workbench_db, finish)
    assert workbench_db.execute("SELECT status FROM deep_scan_runs").fetchone()[0] == "succeeded"
    assert {path: path.read_bytes() for path in scan.scan_dir.rglob("*.json")} == before
    completion = Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None)
    workbench_api["complete_scan"](workbench_db, completion)
    assert workbench_db.execute("SELECT status FROM scans").fetchone()[0] == "complete"
    sealed = {path: path.read_bytes() for path in scan.scan_dir.rglob("*.json")}
    deep.finish_deep_scan(workbench_db, finish)
    workbench_api["complete_scan"](workbench_db, completion)
    assert {path: path.read_bytes() for path in scan.scan_dir.rglob("*.json")} == sealed
    assert (
        workbench_db.execute("SELECT finalization_input_json FROM deep_scan_runs").fetchone()[0]
        == selection_json
    )
