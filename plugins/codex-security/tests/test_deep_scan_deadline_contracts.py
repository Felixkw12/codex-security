from __future__ import annotations

import copy
import json
import os

import pytest
from test_deep_scan_deadline_recovery import worker_finding
from test_deep_scan_stop_conditions import canceled_discovery_output, complete, finish
from test_deep_scan_stop_conditions import deadline_scan as deadline_scan
from test_deep_scan_stop_conditions import publication_scan as publication_scan
from test_deep_scan_stop_conditions import saturated_scan as saturated_scan
from workbench_test_support import saved_draft, write_checkpoint


@pytest.mark.parametrize(
    "model",
    [
        {"assets": []},
        {"summary": "Invalid " + chr(0xD800)},
        {"summary": "Reviewed boundaries."},
        {"format": "markdown", "content": "# Reviewed boundaries"},
    ],
)
def test_deadline_recovers_optional_worker_model_without_losing_findings(
    workbench_api, workbench_db, deadline_scan, model
):
    scan = deadline_scan
    _, output = canceled_discovery_output(workbench_db, scan)
    finding = worker_finding(scan, "worker-model-finding")
    draft = {**saved_draft(scan.scan_id, findings=[finding]), "threatModel": model}
    checkpoint = write_checkpoint(output / "checkpoints", draft)
    original = checkpoint.read_bytes()

    finish(workbench_api, workbench_db, scan, terminal_reason="capped")
    completed = complete(workbench_api, workbench_db, scan)

    assert len(json.loads((scan.scan_dir / "findings.json").read_text())["findings"]) == 2
    manifest = json.loads((scan.scan_dir / "scan-manifest.json").read_text())["scan"]
    invalid = "assets" in model or chr(0xD800) in model.get("summary", "")
    if invalid:
        assert "threatModel" not in manifest
        assert any(
            "threat model" in warning and checkpoint.name in warning
            for warning in completed["warnings"]
        )
    else:
        assert manifest["threatModel"] == {**model, "origin": "recovered"}
    assert checkpoint.read_bytes() == original


def test_deadline_still_rejects_malformed_canonical_model(
    workbench_api, workbench_db, deadline_scan
):
    from finalize_scan_contract import ContractError

    scan = deadline_scan
    manifest_file = scan.scan_dir / "scan-manifest.json"
    manifest = json.loads(manifest_file.read_text())
    manifest["scan"]["threatModel"] = {"assets": []}
    manifest_file.write_text(json.dumps(manifest))
    _, output = canceled_discovery_output(workbench_db, scan)
    write_checkpoint(output / "checkpoints", saved_draft(scan.scan_id))
    with pytest.raises(ContractError, match="threatModel"):
        finish(workbench_api, workbench_db, scan, terminal_reason="capped")


@pytest.mark.parametrize("label", [" \t ", "  Reviewed Résumé 😀  "])
def test_deadline_applies_existing_nonblank_surface_label_contract(
    workbench_api, workbench_db, deadline_scan, label
):
    scan = deadline_scan
    worker_id, output = canceled_discovery_output(workbench_db, scan)
    checkpoint = write_checkpoint(
        output / "checkpoints",
        saved_draft(
            scan.scan_id,
            findings=[worker_finding(scan, "worker-label-finding")],
            surfaces=[
                {"id": "entry", "label": label, "disposition": "reported", "receiptRefs": []}
            ],
        ),
    )
    original = checkpoint.read_bytes()

    finish(workbench_api, workbench_db, scan, terminal_reason="capped")
    completed = complete(workbench_api, workbench_db, scan)

    assert len(json.loads((scan.scan_dir / "findings.json").read_text())["findings"]) == 2
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    surfaces = [row for row in coverage["surfaces"] if row.get("workerId") == worker_id]
    assert len(surfaces) == bool(label.strip())
    if surfaces:
        assert surfaces[0]["label"] == label
    else:
        assert any(
            "label: expected a non-empty string" in warning and checkpoint.name in warning
            for warning in completed["warnings"]
        )
    assert checkpoint.read_bytes() == original


@pytest.mark.parametrize(
    "field",
    ["finding", "surfaces", "explicitExclusions", "deferred", "openQuestions", "resolvedDeferred"],
)
@pytest.mark.parametrize("malformed", [False, True], ids=["valid-unicode", "lone-surrogate"])
def test_deadline_applies_existing_unicode_contract_per_worker_record(
    workbench_api, workbench_db, deadline_scan, field, malformed
):
    scan = deadline_scan
    _, output = canceled_discovery_output(workbench_db, scan)
    text = "Review " + (chr(0xD800) if malformed else "Résumé 😀")
    finding = worker_finding(scan, "unicode-worker-finding")
    draft = saved_draft(scan.scan_id, findings=[finding])
    if field == "finding":
        finding["summary"] = text
    elif field == "surfaces":
        draft["coverage"][field] = [
            {"id": "entry", "label": text, "disposition": "reported", "receiptRefs": []}
        ]
    elif field == "openQuestions":
        draft["coverage"][field] = [text]
    elif field == "explicitExclusions":
        draft["coverage"][field] = [{"pattern": "vendor/", "reason": text}]
    else:
        draft["coverage"][field] = [{"id": "review", "reason": text}]
    if field == "resolvedDeferred":
        draft["complete"] = True
        previous = write_checkpoint(
            output / "checkpoints",
            saved_draft(scan.scan_id, deferred=[{"id": "review", "reason": "Review pending."}]),
        )
        os.utime(previous, ns=(100, 100))
    checkpoint = write_checkpoint(output / "checkpoints", draft)
    os.utime(checkpoint, ns=(200, 200))
    if field == "resolvedDeferred":
        (output / "checkpoint-head.json").write_text(json.dumps({"checkpoint": checkpoint.name}))
    original = checkpoint.read_bytes()

    finish(workbench_api, workbench_db, scan, terminal_reason="capped")
    completed = complete(workbench_api, workbench_db, scan)

    findings = json.loads((scan.scan_dir / "findings.json").read_text())["findings"]
    assert len(findings) == (1 if malformed and field == "finding" else 2)
    assert any("well-formed Unicode" in warning for warning in completed["warnings"]) == malformed
    if field == "resolvedDeferred":
        coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
        assert any(row["reason"] == "Review pending." for row in coverage["deferred"]) == malformed
    elif not malformed:
        document = (
            findings
            if field == "finding"
            else json.loads((scan.scan_dir / "coverage.json").read_text())
        )
        assert text in json.dumps(document, ensure_ascii=False)
    assert checkpoint.read_bytes() == original


@pytest.mark.parametrize(
    ("terminal_findings", "malformed", "selected_head"),
    [
        (False, None, False),
        (True, None, False),
        (False, "surface", False),
        (True, "surface", False),
        (False, "closure", False),
        (True, "closure", False),
        (True, "surface", True),
        (False, "missing-receipt", False),
        (True, "missing-receipt", False),
        (False, "disposition", False),
        (True, "disposition", False),
        (False, "receipt-array", False),
        (True, "receipt-array", False),
    ],
    ids=[
        "valid-coverage-empty-findings",
        "valid-coverage-retained-finding",
        "malformed-surface-empty-findings",
        "malformed-surface-retained-finding",
        "malformed-closure-empty-findings",
        "malformed-closure-retained-finding",
        "malformed-selected-head",
        "missing-receipt-empty-findings",
        "missing-receipt-retained-finding",
        "disposition-empty-findings",
        "disposition-retained-finding",
        "receipt-array-empty-findings",
        "receipt-array-retained-finding",
    ],
)
def test_malformed_terminal_coverage_preserves_only_earlier_coverage(
    workbench_api, workbench_db, deadline_scan, terminal_findings, malformed, selected_head
):
    scan = deadline_scan
    worker_id, output = canceled_discovery_output(workbench_db, scan)
    finding = worker_finding(scan, "earlier-worker-finding")
    rejected = worker_finding(scan, "rejected-sibling")
    rejected["provenance"]["candidateId"] = "rejected-sibling"
    surface = {
        "id": "entry",
        "label": "Unfinished review",
        "disposition": "needs_follow_up",
        "receiptRefs": [],
    }
    checkpoint = write_checkpoint(
        output / "checkpoints",
        saved_draft(
            scan.scan_id,
            findings=[finding, rejected],
            surfaces=[surface],
            deferred=[
                {"id": "review", "reason": "Review remains.", "surfaceIds": ["entry"]},
                {"id": "finished", "reason": "Separate review remains."},
            ],
        ),
    )
    os.utime(checkpoint, ns=(100, 100))
    invalid_surface = copy.deepcopy(surface)
    if malformed == "surface":
        invalid_surface.pop("label")
    else:
        invalid_surface.update(id="latest", label="Latest review", disposition="no_issue_found")
        if malformed == "missing-receipt":
            invalid_surface["receiptRefs"] = ["artifacts/missing.txt"]
        elif malformed == "disposition":
            invalid_surface["disposition"] = "unknown"
        elif malformed == "receipt-array":
            invalid_surface["receiptRefs"] = "invalid"
    closures = [{"id": "finished", "reason": "Separate review completed."}]
    if malformed == "closure":
        closures.append({"id": "review", "reason": "Invalid " + chr(0xD800)})
    terminal = saved_draft(
        scan.scan_id,
        complete=True,
        findings=[finding] if terminal_findings else [],
        surfaces=[
            {
                "id": "sibling-outcome",
                "candidateId": "rejected-sibling",
                "label": "Sibling reviewed",
                "disposition": "rejected",
                "receiptRefs": [],
            },
            *([invalid_surface] if malformed not in (None, "closure") else []),
        ],
        closures=closures,
    )
    if selected_head:
        result = write_checkpoint(output / "checkpoints", terminal)
        (output / "checkpoint-head.json").write_text(json.dumps({"checkpoint": result.name}))
    else:
        result = output / "result.json"
        result.write_text(json.dumps(terminal))
    os.utime(result, ns=(200, 200))
    original = {path: path.read_bytes() for path in (checkpoint, result)}

    finish(workbench_api, workbench_db, scan, terminal_reason="capped")
    complete(workbench_api, workbench_db, scan)

    findings = json.loads((scan.scan_dir / "findings.json").read_text())["findings"]
    assert any(row["title"] == finding["title"] for row in findings) == terminal_findings
    assert all(row["title"] != rejected["title"] for row in findings)
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    assert any(
        row.get("workerId") == worker_id and row["label"] == surface["label"]
        for row in coverage["surfaces"]
    ) == bool(malformed)
    assert any(row["reason"] == "Review remains." for row in coverage["deferred"]) == bool(
        malformed
    )
    assert not any(row["reason"] == "Separate review remains." for row in coverage["deferred"])
    assert (
        next(row for row in coverage["surfaces"] if row["label"] == "Sibling reviewed")[
            "disposition"
        ]
        == "rejected"
    )
    if malformed in {"missing-receipt", "disposition", "receipt-array"}:
        latest = next(row for row in coverage["surfaces"] if row["label"] == "Latest review")
        assert latest["disposition"] == "needs_follow_up"
        assert latest["receiptRefs"] == []
    assert {path: path.read_bytes() for path in original} == original


@pytest.mark.parametrize("canceled_worker", [False, True])
def test_optional_export_failure_does_not_block_deadline(
    workbench_api, workbench_db, deadline_scan, tmp_path, capsys, canceled_worker
):
    scan = deadline_scan
    sentinel = tmp_path / "untouched.sarif"
    sentinel.write_text("Preserve this file.\n")
    export = scan.scan_dir / "exports" / "results.sarif"
    export.parent.mkdir()
    export.symlink_to(sentinel)
    if canceled_worker:
        _, output = canceled_discovery_output(workbench_db, scan)
        write_checkpoint(
            output / "checkpoints",
            saved_draft(scan.scan_id, findings=[worker_finding(scan, "saved-worker-finding")]),
        )

    finish(workbench_api, workbench_db, scan, terminal_reason="capped")
    completed = complete(workbench_api, workbench_db, scan)

    assert completed["progress"]["status"] == "complete"
    assert "automatic SARIF export failed" in capsys.readouterr().err
    assert export.is_symlink()
    assert sentinel.read_text() == "Preserve this file.\n"


def test_standard_parent_closure_preserves_unrelated_task_without_id(
    workbench_api, workbench_db, publication_scan
):
    scan = publication_scan(mode="standard")
    scan.coverage["resolvedDeferred"] = [{"id": "finished", "reason": "Review completed."}]
    scan.coverage["deferred"] = [{"reason": "Unrelated pending review."}]
    (scan.scan_dir / "coverage.json").write_text(json.dumps(scan.coverage))

    complete(workbench_api, workbench_db, scan)

    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    assert len(coverage["deferred"]) == 1
    assert coverage["deferred"][0]["id"]
    assert coverage["deferred"][0]["reason"] == "Unrelated pending review."
