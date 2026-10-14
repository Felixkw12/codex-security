from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def run_finalizer(scan_dir: Path, source_root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(PLUGIN_DIR / "scripts" / "finalize_scan_contract.py"),
            "--scan-dir",
            str(scan_dir),
            "--source-root",
            str(source_root),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("mode", ["repository", "scoped_path", "diff"])
@pytest.mark.parametrize("has_findings", [True, False])
def test_file_authored_assembly_seals_without_completion_binding(
    tmp_path: Path, mode: str, has_findings: bool
) -> None:
    def example(name: str) -> dict:
        return json.loads((PLUGIN_DIR / "examples" / "completed-scan" / name).read_text())

    scan = example("scan-manifest.json")["scan"]
    scan.pop("sealedAt")
    scan.pop("artifacts")
    scan["id"] = "scan_fresh_terminal"
    findings = example("findings.json")["findings"] if has_findings else []
    coverage = example("coverage.json")
    for key in ("documentType", "schemaVersion", "scanId"):
        coverage.pop(key)
    coverage["mode"] = mode
    coverage["inventoryStrategy"] = mode
    if mode == "diff":
        scan["target"]["kind"] = "git_diff"
    if mode == "scoped_path":
        scan["scope"]["includePaths"] = ["src/extract.py"]
        coverage["includePaths"] = ["src/extract.py"]
    if not has_findings:
        coverage["surfaces"][0]["disposition"] = "no_issue_found"
    before = copy.deepcopy((scan, findings, coverage))

    source_root = tmp_path / "source"
    (source_root / "src").mkdir(parents=True)
    (source_root / "src" / "extract.py").write_text("# synthetic source\n" * 44)

    # Exercise the producer recipe shipped to file-authoring scan skills.
    reference = (PLUGIN_DIR / "references" / "final-report.md").read_text(encoding="utf-8")
    recipe = re.search(r"```python\n(.*?)\n```", reference, re.DOTALL)
    assert recipe is not None
    fresh_dir = tmp_path / "fresh"
    fresh_dir.mkdir()
    namespace = {
        "plugin_dir": str(PLUGIN_DIR),
        "scan_dir": str(fresh_dir),
        "scan": scan,
        "findings": findings,
        "coverage": coverage,
    }
    exec(recipe[1], namespace)
    documents = namespace["documents"]
    assert (scan, findings, coverage) == before
    assert documents["scan-manifest.json"]["scan"]["id"] == scan["id"]
    assert documents["findings.json"]["scanId"] == scan["id"]
    assert documents["coverage.json"]["scanId"] == scan["id"]
    assert documents["findings.json"]["findings"] == findings
    assert all(documents["coverage.json"][key] == value for key, value in coverage.items())
    for name, document in documents.items():
        assert json.loads((fresh_dir / name).read_text(encoding="utf-8")) == document

    result = run_finalizer(fresh_dir, source_root)

    assert result.returncode == 0, result.stderr
    manifest = json.loads((fresh_dir / "scan-manifest.json").read_text(encoding="utf-8"))
    assert manifest["scan"]["sealedAt"]
    assert manifest["scan"]["id"] == scan["id"]
    assert (fresh_dir / "report.md").is_file()
    completed_findings = json.loads((fresh_dir / "findings.json").read_text(encoding="utf-8"))
    assert completed_findings["scanId"] == scan["id"]
    assert len(completed_findings["findings"]) == len(findings)
    completed_coverage = json.loads((fresh_dir / "coverage.json").read_text(encoding="utf-8"))
    assert completed_coverage["scanId"] == scan["id"]
    assert completed_coverage["mode"] == mode
