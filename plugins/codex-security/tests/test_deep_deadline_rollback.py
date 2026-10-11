from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_deep_coverage_recovery import worker
from workbench_test_support import saved_binding, saved_draft, write_checkpoint

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import finalize_scan_contract as finalizer
import workbench_saved_results as saved


@pytest.mark.parametrize("local_failure", [False, True], ids=["caller-rollback", "local-failure"])
def test_deadline_rollback_does_not_reintroduce_a_later_rejected_worker_finding(
    tmp_path, local_failure
):
    scan_id = "00000000-0000-4000-8000-000000000001"
    finding = {
        "ruleId": "synthetic.input",
        "identity": {"anchor": "fixture"},
        "title": "Synthetic candidate",
        "summary": "A synthetic source-backed result.",
        "severity": {"level": "low"},
        "confidence": {"level": "high", "rationale": "Synthetic fixture evidence."},
        "taxonomy": {"category": "other", "cwe": []},
        "locations": [{"path": "fixture.py", "startLine": 1}],
        "remediation": "Apply the synthetic correction.",
        "provenance": {"source": "local_plugin", "candidateId": "candidate-one"},
    }
    draft = saved_draft(scan_id, findings=[finding])
    source = worker(tmp_path, "reviewer", draft)
    output = Path(source["artifact_dir"])
    worker_checkpoint = write_checkpoint(output / "checkpoints", draft)
    worker_bytes = worker_checkpoint.read_bytes()
    previous = write_checkpoint(tmp_path / "checkpoints", saved_draft(scan_id))
    previous_bytes = previous.read_bytes()
    head = tmp_path / "checkpoint-head.json"
    head.write_text(json.dumps({"checkpoint": previous.name}))
    original_head = head.read_bytes()
    binding = {
        **saved_binding("deep_repository", repository="synthetic", status="completed"),
        "scanId": scan_id,
        "startedAt": "2026-01-01T00:00:00Z",
        "completedAt": "2026-01-01T00:01:00Z",
        "producer": {"name": "codex-security", "version": "0.0.0"},
    }
    binding["target"].update(
        revision="a" * 40, targetId="synthetic", displayName="Synthetic fixture"
    )
    db = SimpleNamespace(
        require_canonical_scan_directory=finalizer._require_scan_directory,
        now=lambda: binding["completedAt"],
        workbench_completion_binding=lambda *_args: copy.deepcopy(binding),
        expected_coverage_mode=lambda _scan: "deep_repository",
    )
    scan = {"id": scan_id, "scan_dir": str(tmp_path), "completion_warnings_json": "[]"}

    class Connection:
        def execute(self, sql, _args):
            if sql.startswith("UPDATE") and local_failure:
                raise RuntimeError("Synthetic publication failure")
            return SimpleNamespace(fetchall=lambda: [source])

    if local_failure:
        with pytest.raises(RuntimeError, match="Synthetic publication failure"):
            saved.preserve_deep_deadline_draft(db, Connection(), scan)
    else:
        publication = saved.preserve_deep_deadline_draft(db, Connection(), scan)
        # The caller uses this same restoration path when its transaction fails.
        saved._restore_published_outputs(*publication)

    rejected = saved_draft(
        scan_id,
        complete=True,
        surfaces=[
            {
                "id": "candidate-one",
                "candidateId": "candidate-one",
                "label": "Reviewed candidate",
                "disposition": "rejected",
                "receiptRefs": [],
            }
        ],
    )
    (output / "result.json").write_text(json.dumps(rejected))
    warnings = []
    recovered = saved.merge_saved_results(
        tmp_path,
        scan_id,
        binding,
        [source],
        warnings,
        stopped=True,
        reason="Synthetic stop after rejection.",
        project_worker_coverage=True,
    )
    assert recovered is not None
    assert recovered[1]["findings"] == []
    assert worker_checkpoint.read_bytes() == worker_bytes
    assert previous.read_bytes() == previous_bytes
    assert head.read_bytes() == original_head
    assert list((tmp_path / "checkpoints").iterdir()) == [previous]
