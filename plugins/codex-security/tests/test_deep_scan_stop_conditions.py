from __future__ import annotations

import copy
import json
import os
import sqlite3
from argparse import Namespace

import pytest
from test_deep_scan_successful_publication import (
    add_worker,
    assert_published_aggregate,
    complete,
)
from test_deep_scan_successful_publication import (
    publication_scan as publication_scan,
)
from workbench_test_support import saved_draft, write_checkpoint


@pytest.fixture
def saturated_scan(publication_scan, workbench_db):
    scan = publication_scan()
    completed_result = add_worker(workbench_db, scan)
    completed_result.write_text(
        json.dumps(
            {
                "scanId": scan.scan_id,
                "complete": True,
                "findings": scan.findings,
                "coverage": scan.coverage,
            }
        )
    )
    reducer_result = add_worker(workbench_db, scan)
    reducer_result.write_bytes(completed_result.read_bytes())
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_workers SET completion_sequence = 1 WHERE id = ?",
            (completed_result.parent.name,),
        )
        workbench_db.execute(
            "UPDATE deep_scan_workers SET kind = 'dedup', merge_state = 'none' WHERE id = ?",
            (reducer_result.parent.name,),
        )
        workbench_db.execute(
            "INSERT INTO deep_scan_dedup_inputs "
            "(scan_id, dedup_worker_id, discovery_worker_id, input_order) VALUES (?, ?, ?, 0)",
            (scan.scan_id, reducer_result.parent.name, completed_result.parent.name),
        )
        workbench_db.execute(
            "UPDATE deep_scan_runs SET status = 'running', phase = 'discovery', "
            "consecutive_no_new = stop_after_no_new, completion_sequence = 1, "
            "max_discovery_runs = 3, discovery_runs_dispatched = 1, "
            "manifest_path = NULL, terminal_reason = NULL, completed_at = NULL WHERE scan_id = ?",
            (scan.scan_id,),
        )
    scan.completed_worker_id = completed_result.parent.name
    scan.reducer_id = reducer_result.parent.name
    return scan


def finish(workbench_api, connection, scan, *, terminal_reason="saturated"):
    return workbench_api["deep_scan"].finish_deep_scan(
        connection,
        Namespace(
            scan_id=scan.scan_id,
            terminal_reason=terminal_reason,
            manifest_path=str(scan.scan_dir / "scan-manifest.json"),
            staged_manifest_path=None,
            omitted_worker_id=[],
        ),
    )["deepScan"]


def test_saturated_finish_cancels_unfinished_discovery_without_using_its_drafts(
    workbench_api, workbench_db, saturated_scan
):
    scan = saturated_scan
    unfinished = []
    for status in ("queued", "running"):
        result = add_worker(workbench_db, scan, status=status)
        result.write_text("{unfinished worker draft")
        unfinished.append(result)

    finished = finish(workbench_api, workbench_db, scan)

    assert finished["status"] == "succeeded"
    assert finished["terminalReason"] == "saturated"
    workers = {worker["id"]: worker for worker in finished["workers"]}
    assert workers[scan.completed_worker_id]["status"] == "succeeded"
    assert workers[scan.reducer_id]["status"] == "succeeded"
    for result in unfinished:
        worker = workers[result.parent.name]
        assert worker["status"] == "canceled"
        assert worker["completedAt"] is not None
        assert worker["completionSequence"] is None
        assert worker["mergeState"] == "none"
        assert result.read_text() == "{unfinished worker draft"

    complete(workbench_api, workbench_db, scan)
    assert_published_aggregate(scan)


def test_saturated_finish_retains_failed_discovery_diagnostic(
    workbench_api, workbench_db, saturated_scan
):
    scan = saturated_scan
    result = add_worker(workbench_db, scan, status="failed")
    error = "Worker stopped while persisting its result."
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_workers SET error_message = ? WHERE id = ?",
            (error, result.parent.name),
        )

    finished = finish(workbench_api, workbench_db, scan)

    assert finished["status"] == "succeeded"
    failed_worker = next(
        worker for worker in finished["workers"] if worker["id"] == result.parent.name
    )
    assert failed_worker["status"] == "failed"
    assert failed_worker["error"] == error
    complete(workbench_api, workbench_db, scan)
    assert_published_aggregate(scan)


@pytest.mark.parametrize("stop", ["deadline", "run-limit", "saturated"])
def test_unfinished_checkpoints_after_a_completed_reduction(
    workbench_api, workbench_db, saturated_scan, stop
):
    scan = saturated_scan
    result = add_worker(workbench_db, scan, status="canceled")
    recovered = copy.deepcopy(scan.findings[0])
    recovered["identity"]["anchor"] = "unfinished-upload-review"
    recovered["title"] = "Separate upload handler bypasses containment"
    recovered["provenance"] = {"source": "local_plugin"}
    duplicate = copy.deepcopy(scan.findings[0])
    duplicate["severity"]["level"] = "critical"
    duplicate["remediation"] = "Unreduced remediation from an unfinished review."
    pending = {
        "id": "pending-upload",
        "reason": "The remaining upload paths need review.",
        "paths": ["subdir/extract.py"],
        "surfaceIds": ["upload"],
    }
    checkpoint = write_checkpoint(
        result.parent / "checkpoints",
        saved_draft(
            scan.scan_id,
            findings=[recovered, duplicate],
            deferred=[pending],
            surfaces=[
                {
                    "id": "upload",
                    "label": "Upload handler",
                    "disposition": "needs_follow_up",
                    "receiptRefs": [],
                }
            ],
        ),
    )
    source_bytes = checkpoint.read_bytes()
    # Earlier parent, discovery, and reducer drafts must not undo reduction.
    discarded = copy.deepcopy(recovered)
    discarded["identity"]["anchor"] = "discarded-during-reduction"
    for directory in (
        scan.scan_dir,
        scan.scan_dir / "workers" / scan.completed_worker_id,
        scan.scan_dir / "workers" / scan.reducer_id,
    ):
        discarded_checkpoint = write_checkpoint(
            directory / "checkpoints",
            saved_draft(scan.scan_id, findings=[discarded]),
        )
        if directory == scan.scan_dir:
            head = directory / "checkpoint-head.json"
            head.write_text(json.dumps({"checkpoint": discarded_checkpoint.name}))
            observed = (
                max(
                    (directory / name).stat().st_mtime_ns
                    for name in ("scan-manifest.json", "findings.json", "coverage.json")
                )
                + 1_000_000_000
            )
            for path in (discarded_checkpoint, head):
                os.utime(path, ns=(observed, observed))
    with workbench_db:
        if stop == "deadline":
            workbench_db.execute(
                "UPDATE deep_scan_runs SET created_at = '2000-01-01T00:00:00+00:00' "
                "WHERE scan_id = ?",
                (scan.scan_id,),
            )
        elif stop == "run-limit":
            workbench_db.execute(
                "UPDATE deep_scan_runs SET discovery_runs_dispatched = max_discovery_runs "
                "WHERE scan_id = ?",
                (scan.scan_id,),
            )

    reason = "saturated" if stop == "saturated" else "capped"
    finished = finish(workbench_api, workbench_db, scan, terminal_reason=reason)

    assert finished["status"] == "succeeded"
    worker = next(item for item in finished["workers"] if item["id"] == result.parent.name)
    assert worker["status"] == "canceled"
    assert worker["completionSequence"] is None
    row = workbench_db.execute(
        "SELECT status, seal_manifest_digest FROM scans WHERE id = ?", (scan.scan_id,)
    ).fetchone()
    assert tuple(row) == ("running", None)
    manifest = json.loads((scan.scan_dir / "scan-manifest.json").read_text())
    assert "sealedAt" not in manifest["scan"]
    completed = complete(workbench_api, workbench_db, scan)
    assert completed["progress"]["status"] == "complete"
    findings = json.loads((scan.scan_dir / "findings.json").read_text())["findings"]
    expected_anchors = {scan.findings[0]["identity"]["anchor"]}
    if stop == "deadline":
        expected_anchors.add(recovered["identity"]["anchor"])
        retained = next(item for item in findings if item["title"] == recovered["title"])
        assert retained["provenance"]["workerId"] == result.parent.name
        assert (
            checkpoint.relative_to(scan.scan_dir).as_posix() in manifest["scan"]["preservedSources"]
        )
    assert {item["identity"]["anchor"] for item in findings} == expected_anchors
    canonical = next(item for item in findings if item["title"] == scan.findings[0]["title"])
    for field in ("severity", "confidence", "remediation"):
        assert canonical[field] == scan.findings[0][field]
    assert (
        canonical["provenance"]["sourceFindings"]
        == scan.findings[0]["provenance"]["sourceFindings"]
    )
    if stop == "deadline":
        assert any(
            item["remediation"] == duplicate["remediation"]
            for item in canonical["provenance"]["previousFindings"]
        )
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    assert any(item["reason"] == pending["reason"] for item in coverage["deferred"]) == (
        stop == "deadline"
    )
    assert any(item["disposition"] == "needs_follow_up" for item in coverage["surfaces"]) == (
        stop == "deadline"
    )
    assert checkpoint.read_bytes() == source_bytes
    names = ("scan-manifest.json", "findings.json", "coverage.json", "report.md")
    sealed = {name: (scan.scan_dir / name).read_bytes() for name in names}
    finish(workbench_api, workbench_db, scan, terminal_reason=reason)
    complete(workbench_api, workbench_db, scan)
    assert {name: (scan.scan_dir / name).read_bytes() for name in names} == sealed


def test_deadline_after_all_reviews_complete_keeps_reduced_coverage(
    workbench_api, workbench_db, saturated_scan
):
    scan = saturated_scan
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_runs SET created_at = '2000-01-01T00:00:00+00:00' WHERE scan_id = ?",
            (scan.scan_id,),
        )

    finish(workbench_api, workbench_db, scan, terminal_reason="capped")
    complete(workbench_api, workbench_db, scan)

    assert_published_aggregate(scan)


@pytest.mark.parametrize(
    ("terminal_reason", "kind"),
    [("saturated", "setup"), ("saturated", "dedup"), ("capped", "discovery")],
    ids=["saturated-setup", "saturated-reducer", "capped-discovery"],
)
def test_finish_preserves_other_worker_failure_checks(
    workbench_api, workbench_db, saturated_scan, terminal_reason, kind
):
    scan = saturated_scan
    result = add_worker(workbench_db, scan, status="failed")
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_workers SET kind = ? WHERE id = ?", (kind, result.parent.name)
        )
        if terminal_reason == "capped":
            workbench_db.execute(
                "UPDATE deep_scan_runs SET discovery_runs_dispatched = max_discovery_runs "
                "WHERE scan_id = ?",
                (scan.scan_id,),
            )

    with pytest.raises(SystemExit, match="after a worker has failed"):
        finish(workbench_api, workbench_db, scan, terminal_reason=terminal_reason)

    run = workbench_db.execute(
        "SELECT status, terminal_reason FROM deep_scan_runs WHERE scan_id = ?", (scan.scan_id,)
    ).fetchone()
    assert tuple(run) == ("running", None)


@pytest.mark.parametrize("existing_head", [False, True])
@pytest.mark.parametrize("with_reduction", [False, True], ids=["zero-accepted", "reduced"])
def test_rejected_deadline_publication_does_not_leave_parent_observations(
    workbench_api, workbench_db, publication_scan, request, existing_head, with_reduction
):
    scan = request.getfixturevalue("saturated_scan") if with_reduction else publication_scan()
    canonical_names = ("scan-manifest.json", "findings.json", "coverage.json")
    for name in canonical_names:
        os.utime(scan.scan_dir / name, ns=(1_000_000_000, 1_000_000_000))
    pending = {"id": "authorization-review", "reason": "Review the remaining authorization path."}
    if with_reduction:
        result = add_worker(workbench_db, scan, status="canceled")
        write_checkpoint(
            result.parent / "checkpoints",
            saved_draft(scan.scan_id, deferred=[pending]),
        )
    if existing_head:
        checkpoint = write_checkpoint(
            scan.scan_dir / "checkpoints",
            saved_draft(scan.scan_id, findings=scan.findings, deferred=[pending]),
        )
        head = scan.scan_dir / "checkpoint-head.json"
        head.write_text(json.dumps({"checkpoint": checkpoint.name}))
        for path in (checkpoint, head):
            os.utime(path, ns=(2_000_000_000, 2_000_000_000))
    saved = workbench_api["saved_results"]

    def observations():
        return {
            relative: (
                (scan.scan_dir / relative).read_bytes(),
                (scan.scan_dir / relative).stat().st_mtime_ns,
            )
            for relative, _ in saved._saved_result_paths(scan.scan_dir, [])
            if (scan.scan_dir / relative).is_file()
        }

    before = observations()
    artifacts = {
        name: ((scan.scan_dir / name).read_bytes(), (scan.scan_dir / name).stat().st_mtime_ns)
        for name in canonical_names
    }
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_runs SET status = 'running', phase = 'discovery', "
            "created_at = '2000-01-01T00:00:00+00:00', manifest_path = NULL, "
            "terminal_reason = NULL, completed_at = NULL WHERE scan_id = ?",
            (scan.scan_id,),
        )
        workbench_db.execute(
            "CREATE TRIGGER reject_deadline_commit BEFORE UPDATE OF status ON deep_scan_runs "
            "WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'deadline commit failed'); END"
        )
    with pytest.raises(sqlite3.IntegrityError, match="deadline commit failed"):
        finish(workbench_api, workbench_db, scan, terminal_reason="capped")

    assert observations() == before
    assert {
        name: ((scan.scan_dir / name).read_bytes(), (scan.scan_dir / name).stat().st_mtime_ns)
        for name in artifacts
    } == artifacts
    assert (
        workbench_db.execute(
            "SELECT status FROM deep_scan_runs WHERE scan_id = ?", (scan.scan_id,)
        ).fetchone()[0]
        == "running"
    )
    with workbench_db:
        workbench_db.execute("DROP TRIGGER reject_deadline_commit")
    assert (
        finish(workbench_api, workbench_db, scan, terminal_reason="capped")["status"] == "succeeded"
    )
    if existing_head:
        coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
        assert any(item["reason"] == pending["reason"] for item in coverage["deferred"])
