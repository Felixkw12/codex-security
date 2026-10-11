"""Read and freeze saved scan checkpoint observations."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from finalize_scan_contract import (
    ContractError,
    _read_scan_local_json_with_metadata,
    write_scan_local_bytes,
)


def _encoded(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode()


def _digest(value: Any) -> str:
    return hashlib.sha256(_encoded(value)).hexdigest()


def _children(scan_dir: Path, relative: str) -> list[str]:
    cursor = scan_dir
    for part in Path(relative).parts:
        if part in {"..", "."}:
            return []
        cursor = cursor / part
        try:
            if not stat.S_ISDIR(cursor.lstat().st_mode):
                return []
        except FileNotFoundError:
            return []
    return sorted(child.name for child in cursor.iterdir())


def _checkpoint_paths(scan_dir: Path, directory: str) -> list[str]:
    return [
        f"{directory}/{name}"
        for name in _children(scan_dir, directory)
        if re.fullmatch(r"[0-9a-f]{64}\.json", name)
    ]


def _checkpoint_head_directory(relative: str) -> Path | None:
    path = Path(relative)
    if path.name == "checkpoint-head.json":
        return path.parent
    if path.parent.name == "checkpoint-heads":
        return path.parent.parent
    return None


def _capture_saved_source(
    scan_dir: Path,
    relative: str,
    scan_id: str,
    *,
    kind: str | None = None,
    snapshot_head: bool = True,
    write: bool = True,
) -> dict[str, tuple[str, int]]:
    if not snapshot_head or Path(relative).name != "checkpoint-head.json":
        _, digest, observed = _read_saved_result(scan_dir, relative, scan_id, kind=kind)
        return {relative: (digest, observed)}
    head, _, observed = _read_saved_result(scan_dir, relative, scan_id)
    observation = {
        **{key: head[key] for key in ("checkpoint", "inputCheckpoint") if key in head},
        "observedAtNs": str(observed),
    }
    directory = Path(relative).parent
    selected_sources = {}
    for key in ("checkpoint", "inputCheckpoint"):
        if key in head:
            selected = (directory / "checkpoints" / head[key]).as_posix()
            _, selected_digest, selected_time = _read_saved_result(scan_dir, selected, scan_id)
            selected_sources[selected] = (selected_digest, selected_time)
    digest = _digest(observation)
    snapshot = (directory / "checkpoint-heads" / f"{digest}.json").as_posix()
    # Capture the selected file even if the worker created it after directory enumeration.
    if write and not (scan_dir / snapshot).exists():
        write_scan_local_bytes(scan_dir, snapshot, _encoded(observation))
    return {
        snapshot: (digest, int(observation["observedAtNs"])),
        **selected_sources,
    }


def _read_saved_result(
    scan_dir: Path, relative: str, scan_id: str, *, kind: str | None = None
) -> tuple[dict[str, Any], str, int]:
    draft, _, metadata = _read_scan_local_json_with_metadata(
        scan_dir, relative, "Saved scan checkpoint"
    )
    directory = _checkpoint_head_directory(relative)
    if directory is not None:
        checkpoint = draft.get("checkpoint")
        if not isinstance(checkpoint, str) or not re.fullmatch(r"[0-9a-f]{64}\.json", checkpoint):
            raise ContractError("checkpoint head does not name a saved checkpoint")
        _read_saved_result(scan_dir, (directory / "checkpoints" / checkpoint).as_posix(), scan_id)
        if "inputCheckpoint" in draft:
            raw = draft["inputCheckpoint"]
            if not isinstance(raw, str) or not re.fullmatch(r"[0-9a-f]{64}\.json", raw):
                raise ContractError("checkpoint head does not name a saved input checkpoint")
            _read_saved_result(scan_dir, (directory / "checkpoints" / raw).as_posix(), scan_id)
        if Path(relative).name == "checkpoint-head.json":
            return draft, _digest([draft, metadata.st_mtime_ns]), metadata.st_mtime_ns
        observed = draft.get("observedAtNs")
        if not isinstance(observed, str) or not re.fullmatch(r"-?[0-9]+", observed):
            raise ContractError("checkpoint head has no observation time")
        return draft, _digest(draft), int(observed)
    if draft.get("scanId") != scan_id:
        raise ContractError("checkpoint belongs to a different scan")
    if not _is_source_order_snapshot(relative) and (
        not isinstance(draft.get("findings"), list)
        or not isinstance(draft.get("coverage", {} if kind == "dedup" else None), dict)
    ):
        raise ContractError("checkpoint has no semantic findings or coverage")
    return draft, _digest(draft), metadata.st_mtime_ns


def _is_source_order_snapshot(relative: str) -> bool:
    path = Path(relative)
    return path.parent == Path("source-order") and bool(
        re.fullmatch(r"[0-9a-f]{64}\.json", path.name)
    )


def _frozen_source_times(
    scan_dir: Path,
    scan_id: str,
    sources: dict[str, str],
    parent_context: dict[str, str] | None = None,
) -> dict[str, int]:
    times: dict[str, int] = {}
    snapshots = [path for path in sources if _is_source_order_snapshot(path)]
    for path in snapshots:
        record, digest, _ = _read_saved_result(scan_dir, path, scan_id)
        if digest != sources[path] or not isinstance(record.get("sources"), dict):
            raise ContractError("saved source ordering changed after the scan stopped")
        context = record.get("parentContext")
        if parent_context is not None and context is not None:
            if not isinstance(context, dict) or any(
                (
                    "canonical" not in context
                    or not isinstance(relative, str)
                    or not re.fullmatch(r"-?[0-9]+", relative)
                )
                if role == "canonicalObservedAtNs"
                else (
                    role not in ("canonical", "head")
                    or not isinstance(relative, str)
                    or relative not in sources
                    or (role == "canonical" and Path(relative).parent != Path("checkpoints"))
                    or (role == "head" and _checkpoint_head_directory(relative) != Path("."))
                )
                for role, relative in context.items()
            ):
                raise ContractError("saved parent context is outside the frozen sources")
            if any(
                role in parent_context and parent_context[role] != relative
                for role, relative in context.items()
            ):
                raise ContractError("saved parent context has conflicting observations")
            parent_context.update(context)
        for relative, observation in record["sources"].items():
            if (
                not isinstance(observation, dict)
                or relative not in sources
                or observation.get("digest") != sources[relative]
                or not isinstance(observation.get("observedAtNs"), str)
                or not re.fullmatch(r"-?[0-9]+", observation["observedAtNs"])
            ):
                raise ContractError("saved source ordering does not match its frozen sources")
            observed = int(observation["observedAtNs"])
            if relative in times and times[relative] != observed:
                raise ContractError("saved source ordering has conflicting observations")
            times[relative] = observed
    if snapshots and sources.keys() - set(snapshots) - times.keys():
        raise ContractError("saved source ordering is incomplete")
    return times


def _freeze_source_times(
    scan_dir: Path,
    scan_id: str,
    sources: dict[str, str],
    times: dict[str, int],
    parent_context: dict[str, str] | None = None,
) -> None:
    # Identical result rewrites must not change the order of frozen review evidence.
    observations = {
        path: {"digest": digest, "observedAtNs": str(times[path])}
        for path, digest in sources.items()
        if not _is_source_order_snapshot(path)
    }
    if not observations:
        return
    record = {"scanId": scan_id, "sources": observations}
    if parent_context:
        record["parentContext"] = parent_context
    digest = _digest(record)
    path = f"source-order/{digest}.json"
    if not (scan_dir / path).exists():
        write_scan_local_bytes(scan_dir, path, _encoded(record))
    if _read_saved_result(scan_dir, path, scan_id)[1] != digest:
        raise ContractError("saved source ordering does not match its digest")
    if parent_context:
        for previous in [relative for relative in sources if _is_source_order_snapshot(relative)]:
            previous_record, _, _ = _read_saved_result(scan_dir, previous, scan_id)
            if previous_record.get("parentContext"):
                del sources[previous]
    sources[path] = digest


def _parent_publication_ancestors(
    input_checkpoint: str | None, drafts: dict[str, dict[str, Any]]
) -> set[str]:
    """Find stale canonical projections without relying on publication clocks."""
    ancestors = set()
    inputs = set()
    # Input hashes distinguish repeated publication of the same projected result.
    while isinstance(input_checkpoint, str) and input_checkpoint not in inputs:
        inputs.add(input_checkpoint)
        publication = drafts.get(f"checkpoints/{input_checkpoint}", {}).get("publication")
        if not isinstance(publication, dict):
            break
        previous = publication.get("previousCheckpoint")
        if isinstance(previous, str):
            ancestors.add(f"checkpoints/{previous}")
        input_checkpoint = publication.get("previousInputCheckpoint")
    return ancestors


def _admit_parent_checkpoint(scan_dir: Path, scan_id: str, checkpoint: dict[str, Any]) -> bytes:
    """Bind a Deep input to the accepted head under the host's publication lock."""
    previous = {}
    try:
        previous, _, _ = _read_saved_result(scan_dir, "checkpoint-head.json", scan_id)
    except (ContractError, OSError, ValueError):
        pass
    return _encoded(
        {
            **checkpoint,
            "publication": {
                "previousCheckpoint": previous.get("checkpoint"),
                "previousInputCheckpoint": previous.get("inputCheckpoint"),
            },
        }
    )


def _capture_parent_observation(
    scan_dir: Path, checkpoint: str, observed: int, legacy_head: bool = False
) -> dict[str, tuple[str, int]]:
    """Freeze canonical input, preserving the legacy sealed-parent migration."""
    if legacy_head:
        write_scan_local_bytes(
            scan_dir, "checkpoint-head.json", _encoded({"checkpoint": checkpoint})
        )
        os.utime(scan_dir / "checkpoint-head.json", ns=(observed, observed))
    observation = {"checkpoint": checkpoint, "observedAtNs": str(observed)}
    digest = _digest(observation)
    snapshot = f"checkpoint-heads/{digest}.json"
    if not (scan_dir / snapshot).exists():
        write_scan_local_bytes(scan_dir, snapshot, _encoded(observation))
    return {snapshot: (digest, observed)}


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
