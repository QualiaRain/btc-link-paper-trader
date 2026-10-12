"""Browser-parity market evidence: the history catalog encoding and the saved-run market snapshot.

`history.js` stores every run's market as `{kind, dataset, cursor, lastObservedFrame, scoreStart, scoreEnd,
settings}` where the dataset's per-frame `history` arrays are replaced by references into a per-asset catalog of
distinct observations (`historyEncoding: 'history-catalog-v1'`). The functions here reproduce that encoding and the
browser's dataset/snapshot construction exactly, so a run created by Python can be opened by the existing browser
app and has the same `marketSha256` as the browser computes for the same inputs.

Wiring a Python-created run (see `records.make_run_record`, which hashes whatever `market` it is given)::

    dataset = evidence.browser_sample_dataset(half_spread_bps, lookback)       # or FetchResult.dataset()
    market = evidence.packed_browser_market("sample", dataset, settings, cursor)
    record = make_run_record(account, market, name=..., run_id=...)

Rows are shared between frames, catalogs and caches (as in the browser); treat everything returned as read-only.
"""
from __future__ import annotations

import json
import math
from operator import is_ as _is
from functools import lru_cache
from pathlib import Path
from typing import Any

from .canonical import canonical_json, js_number, sha256_canonical
from .engine import ASSETS

ENCODING = "history-catalog-v1"
SAMPLE_PATH = Path(__file__).resolve().parents[2] / "data" / "sample.json"
SAMPLE_HISTORY = 300
_SAFE = 2 ** 53 - 1
_UNSET: Any = object()


def _js_falsy(value: Any) -> bool:
    if value is None or value is False or value == "":
        return True
    return isinstance(value, (int, float)) and not isinstance(value, bool) and (value == 0 or value != value)


# ----------------------------------------------------------------------------------- pack / unpack

def _row_key(row: Any) -> Any:
    """Hashable identity of an observation: equal exactly when the canonical JSON texts are equal."""
    if type(row) is dict and len(row) == 2:
        time, price = row.get("time", _UNSET), row.get("price", _UNSET)
        if time is not _UNSET and price is not _UNSET:
            ok = True
            for v in (time, price):
                t = type(v)
                if t is int:
                    ok = ok and -_SAFE <= v <= _SAFE
                elif t is float:
                    ok = ok and math.isfinite(v)
                else:
                    ok = False
            if ok:
                return time, price  # 1 == 1.0 and 0.0 == -0.0, exactly like the canonical text
    return canonical_json(row)  # raises for non-finite numbers / non-JSON values, like canonicalJSON


def _history_entries(history: Any) -> list[tuple[str, Any]]:
    """`Object.entries(history)`: objects and arrays have entries, a (non-empty) string's are not row arrays."""
    if isinstance(history, dict):
        return list(history.items())
    if isinstance(history, list):
        return [(str(i), v) for i, v in enumerate(history)]
    if isinstance(history, str):
        raise ValueError("Invalid frame history")  # entries are single characters, never row arrays
    return []  # numbers and booleans have no own enumerable properties


def pack_dataset(dataset: Any) -> Any:
    """`packDataset`: store each history observation once and give frames `historyRefs`."""
    if not isinstance(dataset, dict) or not isinstance(dataset.get("frames"), list) \
            or dataset.get("historyEncoding") == ENCODING:
        return dataset
    catalogs: dict[str, list] = {}
    indexes: dict[str, dict] = {}
    window: dict[str, tuple[list, list]] = {}
    frames = []
    for frame in dataset["frames"]:
        if not isinstance(frame, dict):
            raise ValueError("Invalid frame")
        rest = {k: v for k, v in frame.items() if k != "history"}
        history = frame.get("history")
        if _js_falsy(history):
            frames.append(rest)
            continue
        history_refs = {}
        for asset, rows in _history_entries(history):
            if not isinstance(rows, list):
                raise ValueError("Invalid frame history")
            catalog = catalogs.setdefault(asset, [])
            index = indexes.setdefault(asset, {})

            def ref_of(row: Any) -> int:
                key = _row_key(row)
                ref = index.get(key)
                if ref is None:
                    ref = index[key] = len(catalog)
                    catalog.append(row)
                return ref

            # Replay frames slide a window over shared observation objects: when this window is the previous one
            # moved (or grown) by one row, reuse its references and only resolve the new last row.
            previous = window.get(asset)
            refs = None
            if previous is not None and isinstance(rows, list) and rows:
                before, before_refs = previous
                head = rows[:-1]
                if len(rows) == len(before) and all(map(_is, head, before[1:])):
                    refs = before_refs[1:] + [ref_of(rows[-1])]
                elif len(rows) == len(before) + 1 and all(map(_is, head, before)):
                    refs = before_refs + [ref_of(rows[-1])]
            if refs is None:
                refs = [ref_of(row) for row in rows]
            window[asset] = (rows, refs)
            if not refs or refs == list(range(refs[0], refs[0] + len(refs))):
                history_refs[asset] = {"start": refs[0] if refs else 0, "length": len(refs)}
            else:
                history_refs[asset] = {"indices": refs}
        frames.append({**rest, "historyRefs": history_refs})
    return {**dataset, "frames": frames, "historyEncoding": ENCODING, "historyCatalog": catalogs}


def _safe_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if abs(value) <= _SAFE else None
    if isinstance(value, float) and math.isfinite(value) and value.is_integer() and abs(value) <= _SAFE:
        return int(value)
    return None


def unpack_dataset(dataset: Any) -> Any:
    """`unpackDataset`: restore each frame's `history` from the catalog (same errors as history.js)."""
    if not isinstance(dataset, dict) or dataset.get("historyEncoding") != ENCODING:
        return dataset
    rest = {k: v for k, v in dataset.items() if k not in ("historyEncoding", "historyCatalog")}
    catalogs = dataset.get("historyCatalog")
    if _js_falsy(catalogs) or not isinstance(rest.get("frames"), list):
        raise ValueError("Invalid packed market evidence")
    frames = []
    for frame in rest["frames"]:
        if not isinstance(frame, dict):
            raise ValueError("Invalid packed market evidence")
        other = {k: v for k, v in frame.items() if k != "historyRefs"}
        refs_by_asset = frame.get("historyRefs")
        if _js_falsy(refs_by_asset):
            frames.append(other)
            continue
        history = {}
        for asset, refs in refs_by_asset.items():
            catalog = catalogs.get(asset) if isinstance(catalogs, dict) else None
            if not isinstance(catalog, list):
                raise ValueError("Missing history catalog")
            if not isinstance(refs, dict):
                raise ValueError("Invalid history reference")
            indices = refs.get("indices")
            if isinstance(indices, list):
                ids = [_safe_int(i) for i in indices]
                if any(i is None or i < 0 or i >= len(catalog) for i in ids):
                    raise ValueError("Invalid history reference")
                history[asset] = [catalog[i] for i in ids]
                continue
            start, length = _safe_int(refs.get("start")), _safe_int(refs.get("length"))
            if start is None or length is None or start < 0 or length < 0 or (length and start + length > len(catalog)):
                raise ValueError("Invalid history reference")
            history[asset] = catalog[start:start + length]
        frames.append({**other, "history": history})
    return {**rest, "frames": frames}


def pack_market(market: Any) -> Any:
    """`packMarket`: pack `market.dataset` (and a market that is itself a dataset with frames)."""
    if _js_falsy(market):
        return None
    if not isinstance(market, dict):
        raise ValueError("Invalid market evidence")
    result = dict(market)
    if not _js_falsy(market.get("dataset")):
        result["dataset"] = pack_dataset(market["dataset"])
    if isinstance(market.get("frames"), list):
        result = pack_dataset(result)
    return result


def unpack_market(market: Any) -> Any:
    """`unpackMarket`: the inverse of `pack_market`."""
    if _js_falsy(market):
        return None
    result = unpack_dataset(market)
    if isinstance(result, dict) and not _js_falsy(result.get("dataset")):
        result = {**result, "dataset": unpack_dataset(result["dataset"])}
    return result


def market_sha256(market: Any) -> str:
    """The `marketSha256` a run record carries: SHA-256 of the canonical JSON of the packed market."""
    return sha256_canonical(pack_market(market))


# ----------------------------------------------------------------------------------- browser datasets

def _finite_number(value: Any) -> float | None:
    """`Number(value)` when it is finite; None otherwise."""
    try:
        number = float(value) if not isinstance(value, str) else float(value.strip() or "nan")
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _price(value: Any) -> float:
    number = _finite_number(value)
    if number is None or number <= 0:
        raise ValueError("Invalid market price")
    return number


@lru_cache(maxsize=2)
def _load_sample(path: str, mtime_ns: int) -> dict[str, Any]:
    data = json.loads(Path(path).read_text())
    prices = data.get("prices")
    if not isinstance(prices, list) or len(prices) < 8:
        raise ValueError("Incomplete replay sample")
    half = _finite_number(data["assumptions"]["halfSpreadBps"])
    half = None if half is None else half / 10000
    if half is None or half < 0 or half >= 1:
        raise ValueError("Invalid assumed spread")
    histories: dict[str, list] = {a: [] for a in ASSETS}
    previous = -math.inf
    frames = []
    for time, btc, link in prices:
        if isinstance(time, bool) or not isinstance(time, int) or abs(time) > _SAFE or time <= previous:
            raise ValueError("Replay times must increase")
        previous = time
        quotes = {}
        for asset, value in (("BTC", btc), ("LINK", link)):
            mid = _price(value)
            histories[asset].append({"time": time, "price": mid})
            if len(histories[asset]) > SAMPLE_HISTORY:
                histories[asset].pop(0)
            quotes[asset] = {"bid": mid * (1 - half), "ask": mid * (1 + half), "mid": mid, "observedAt": time,
                             "receivedAt": time, "exchangeTime": time,
                             "source": "Historical Coinbase candle close with ASSUMED 2 bps half-spread",
                             "simulatedQuote": True}
        frames.append({"time": time, "quotes": quotes, "history": {a: list(histories[a]) for a in ASSETS}})
    return {"source": data["source"], "capturedAt": data["capturedAt"], "periodStart": data["periodStart"],
            "periodEnd": data["periodEnd"], "assumptions": data["assumptions"],
            "documentation": data["documentation"], "frames": frames}


def load_browser_sample(path: Path | str | None = None) -> dict[str, Any]:
    """`loadSample()` of market.js: the bundled sample as the browser first builds it (read-only, cached)."""
    target = Path(path or SAMPLE_PATH).resolve()
    return _load_sample(str(target), target.stat().st_mtime_ns)


def browser_sample_dataset(half_spread_bps: float, lookback: int, path: Path | str | None = None) -> dict[str, Any]:
    """The sample dataset `app.js start('replay')` builds; the run's cursor is `lookback` (= warmupFrameCount)."""
    sample = load_browser_sample(path)
    half = half_spread_bps / 10000
    label = f"Historical Coinbase candle close with ASSUMED {js_number(half_spread_bps)} bps half-spread"
    frames = [{**f, "quotes": {a: {**f["quotes"][a], "bid": f["quotes"][a]["mid"] * (1 - half),
                                   "ask": f["quotes"][a]["mid"] * (1 + half), "source": label} for a in ASSETS}}
              for f in sample["frames"]]
    if lookback >= len(frames) - 1:
        raise ValueError("The included sample is too short for this lookback.")
    return {**sample, "frames": frames, "scoreStart": frames[lookback]["time"], "scoreEnd": frames[-1]["time"],
            "assumptions": {**sample["assumptions"], "halfSpreadBps": half_spread_bps}, "warmupFrameCount": lookback}


def browser_market(kind: str, dataset: dict[str, Any] | None, settings: dict[str, Any] | None, cursor: int, *,
                   account: dict[str, Any] | None = None, last_observed_frame: Any = _UNSET) -> dict[str, Any]:
    """`marketSnapshot()` of app.js (unpacked): what a saved run's market holds before `pack_market`.

    `lastObservedFrame` defaults to `dataset.frames[cursor]` (how the browser tracks it for replays);
    `scoreStart`/`scoreEnd` fall back to the account's `startedAt`/`endsAt` exactly like `??` in the browser.
    """
    frames = dataset.get("frames") if isinstance(dataset, dict) else None
    if last_observed_frame is _UNSET:
        last_observed_frame = frames[cursor] if isinstance(frames, list) and 0 <= cursor < len(frames) else _UNSET
    market: dict[str, Any] = {"kind": kind, "dataset": dataset, "cursor": cursor}
    if last_observed_frame is not _UNSET:
        market["lastObservedFrame"] = last_observed_frame

    def pick(name: str, fallback: str) -> None:
        value = dataset.get(name) if isinstance(dataset, dict) else None
        if value is None and isinstance(account, dict) and fallback in account:
            value = account[fallback]
        if value is not None or (isinstance(account, dict) and fallback in account):
            market[name] = value

    pick("scoreStart", "startedAt")
    pick("scoreEnd", "endsAt")
    market["settings"] = settings
    return market


def packed_browser_market(kind: str, dataset: dict[str, Any] | None, settings: dict[str, Any] | None, cursor: int, *,
                          account: dict[str, Any] | None = None, last_observed_frame: Any = _UNSET) -> dict[str, Any]:
    """`pack_market(browser_market(...))`: pass this as `market` to `records.make_run_record`."""
    return pack_market(browser_market(kind, dataset, settings, cursor, account=account,
                                      last_observed_frame=last_observed_frame))
