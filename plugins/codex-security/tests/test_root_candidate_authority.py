from __future__ import annotations

import copy
import json
import os
from argparse import Namespace

import pytest
from test_deep_scan_successful_publication import complete
from test_deep_scan_successful_publication import publication_scan as publication_scan
from workbench_test_support import saved_draft, write_checkpoint


def canonical_disposition(scan, disposition, complete_marker):
    findings = copy.deepcopy(scan.findings)
    if disposition == "rejected":
        findings = []
    else:
        field = "provenance" if disposition == "provenance-reported" else "extensions"
        findings[0].setdefault(field, {})["candidateId"] = "candidate-review"
    coverage = {
        **scan.coverage,
        "surfaces": [
            {
                "id": "reviewed-surface",
                "candidateId": "candidate-review",
                "label": "Reviewed surface",
                "disposition": disposition.removeprefix("provenance-"),
                "receiptRefs": [],
            }
        ],
        "deferred": [],
    }
    manifest = json.loads((scan.scan_dir / "scan-manifest.json").read_text())
    if complete_marker:
        manifest["scan"]["complete"] = True
    for name, document in (
        ("scan-manifest.json", manifest),
        ("findings.json", {"findings": findings}),
        ("coverage.json", coverage),
    ):
        path = scan.scan_dir / name
        path.write_text(json.dumps(document))
        os.utime(path, ns=(200, 200))


@pytest.mark.parametrize("disposition", ["reported", "rejected", "provenance-reported"])
@pytest.mark.parametrize("complete_marker", [False, True], ids=["legacy-terminal", "terminal"])
@pytest.mark.parametrize("pending_time", [100, 200, 300], ids=["older", "tied", "newer"])
@pytest.mark.parametrize("flow", ["complete", "prepare", "stop", "interrupted-stop"])
def test_canonical_candidate_resolution_keeps_legacy_checkpoint_authority(
    workbench_api,
    workbench_db,
    publication_scan,
    monkeypatch,
    disposition,
    complete_marker,
    pending_time,
    flow,
):
    scan = publication_scan(mode="standard")
    pending = saved_draft(
        scan.scan_id,
        deferred=[{"candidateId": "candidate-review", "reason": "Validation is pending."}],
    )
    checkpoint = write_checkpoint(scan.scan_dir / "checkpoints", pending)
    os.utime(checkpoint, ns=(pending_time, pending_time))
    canonical_disposition(scan, disposition, complete_marker)
    original = checkpoint.read_bytes()
    saved = workbench_api["saved_results"]
    context = workbench_api["_WORKBENCH_DB_CONTEXT"]
    prepared_coverage = []
    write = saved._write_prepared_scan_finalization

    def publish(prepared, **kwargs):
        prepared_coverage.append(copy.deepcopy(prepared[4]))
        if flow == "interrupted-stop":
            raise OSError("Synthetic candidate publication interruption")
        return write(prepared, **kwargs)

    if flow in {"complete", "prepare"}:
        completed = complete(workbench_api, workbench_db, scan, prepare_only=flow == "prepare")
        assert completed["progress"]["status"] == ("running" if flow == "prepare" else "complete")
    else:
        with monkeypatch.context() as patch:
            patch.setattr(saved, "_write_prepared_scan_finalization", publish)
            saved.fail_scan(
                context,
                workbench_db,
                Namespace(
                    scan_id=scan.scan_id, claim_token=None, cost_json=None, message="Stopped."
                ),
            )
        if flow == "interrupted-stop":
            row = workbench_db.execute(
                "SELECT * FROM scans WHERE id = ?", (scan.scan_id,)
            ).fetchone()
            assert row["retained_source_digests_json"]
            assert row["seal_manifest_digest"] is None
            # A retry must make the same choice from frozen sources, even after a
            # later file-authored draft reopens this candidate.
            late = {**scan.coverage, "deferred": pending["coverage"]["deferred"]}
            (scan.scan_dir / "coverage.json").write_text(json.dumps(late))
        saved.preserve_scan_results(
            context,
            workbench_db,
            Namespace(
                scan_id=scan.scan_id, claim_token=None, thread_id=None, coordinator_generation=None
            ),
        )
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    assert coverage["completeness"] == (
        "partial" if flow in {"stop", "interrupted-stop"} or pending_time > 200 else "complete"
    )
    for document in [coverage, *prepared_coverage]:
        assert any(
            row.get("candidateId") == "candidate-review" for row in document["deferred"]
        ) is (pending_time > 200)
        assert any(
            row.get("candidateId") == "candidate-review"
            and row["disposition"] == disposition.removeprefix("provenance-")
            for row in document["surfaces"]
        )
    if flow in {"stop", "interrupted-stop"}:
        before = (scan.scan_dir / "scan-manifest.json").read_bytes()
        recovered = saved.recover_scan_results(
            context, workbench_db, Namespace(scan_id=scan.scan_id)
        )["scan"]
        assert not recovered["resultsRecoveryNeeded"]
        assert (scan.scan_dir / "scan-manifest.json").read_bytes() == before
        assert json.loads((scan.scan_dir / "coverage.json").read_text()) == coverage
    assert checkpoint.read_bytes() == original


@pytest.mark.parametrize("disposition", ["reported", "rejected", "provenance-reported"])
def test_accepted_pending_root_tie_survives_canonical_disposition(
    workbench_api, workbench_db, publication_scan, disposition
):
    scan = publication_scan(mode="standard")
    pending = saved_draft(
        scan.scan_id,
        deferred=[{"candidateId": "candidate-review", "reason": "Accepted pending review."}],
    )
    checkpoint = write_checkpoint(scan.scan_dir / "checkpoints", pending)
    os.utime(checkpoint, ns=(100, 100))
    head = scan.scan_dir / "checkpoint-head.json"
    head.write_text(json.dumps({"checkpoint": checkpoint.name}))
    os.utime(head, ns=(200, 200))
    saved = workbench_api["saved_results"]
    saved._capture_saved_source(scan.scan_dir, "checkpoint-head.json", scan.scan_id)
    canonical_disposition(scan, disposition, True)
    context = workbench_api["_WORKBENCH_DB_CONTEXT"]
    saved.fail_scan(
        context,
        workbench_db,
        Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None, message="Stopped."),
    )
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    assert coverage["completeness"] == "partial"
    assert any(row.get("candidateId") == "candidate-review" for row in coverage["deferred"])
    saved.recover_scan_results(context, workbench_db, Namespace(scan_id=scan.scan_id))
    assert json.loads((scan.scan_dir / "coverage.json").read_text()) == coverage


@pytest.mark.parametrize("disposition", ["reported", "rejected", "provenance-reported"])
@pytest.mark.parametrize("pending_time", [99, 100, 101], ids=["older", "tied", "newer"])
@pytest.mark.parametrize("interrupted", [False, True])
def test_restored_root_observation_keeps_tied_pending_payload(
    workbench_api,
    workbench_db,
    publication_scan,
    monkeypatch,
    disposition,
    pending_time,
    interrupted,
):
    scan = publication_scan(mode="standard")
    canonical_disposition(scan, disposition, True)
    saved = workbench_api["saved_results"]
    _, terminal = saved._read_saved_parent_result(scan.scan_dir, scan.scan_id)
    for name in ("scan-manifest.json", "findings.json", "coverage.json"):
        os.utime(scan.scan_dir / name, ns=(0, 0))
    checkpoint = write_checkpoint(scan.scan_dir / "checkpoints", terminal)
    os.utime(checkpoint, ns=(50, 50))
    head = scan.scan_dir / "checkpoint-head.json"
    for observed in (100, 300, 100):
        head.write_text(json.dumps({"checkpoint": checkpoint.name}))
        os.utime(head, ns=(observed, observed))
        saved._capture_saved_source(scan.scan_dir, "checkpoint-head.json", scan.scan_id)
    pending = saved_draft(
        scan.scan_id,
        deferred=[{"candidateId": "candidate-review", "reason": "Review remains pending."}],
    )
    pending_path = write_checkpoint(scan.scan_dir / "checkpoints", pending)
    os.utime(pending_path, ns=(pending_time, pending_time))
    prepared_coverage = []
    write = saved._write_prepared_scan_finalization

    def publish(prepared, **kwargs):
        prepared_coverage.append(copy.deepcopy(prepared[4]))
        if interrupted:
            raise OSError("Synthetic restored-observation publication interruption")
        return write(prepared, **kwargs)

    context = workbench_api["_WORKBENCH_DB_CONTEXT"]
    with monkeypatch.context() as patch:
        patch.setattr(saved, "_write_prepared_scan_finalization", publish)
        saved.fail_scan(
            context,
            workbench_db,
            Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None, message="Stopped."),
        )
    saved.preserve_scan_results(
        context,
        workbench_db,
        Namespace(
            scan_id=scan.scan_id, claim_token=None, thread_id=None, coordinator_generation=None
        ),
    )
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    assert len(prepared_coverage) == 1
    for document in [coverage, *prepared_coverage]:
        assert any(
            row.get("candidateId") == "candidate-review" for row in document["deferred"]
        ) is (pending_time >= 100)
    saved.recover_scan_results(context, workbench_db, Namespace(scan_id=scan.scan_id))
    assert json.loads((scan.scan_dir / "coverage.json").read_text()) == coverage
