from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from test_deep_scan_successful_publication import add_worker
from test_deep_scan_successful_publication import publication_scan as publication_scan
from test_partial_coverage_projection import stop_and_recover_projection
from test_saved_deferred_identity import recover, save_worker
from workbench_test_support import saved_draft, write_checkpoint


@pytest.mark.parametrize("recorded", [False, True])
@pytest.mark.parametrize("retry", [False, True])
@pytest.mark.parametrize("archived", [False, True])
def test_stopped_receipt_ownership_requires_a_matching_checkpoint(
    workbench_api, workbench_db, publication_scan, monkeypatch, recorded, retry, archived
):
    scan = publication_scan()
    initial = add_worker(workbench_db, scan)
    worker_id = initial.parent.name
    output = scan.scan_dir / "artifacts" / "deep_discovery" / "workers" / worker_id / "output"
    output.mkdir(parents=True)
    result = output / "result.json"
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_workers SET artifact_dir = ?, result_manifest_path = ? WHERE id = ?",
            (str(output), str(result), worker_id),
        )
    ref = "artifacts/evidence.txt"
    shared = scan.scan_dir / ref
    shared.parent.mkdir(parents=True, exist_ok=True)
    shared.write_text("Shared evidence\n")
    draft = {
        "scanId": scan.scan_id,
        "complete": True,
        "findings": [],
        "coverage": {
            "completeness": "complete",
            "explicitExclusions": [],
            "surfaces": [
                {
                    "id": "review",
                    "label": "Reviewed route",
                    "disposition": "no_issue_found",
                    "receiptRefs": [ref],
                    "provenance": {"scanReceiptRefs": [ref]},
                }
            ],
            "deferred": [],
        },
    }
    result.write_text(json.dumps(draft))
    if recorded:
        write_checkpoint(result.parent / "checkpoints", draft)
    local = result.parent / ref
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_text("Local evidence\n")
    if archived:
        archive = output.parent / "attempts" / "attempt-01"
        archive.parent.mkdir()
        output.rename(archive)
        output.mkdir()
        result = archive / "result.json"
        local = archive / ref
        with workbench_db:
            workbench_db.execute(
                "UPDATE deep_scan_workers SET status = 'running', attempt = 2, result_manifest_path = NULL WHERE id = ?",
                (worker_id,),
            )
    original = result.read_bytes()
    for name in ("scan-manifest.json", "findings.json", "coverage.json"):
        (scan.scan_dir / name).unlink()
    coverage = stop_and_recover_projection(workbench_api, workbench_db, scan, monkeypatch, retry)
    assert len(coverage["surfaces"]) == 1
    refs = coverage["surfaces"][0]["receiptRefs"]
    selected = shared if recorded else local
    assert refs == [selected.relative_to(scan.scan_dir).as_posix()]
    assert (scan.scan_dir / refs[0]).read_text() == selected.read_text()
    assert result.read_bytes() == original


CANDIDATE_IDS = [
    "candidate-\ud800",
    "candidate-\udfff",
    "candidate-\ud83d\ude00",
    "candidate-\U0001f600",
    "candidate-é",
    "candidate-\\ud800",
    "candidate-A\ud800B\udfffZ",
]


# Produced by the accepted JS draft parser and projectDiscoveryCoverage.
JAVASCRIPT_CANDIDATE_HASHES = [
    "48869f14875acce6da9a25e25db38d5a211fca5b07a2ac85d95dbeb7fbfad817",
    "48869f14875acce6da9a25e25db38d5a211fca5b07a2ac85d95dbeb7fbfad817",
    "a562be8af2b220690ce013d3fdce2d1db00a5cd0fffb191389023b836c65d43c",
    "a562be8af2b220690ce013d3fdce2d1db00a5cd0fffb191389023b836c65d43c",
    "e58295b9114eb779fb2c91d375fe1c103056bfe760954a8fbf7954a84c2cbb6a",
    "f6d3552df9eaff1e1ce7185aa6efb48eff97d5a74a39a44c5a4b7ff55fbe43c4",
    "d80ce56ca1e18843faee20969b09a04c1f32969a104b9ccf050f0a345eeb3912",
]


@pytest.mark.parametrize("index", range(len(CANDIDATE_IDS)))
def test_saved_candidate_projection_matches_javascript_utf8(tmp_path: Path, index: int):
    import workbench_saved_results as saved

    candidate = CANDIDATE_IDS[index]
    digest = JAVASCRIPT_CANDIDATE_HASHES[index]
    assert hashlib.sha256(saved.javascript_utf8(candidate)).hexdigest() == digest
    draft = saved_draft(
        "identity-scan",
        complete=True,
        surfaces=[
            {
                "id": "review",
                "label": "Reviewed route",
                "candidateId": candidate,
                "disposition": "no_issue_found",
                "receiptRefs": [],
            }
        ],
    )
    worker = save_worker(tmp_path, saved, "reviewer", [], draft)
    worker["status"] = "succeeded"
    worker["result_manifest_path"] = str(tmp_path / "reviewer" / "result.json")
    result_path = Path(worker["result_manifest_path"])
    original = result_path.read_bytes()
    result = recover(tmp_path, saved, [worker])
    surface = result[2]["surfaces"][0]
    assert surface["candidateId"] == f"reviewer-attempt-1-candidate-{digest}"
    assert surface["provenance"]["candidateId"] == json.loads(json.dumps(candidate))
    assert recover(tmp_path, saved, [worker], result[0]["scan"]["preservedSources"])[2] == result[2]
    assert result_path.read_bytes() == original
