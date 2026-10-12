"""Resolve accepted worker receipt references without changing their ownership."""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from finalize_scan_contract import ContractError, open_scan_local_file_descriptor, path_within_scope


def _checkpoint_head_directory(relative: str) -> Path | None:
    path = Path(relative)
    if path.name == "checkpoint-head.json":
        return path.parent
    if path.parent.name == "checkpoint-heads":
        return path.parent.parent
    return None


def _is_source_order_snapshot(relative: str) -> bool:
    path = Path(relative)
    return path.parent == Path("source-order") and bool(
        re.fullmatch(r"[0-9a-f]{64}\.json", path.name)
    )


def capture_receipt_checkpoints(
    relative: str,
    kind: str | None,
    captured: dict[str, tuple[str, int]],
    checkpoint_paths: Callable[[str], list[str]],
    read_checkpoint: Callable[[str], tuple[dict[str, Any], str, int]],
) -> dict[str, tuple[str, int]]:
    """Bind a captured worker result to checkpoints visible after reading it."""
    if kind == "discovery" and Path(relative).name == "result.json":
        directory = (Path(relative).parent / "checkpoints").as_posix()
        for path in checkpoint_paths(directory):
            try:
                _, digest, observed = read_checkpoint(path)
            except (ContractError, OSError, ValueError):
                continue
            captured[path] = (digest, observed)
    return captured


def receipt_checkpoints(
    relative: str,
    worker_id: str | None,
    known: dict[str, str | None],
    checkpoint_paths: Callable[[str], list[str]],
) -> dict[str, str]:
    """Capture host checkpoints written after enumeration but before result.json."""
    if worker_id is None or Path(relative).name != "result.json":
        return {}
    directory = (Path(relative).parent / "checkpoints").as_posix()
    added = {path: worker_id for path in checkpoint_paths(directory) if path not in known}
    known.update(added)
    return added


def retain_recorded_receipt_ownership(
    sources: list[tuple[str, dict[str, Any], str | None]],
    digest: Callable[[Any], str],
    include_paths: Sequence[str],
) -> None:
    # Checkpoints are written by the host tool; direct result files can be authored
    # without it. Compare the entire payload within the same worker attempt.
    def payload_digest(draft: dict[str, Any]) -> str:
        return digest({key: value for key, value in draft.items() if key != "handoffClaimToken"})

    recorded: dict[Path, set[str]] = {}
    for relative, draft, worker_id in sources:
        directory = Path(relative).parent
        if worker_id is not None and directory.name == "checkpoints":
            payloads = recorded.setdefault(directory.parent, set())
            payloads.add(payload_digest(draft))
            if "." not in include_paths:
                # Legacy writers saved the checkpoint before filtering inherited findings.
                scoped = [
                    finding
                    for finding in draft["findings"]
                    if isinstance(finding, dict)
                    and isinstance(finding.get("locations"), list)
                    and any(
                        isinstance(location, dict)
                        and isinstance(location.get("path"), str)
                        and any(path_within_scope(location["path"], path) for path in include_paths)
                        for location in finding["locations"]
                    )
                ]
                payloads.add(payload_digest({**draft, "findings": scoped}))
    for relative, draft, worker_id in sources:
        directory = Path(relative).parent
        if worker_id is None or directory.name == "checkpoints":
            continue
        if payload_digest(draft) in recorded.get(directory, set()):
            continue
        surfaces = draft["coverage"].get("surfaces", [])
        for surface in surfaces if isinstance(surfaces, list) else []:
            if isinstance(surface, dict) and isinstance(surface.get("provenance"), dict):
                surface["provenance"].pop("scanReceiptRefs", None)


def resolve_coverage_receipts(
    scan_dir: Path, item: dict[str, Any], worker: Any, relative: str
) -> Any:
    refs = item.get("receiptRefs", [])
    if not isinstance(refs, list):
        return refs
    directory = Path(relative).parent
    if directory.name == "checkpoints":
        directory = directory.parent
    output = Path(worker["artifact_dir"]).relative_to(scan_dir)
    worker_prefix = (output.parent if output.name == "output" else output).as_posix() + "/"
    active_prefix = output.as_posix() + "/"
    if directory != output:
        refs = [
            f"{directory.as_posix()}/{Path(ref).as_posix()[len(active_prefix) :]}"
            if isinstance(ref, str) and Path(ref).as_posix().startswith(active_prefix)
            else ref
            for ref in refs
        ]

    def scan_receipt(ref: str) -> bool:
        try:
            descriptor = open_scan_local_file_descriptor(scan_dir, ref, "coverage receipt")
        except (ContractError, OSError):
            return False
        os.close(descriptor)
        return True

    def qualified_receipt(ref: Any) -> Any:
        if not isinstance(ref, str):
            return ref
        ref = Path(ref).as_posix()
        provenance = item.get("provenance")
        inherited_scan_refs = (
            provenance.get("scanReceiptRefs", []) if isinstance(provenance, dict) else []
        )
        if ref.startswith(worker_prefix) or (
            isinstance(inherited_scan_refs, list) and ref in inherited_scan_refs
        ):
            return ref
        local_ref = Path(f"{directory}/{ref}").as_posix()
        return local_ref if scan_receipt(local_ref) or not scan_receipt(ref) else ref

    return [qualified_receipt(ref) for ref in refs]
