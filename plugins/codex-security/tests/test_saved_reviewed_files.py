from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from test_workbench_standard_deep_results import write_saved_parent
from workbench_test_support import (
    replay_saved_results,
    saved_binding,
    saved_discovery_worker,
    saved_draft,
    write_checkpoint,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import workbench_saved_results as saved


@pytest.mark.parametrize("layout", ["parent", "worker"])
def test_recovery_retains_reviewed_files_across_checkpoints(tmp_path: Path, layout: str) -> None:
    scan_id = "reviewed-files"
    output = tmp_path if layout == "parent" else tmp_path / "worker" / "output"
    binding = saved_binding("repository" if layout == "parent" else "deep_repository")
    workers = [] if layout == "parent" else [saved_discovery_worker(output)]
    for paths in (["./src/a.ts"], ["src/b.ts", "src/a.ts"], []):
        draft = saved_draft(scan_id)
        draft["coverage"]["reviewedFiles"] = paths
        write_checkpoint(output / "checkpoints", draft)
    latest = saved_draft(scan_id)
    if layout == "parent":
        write_saved_parent(output, latest, 500)
    else:
        (output / "result.json").write_text(json.dumps(latest))
    first = saved.merge_saved_results(
        tmp_path, scan_id, binding, workers, [], stopped=True, reason="interrupted"
    )
    assert first[2]["reviewedFiles"] == ["src/a.ts", "src/b.ts"]
    replay = replay_saved_results(saved, first, tmp_path, scan_id, binding, workers, stopped=True)
    assert replay[2]["reviewedFiles"] == first[2]["reviewedFiles"]


@pytest.mark.parametrize("files", [None, []])
def test_recovery_preserves_unknown_and_empty_accounting(tmp_path: Path, files) -> None:
    scan_id = "reviewed-files"
    draft = saved_draft(scan_id)
    if files is not None:
        draft["coverage"]["reviewedFiles"] = files
    write_checkpoint(tmp_path / "checkpoints", draft)
    result = saved.merge_saved_results(
        tmp_path, scan_id, saved_binding(), [], [], stopped=True, reason="interrupted"
    )
    assert ("reviewedFiles" in result[2]) is (files is not None)
    if files is not None:
        assert result[2]["reviewedFiles"] == files


def test_recovery_does_not_present_partial_worker_accounting_as_complete(tmp_path: Path) -> None:
    scan_id = "reviewed-files"
    workers = []
    for name, files in (("known", ["src/a.ts"]), ("unknown", None)):
        output = tmp_path / name / "output"
        draft = saved_draft(scan_id)
        if files is not None:
            draft["coverage"]["reviewedFiles"] = files
        write_checkpoint(output / "checkpoints", draft)
        workers.append(saved_discovery_worker(output, name))
    result = saved.merge_saved_results(
        tmp_path,
        scan_id,
        saved_binding("deep_repository"),
        workers,
        [],
        stopped=True,
        reason="stopped",
    )
    assert "reviewedFiles" not in result[2]


@pytest.mark.parametrize("mode", ["deep_repository", "scoped_path"])
def test_successful_deep_parent_does_not_gain_unaccepted_worker_claims(
    tmp_path: Path, mode: str
) -> None:
    scan_id = "reviewed-files"
    parent = saved_draft(scan_id, complete=True)
    parent["coverage"]["reviewedFiles"] = ["src/accepted.ts"]
    write_saved_parent(tmp_path, parent, 500)
    output = tmp_path / "worker" / "output"
    worker = saved_draft(scan_id)
    worker["coverage"]["reviewedFiles"] = ["src/unfinished.ts"]
    write_checkpoint(output / "checkpoints", worker)
    result = saved.merge_saved_results(
        tmp_path,
        scan_id,
        saved_binding(mode),
        [saved_discovery_worker(output)],
        [],
        stopped=False,
        reason="",
    )
    assert result[2]["reviewedFiles"] == ["src/accepted.ts"]
