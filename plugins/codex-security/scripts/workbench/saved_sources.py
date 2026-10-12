"""Encoding, path, and observation helpers for saved scan sources."""

from __future__ import annotations

import hashlib
import json
import re
import stat
from pathlib import Path
from typing import Any


def _encoded(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode()


def _digest(value: Any) -> str:
    return hashlib.sha256(_encoded(value)).hexdigest()


def _encode_retained_sources(
    sources: dict[str, str],
    model_source: list[str],
    source_times: dict[str, int] | None = None,
) -> str:
    state: dict[str, Any] = sources
    if model_source or source_times is not None:
        state = {"sources": sources}
        if model_source:
            state["threatModelSource"] = model_source[0]
        if source_times is not None:
            state["sourceTimes"] = source_times
    return json.dumps(state, sort_keys=True)


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


def _checkpoint_head_directory(relative: str) -> Path | None:
    path = Path(relative)
    if path.name == "checkpoint-head.json":
        return path.parent
    if path.parent.name == "checkpoint-heads":
        return path.parent.parent
    return None


def _unselected_root_order(
    saved_heads: dict[str, str],
    checkpoint_heads: dict[str, str | None],
    source_order: dict[str, tuple[int, int]],
) -> tuple[int, int]:
    # One payload can have several accepted observations; retain their order.
    return max(
        (
            source_order[head]
            for head, checkpoint in saved_heads.items()
            if _checkpoint_head_directory(head) == Path(".")
            and checkpoint_heads.get(".") not in (None, head, f"checkpoints/{checkpoint}")
        ),
        default=(-1, 0),
    )


def _is_source_order_snapshot(relative: str) -> bool:
    path = Path(relative)
    return path.parent == Path("source-order") and bool(
        re.fullmatch(r"[0-9a-f]{64}\.json", path.name)
    )


def _latest_successful_reducer(workers: list[Any]) -> Any | None:
    return max(
        (
            worker
            for worker in workers
            if worker["kind"] == "dedup"
            and worker["status"] == "succeeded"
            and worker["result_manifest_path"]
        ),
        key=lambda worker: (worker["completed_at"] or "", worker["id"]),
        default=None,
    )
