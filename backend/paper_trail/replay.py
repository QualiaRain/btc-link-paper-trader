"""Replay frame construction and execution.

Frames are built exactly as the browser app builds them: the bundled sample path
mirrors market.js `loadSample` plus app.js `start`, and the date-range path
mirrors replay.js `fetchHistoricalRange` after retrieval. The service never
fetches market data itself in this slice; range candles are supplied by the
caller, so no network access, credentials or keys are involved.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .canonical import js_number
from .configuration import utc_minute
from .engine import ASSETS, create_account, ingest, iso

MINUTE = 60000
SAMPLE_HISTORY = 300
DEFAULT_SAMPLE = Path(__file__).resolve().parents[2] / "data" / "sample.json"


def load_sample(path: Path | str | None = None) -> dict[str, Any]:
    data = json.loads(Path(path or DEFAULT_SAMPLE).read_text())
    rows = data.get("prices")
    if not isinstance(rows, list) or len(rows) < 8:
        raise ValueError("Incomplete replay sample")
    previous = float("-inf")
    for time, btc, link in rows:
        if not isinstance(time, int) or time <= previous:
            raise ValueError("Replay times must increase")
        previous = time
        if not all(isinstance(v, (int, float)) and v > 0 for v in (btc, link)):
            raise ValueError("Invalid market price")
    return data


def sample_dataset(half_spread_bps: float, lookback: int, path: Path | str | None = None) -> dict[str, Any]:
    """Frames for the bundled sample; the first `lookback` frames only supply warmup."""
    data = load_sample(path)
    half = half_spread_bps / 10000
    histories: dict[str, list[dict]] = {a: [] for a in ASSETS}
    frames = []
    for time, btc, link in data["prices"]:
        quotes = {}
        for asset, mid in (("BTC", btc), ("LINK", link)):
            histories[asset].append({"time": time, "price": mid})
            if len(histories[asset]) > SAMPLE_HISTORY:
                histories[asset].pop(0)
            quotes[asset] = {
                "bid": mid * (1 - half), "ask": mid * (1 + half), "mid": mid, "observedAt": time,
                "source": f"Historical Coinbase candle close with ASSUMED {js_number(half_spread_bps)} bps half-spread",
                "simulatedQuote": True}
        frames.append({"time": time, "quotes": quotes,
                       "history": {a: list(histories[a]) for a in ASSETS}})
    cursor = lookback
    if cursor >= len(frames) - 1:
        raise ValueError("The included sample is too short for this lookback.")
    from .evidence import sample_coverage  # local: evidence imports engine, and replay is imported by evidence users
    return {"kind": "sample", "source": data["source"], "capturedAt": data.get("capturedAt"),
            "periodStart": data.get("periodStart"), "periodEnd": data.get("periodEnd"),
            "assumptions": {**data.get("assumptions", {}), "halfSpreadBps": half_spread_bps},
            "documentation": data.get("documentation"), "frames": frames,
            "scoreStart": frames[cursor]["time"], "scoreEnd": frames[-1]["time"],
            "warmupFrameCount": cursor, "cursor": cursor,
            "coverage": sample_coverage({"frames": frames, "periodStart": data.get("periodStart"),
                                         "periodEnd": data.get("periodEnd")}, cursor)}


def _clean_series(asset: str, rows: Any) -> dict[int, float]:
    if not isinstance(rows, list):
        raise ValueError(f"{asset}: invalid candle response")
    seen: dict[int, float] = {}
    for row in rows:
        time, price = (row.get("time"), row.get("price")) if isinstance(row, dict) else (None, None)
        if not isinstance(time, int) or isinstance(time, bool) or time % MINUTE:
            raise ValueError(f"{asset}: candle times must be UTC minute-close timestamps")
        if not isinstance(price, (int, float)) or isinstance(price, bool) or not price > 0 or price == float("inf"):
            raise ValueError(f"{asset}: invalid candle values")
        if time in seen and seen[time] != price:
            raise ValueError(f"{asset}: conflicting duplicate candle")
        seen[time] = price
    return seen


def range_dataset(candles: dict[str, Any], start: int, end: int, half_spread_bps: float, lookback: int,
                  model: str = "trend") -> dict[str, Any]:
    """Frames for a UTC range from caller-supplied per-asset minute closes.

    Mirrors fetchHistoricalRange: warmup is bounded per asset, only shared
    minutes inside [start, end] are scored, nothing is filled or interpolated,
    and a missing exact boundary or insufficient causal warmup fails before any
    run exists.
    """
    warmup_minutes = max(60, 2 * lookback + 10)
    history_limit = lookback + 1
    required = history_limit if model == "trend" else 0
    if end <= start or end - start > 31 * 86400000:
        raise ValueError("Choose a positive range of at most 31 days")
    first = start - warmup_minutes * MINUTE
    series: dict[str, list[tuple[int, float]]] = {}
    coverage: dict[str, Any] = {}
    for asset in ASSETS:
        if asset not in candles:
            raise ValueError(f"{asset}: candles are required for a date-range replay")
        seen = {t: p for t, p in _clean_series(asset, candles[asset]).items() if first <= t <= end}
        values = sorted(seen.items())
        series[asset] = values
        missing = [t for t in range(start, end + 1, MINUTE) if t not in seen]
        expected = (end - start) // MINUTE + 1
        coverage[asset] = {"expectedCount": expected, "observedCount": expected - len(missing),
                           "missingCount": len(missing), "missingFraction": len(missing) / expected,
                           "startPresent": start in seen, "endPresent": end in seen,
                           "warmupObservedCount": sum(1 for t, _ in values if t < start)}
    if any(not coverage[a]["startPresent"] or not coverage[a]["endPresent"] for a in ASSETS):
        raise ValueError("Exact start/end close missing for one or both assets; boundaries were not changed")
    for asset in ASSETS:
        available = sum(1 for t, _ in series[asset] if t <= start)
        if available < required:
            raise ValueError(f"{asset}: only {available} causal observations at scored start; "
                             f"{required} required. Choose a smaller lookback or another range. No run was created.")
    index = {a: {t: i for i, (t, _) in enumerate(series[a])} for a in ASSETS}
    half = half_spread_bps / 10000
    label = f"Historical Coinbase close with ASSUMED {js_number(half_spread_bps)} bps half-spread"
    frames = []
    for time, _ in series["BTC"]:
        if time < start or time > end or time not in index["LINK"]:
            continue
        quotes, history = {}, {}
        for asset in ASSETS:
            i = index[asset][time]
            mid = series[asset][i][1]
            quotes[asset] = {"bid": mid * (1 - half), "ask": mid * (1 + half), "mid": mid, "observedAt": time,
                             "source": label, "simulatedQuote": True}
            history[asset] = [{"time": t, "price": p} for t, p in series[asset][max(0, i - history_limit + 1):i + 1]]
        frames.append({"time": time, "quotes": quotes, "history": history})
    return {"kind": "historical", "source": "Caller-supplied completed one-minute closes (Coinbase Exchange format)",
            "periodStart": start, "periodEnd": end, "scoreStart": start, "scoreEnd": end,
            "frames": frames, "coverage": coverage,
            "assumptions": {"halfSpreadBps": half_spread_bps,
                            "spread": "Assumed historical bid/ask; not observed executable quotes",
                            "missingMinutes": "Only shared observed close timestamps are scored; per-asset "
                                              "histories retain separate observed minutes, never filled.",
                            "execution": "Hypothetical fills omit latency, market impact, liquidity and queue position."},
            "evidence": {"requestedStart": start, "requestedEnd": end, "warmupMinutes": warmup_minutes,
                         "historyLimit": history_limit, "requiredHistory": required,
                         "sharedCount": len(frames),
                         "prices": {a: [{"time": t, "price": p} for t, p in series[a]] for a in ASSETS}},
            "warmupFrameCount": 0, "cursor": 0}


def run_replay(settings: dict[str, Any], candles: dict[str, Any] | None = None,
               sample_path: Path | str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run a complete replay from validated settings. Returns (account, dataset)."""
    config = dict(settings["config"])
    if config["mode"] != "replay":
        raise ValueError("Only replay mode is supported by this service")
    replay = settings["replay"]
    half = replay["halfSpreadBps"]
    if replay["source"] == "range":
        if candles is None:
            raise ValueError("A date-range replay needs candles for BTC and LINK")
        dataset = range_dataset(candles, utc_minute(replay["start"]), utc_minute(replay["end"]), half,
                                config["lookbackIntervals"], config["model"])
    else:
        dataset = sample_dataset(half, config["lookbackIntervals"], sample_path)
    frames, cursor = dataset["frames"], dataset["cursor"]
    if not frames or frames[cursor]["time"] != dataset["scoreStart"] or frames[-1]["time"] != dataset["scoreEnd"]:
        raise ValueError("Historical data is missing an exact scored boundary. No run was created.")
    config["durationMs"] = dataset["scoreEnd"] - dataset["scoreStart"]
    if config["durationMs"] < config["horizonMs"]:
        raise ValueError("The scored date range must be at least one forecast horizon long.")
    account = create_account(config)
    ingest(account, frames[cursor])
    for frame in frames[cursor + 1:]:
        ingest(account, frame)
        if account["status"] == "completed":
            break
    return account, dataset


@lru_cache(maxsize=4)
def _shared_sample_dataset(half_spread_bps: float, lookback: int) -> dict[str, Any]:
    return sample_dataset(half_spread_bps, lookback)


def prepare_replay(settings: dict[str, Any], candles: dict[str, Any] | None = None,
                   sample_path: Path | str | None = None, share_sample: bool = False
                   ) -> tuple[dict[str, Any], dict[str, Any]]:
    """The dataset construction and validation of `run_replay`, without running it.

    Returns (config with the scored duration, dataset). With `share_sample` the bundled-sample dataset
    may be a cached object shared between callers, which must treat its frames as read-only.
    """
    config = dict(settings["config"])
    if config["mode"] != "replay":
        raise ValueError("Only replay mode is supported by this service")
    replay = settings["replay"]
    half = replay["halfSpreadBps"]
    if replay["source"] == "range":
        if candles is None:
            raise ValueError("A date-range replay needs candles for BTC and LINK")
        dataset = range_dataset(candles, utc_minute(replay["start"]), utc_minute(replay["end"]), half,
                                config["lookbackIntervals"], config["model"])
    elif share_sample and sample_path is None:
        dataset = _shared_sample_dataset(half, config["lookbackIntervals"])
    else:
        dataset = sample_dataset(half, config["lookbackIntervals"], sample_path)
    frames, cursor = dataset["frames"], dataset["cursor"]
    if not frames or frames[cursor]["time"] != dataset["scoreStart"] or frames[-1]["time"] != dataset["scoreEnd"]:
        raise ValueError("Historical data is missing an exact scored boundary. No run was created.")
    config["durationMs"] = dataset["scoreEnd"] - dataset["scoreStart"]
    if config["durationMs"] < config["horizonMs"]:
        raise ValueError("The scored date range must be at least one forecast horizon long.")
    return config, dataset


def start_account(config: dict[str, Any], dataset: dict[str, Any]) -> dict[str, Any]:
    """A new account with the first scored frame ingested (the state a stepwise session starts from)."""
    account = create_account(config)
    ingest(account, dataset["frames"][dataset["cursor"]])
    return account
