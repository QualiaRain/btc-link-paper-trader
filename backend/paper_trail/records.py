"""Run records compatible with history.js `paper-trail-run-v2` and a small run store."""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .canonical import js_copy, sha256_canonical
from .engine import create_account, get_summary, iso

RUN_FORMAT = "paper-trail-run-v2"
HASH_ALGORITHM = "SHA-256 / canonical JSON"
_ID_RE = re.compile(r"[A-Za-z0-9_.-]{1,128}")  # used with fullmatch: `$` would admit a trailing newline


def now_iso() -> str:
    return iso(datetime.now(timezone.utc).timestamp() * 1000)


def validate_record(record: Any) -> None:
    if not isinstance(record, dict) or record.get("format") != RUN_FORMAT \
            or not isinstance(record.get("id"), str) or not _ID_RE.fullmatch(record["id"]):
        raise ValueError("Invalid run record")
    account = record.get("account")
    hashes = record.get("hashes")
    if not isinstance(account, dict) or not isinstance(account.get("config"), dict) \
            or not isinstance(account.get("ledger"), list) or not isinstance(account.get("equity"), list) \
            or not record.get("summary") or not isinstance(hashes, dict) \
            or not hashes.get("configSha256") or not hashes.get("marketSha256"):
        raise ValueError("Incomplete run record")


def make_run_record(account: dict, market: dict | None, name: str | None = None,
                    run_id: str | None = None) -> dict[str, Any]:
    if not isinstance(account, dict) or not account.get("config") or not isinstance(account.get("ledger"), list):
        raise ValueError("No account to save")
    snapshot = js_copy(account)
    packed_market = js_copy(market)
    stamp = now_iso()
    rid = run_id or str(uuid.uuid4())
    started = snapshot.get("startedAt")
    label = str(name if name is not None else
                f"{snapshot['config']['mode']} · {stamp if started is None else iso(started)}").strip()[:100]
    config = js_copy(snapshot["config"])
    record = {
        "format": RUN_FORMAT, "id": rid, "name": label or "Unnamed run", "createdAt": stamp, "updatedAt": stamp,
        "status": snapshot["status"], "config": config, "summary": get_summary(snapshot), "account": snapshot,
        "market": packed_market,
        "hashes": {"algorithm": HASH_ALGORITHM, "configSha256": sha256_canonical(config),
                   "marketSha256": sha256_canonical(packed_market)},
        "manualTradeCount": sum(1 for e in snapshot["ledger"] if e["type"] == "trade" and e["actor"] == "manual"),
    }
    validate_record(record)
    return record


def run_metadata(record: dict) -> dict[str, Any]:
    validate_record(record)
    market = record.get("market") or {}
    dataset = market.get("dataset") or {}
    return {
        "id": record["id"], "name": record.get("name"), "createdAt": record.get("createdAt"),
        "updatedAt": record.get("updatedAt"), "status": record.get("status"), "config": record["config"],
        "summary": record["summary"], "hashes": record["hashes"],
        "manualTradeCount": record.get("manualTradeCount", 0),
        "source": market.get("source") or dataset.get("source") or market.get("kind") or "Supplied observations",
        "scoreStart": _first(market.get("scoreStart"), dataset.get("scoreStart"), record["account"].get("startedAt")),
        "scoreEnd": _first(market.get("scoreEnd"), dataset.get("scoreEnd"), record["summary"].get("valuationAt")),
    }


def _first(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _close(a: Any, b: Any, tolerance: float = 1e-9) -> bool:
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_close(a[k], b[k], tolerance) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_close(x, y, tolerance) for x, y in zip(a, b))
    if isinstance(a, bool) or isinstance(b, bool) or a is None or b is None:
        return a is b or a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tolerance * max(1.0, abs(a), abs(b))
    return a == b


def verify_imported_record(record: Any) -> dict[str, Any]:
    """Check a browser-exported run for corruption: structure, hashes and internal consistency.

    This detects damaged or accidentally edited records. It is not tamper-proofing: the hashes
    cover only the config and market evidence, and someone who edits the account and recomputes
    the summary passes every check (as the app's README says of its own hashes).
    The record is returned unchanged on success.
    """
    from pydantic import ValidationError  # local: keeps `records` importable without the API layer

    from .schemas import Account, Summary

    validate_record(record)
    for key in ("name", "createdAt", "updatedAt", "status"):
        if not isinstance(record.get(key), str):
            raise ValueError(f"Run record needs a text {key}")
    if sha256_canonical(record["config"]) != record["hashes"]["configSha256"]:
        raise ValueError("Run record config hash does not match its config")
    if sha256_canonical(record.get("market")) != record["hashes"]["marketSha256"]:
        raise ValueError("Run record market hash does not match its market evidence")
    if record["account"]["config"] != record["config"]:
        raise ValueError("Run record config differs from the account config")
    try:
        create_account(record["config"])  # the rules the browser enforced when the run was created
        Account.model_validate(record["account"])
        Summary.model_validate(record["summary"])
        recomputed = get_summary(record["account"])
    except ValidationError as error:
        first = error.errors()[0]
        raise ValueError(f"Run record is malformed at {'.'.join(str(p) for p in first['loc'])}: {first['msg']}") from None
    except (ValueError, KeyError, TypeError, ZeroDivisionError, AttributeError) as error:
        raise ValueError(f"Run record is malformed: {error}") from None
    if not _close(recomputed, record["summary"]):
        raise ValueError("Run record summary does not match its account")
    return record


class RunStore:
    """Run history keyed by stable run id. In-memory unless a directory is given. Thread-safe."""

    def __init__(self, directory: str | os.PathLike | None = None) -> None:
        self._runs: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._dir = Path(directory) if directory else None
        if self._dir:
            self._dir.mkdir(parents=True, exist_ok=True)
            for path in sorted(self._dir.glob("*.json")):
                try:
                    record = json.loads(path.read_text())
                    validate_record(record)
                    run_metadata(record)  # a record that cannot be listed is not loaded
                    self._runs[record["id"]] = record
                except (ValueError, OSError, KeyError, TypeError, AttributeError):
                    continue  # an unreadable file never prevents the service from starting

    def save(self, record: dict) -> dict:
        validate_record(record)
        saved = deepcopy(record)
        with self._lock:
            existing = self._runs.get(saved["id"])
            if existing:  # saving another snapshot updates the run and keeps its creation time
                saved["createdAt"] = existing.get("createdAt", saved.get("createdAt"))
            if self._dir:
                target = self._dir / f"{saved['id']}.json"
                temp = target.with_name(f"{target.name}.{uuid.uuid4().hex}.tmp")
                temp.write_text(json.dumps(saved))
                os.replace(temp, target)
            self._runs[saved["id"]] = saved
        return deepcopy(saved)

    def get(self, run_id: str) -> dict | None:
        with self._lock:
            record = self._runs.get(run_id)
            return deepcopy(record) if record else None

    def list(self) -> list[dict]:
        with self._lock:
            rows = [run_metadata(r) for r in self._runs.values()]
        rows.sort(key=lambda r: r["id"])
        rows.sort(key=lambda r: r["updatedAt"] or "", reverse=True)
        return rows
