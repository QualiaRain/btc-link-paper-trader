"""Settings validation, ported from configuration.js (same rules and messages)."""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timezone
from typing import Any

from .engine import create_account, finite

HORIZONS = [60000, 300000, 420000, 900000, 3600000, 25200000, 86400000]
CONFIG_FIELDS = ["initialCash", "horizonMs", "model", "lookbackIntervals", "bufferBps",
                 "allocationFraction", "stopLossBps", "feeBps", "slippageBps", "durationMs",
                 "maxQuoteAgeMs", "maxOutcomeLatenessMs"]
SETTINGS_FORMAT = "paper-trail-settings-v2"
_MINUTE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")


def utc_minute(value: Any) -> int:
    """Parse `YYYY-MM-DDTHH:MM` as a UTC millisecond epoch."""
    if not isinstance(value, str) or not _MINUTE_RE.match(value):
        raise ValueError("Choose a valid UTC date and minute.")
    try:
        moment = datetime.strptime(value, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    except ValueError:
        raise ValueError("Choose a valid UTC date and minute.") from None
    return int(moment.timestamp()) * 1000


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def normalize_settings(raw_input: Any, now_ms: float | None = None, check_range_end: bool = True) -> dict[str, Any]:
    """`check_range_end=False` skips only the clock-dependent "end is a completed minute" rule (for exports of past runs)."""
    if not _is_object(raw_input):
        raise ValueError("Invalid settings object.")
    raw = raw_input.get("config")
    if raw is None:
        account = raw_input.get("account")
        raw = account.get("config") if _is_object(account) else None
    if not _is_object(raw):
        raise ValueError("Settings need a config object.")
    config: dict[str, Any] = {}
    for field in raw:
        if field not in CONFIG_FIELDS and field != "mode":
            raise ValueError(f"Unknown configuration field: {field}")
    for field in CONFIG_FIELDS:
        if field in raw:
            config[field] = raw[field]
    config["mode"] = raw["mode"] if raw.get("mode") is not None else "replay"
    normalized = create_account(config)["config"]
    if normalized["horizonMs"] not in HORIZONS:
        raise ValueError("Choose one of the supported forecast horizons.")
    replay = raw_input.get("replay")
    if replay is None:
        market = raw_input.get("market")
        settings = market.get("settings") if _is_object(market) else None
        replay = settings.get("replay") if _is_object(settings) else None
    if replay is None:
        replay = {}
    if not _is_object(replay):
        replay = {}
    source = replay.get("source") if replay.get("source") is not None else "sample"
    if source not in ("sample", "range"):
        raise ValueError("Replay source must be sample or range.")
    half_spread = replay.get("halfSpreadBps") if replay.get("halfSpreadBps") is not None else 2
    if not finite(half_spread) or half_spread < 0 or half_spread > 1000:
        raise ValueError("Assumed replay half-spread must be between 0 and 1,000 basis points.")
    start = replay.get("start") if replay.get("start") is not None else ""
    end = replay.get("end") if replay.get("end") is not None else ""
    if source == "range":
        first, last = utc_minute(start), utc_minute(end)
        if last <= first or last - first > 31 * 86400000:
            raise ValueError("Choose an increasing UTC range of at most 31 days.")
        current = time.time() * 1000 if now_ms is None else now_ms
        if check_range_end and last > math.floor(current / 60000) * 60000:
            raise ValueError("Historical end must be a completed minute.")
    elif (start and not isinstance(start, str)) or (end and not isinstance(end, str)):
        raise ValueError("Invalid historical date fields.")
    return {"format": SETTINGS_FORMAT, "config": normalized,
            "replay": {"source": source, "start": start, "end": end, "halfSpreadBps": half_spread}}
