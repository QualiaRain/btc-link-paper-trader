"""Create run records with the Python backend that the browser app can open (`parity/evidence/fixtures/python-run-*.json`).

Each record carries the browser's market snapshot (frame-level dataset in the history catalog encoding, cursor,
last observed frame, settings), so `history.js` verifies its hashes and `app.js` `installRecord` accepts it.
`parity/evidence/python-record.test.mjs` checks the committed files with the REAL history.js, and
`backend/tests/test_parity_evidence.py` checks they still equal what this script builds (except timestamps).

Re-run from `backend/`:  python scripts/make_python_run_fixtures.py          (no network: synthetic candles)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from paper_trail import evidence  # noqa: E402
from paper_trail.candles import CandleFetcher  # noqa: E402
from paper_trail.canonical import canonical_json  # noqa: E402
from paper_trail.configuration import normalize_settings, utc_minute  # noqa: E402
from paper_trail.engine import create_account, ingest, manual_trade  # noqa: E402
from paper_trail.records import make_run_record  # noqa: E402

OUT = ROOT / "parity" / "evidence" / "fixtures"
MINUTE = 60000
START = 1_709_985_600_000  # 2024-03-09T12:00:00Z


def sample_settings() -> dict:
    return normalize_settings({"config": {"lookbackIntervals": 7, "horizonMs": 300000, "bufferBps": 0, "feeBps": 1,
                                          "slippageBps": 0, "initialCash": 1000},
                               "replay": {"source": "sample", "halfSpreadBps": 0.5}})


def synthetic_candles(span: int, warmup: int) -> dict:
    """Deterministic closes with a few missing minutes per asset (never at the boundaries)."""
    out = {}
    for asset, base, holes in (("BTC", 61000.5, {5, 6, 40, -3}), ("LINK", 18.37, {6, 33, 34, -12})):
        price, rows = base, []
        for k in range(-warmup, span + 1):
            price = round(price * (1 + (((k * 7919) % 101) - 50) / 20000), 2)
            if k not in holes:
                rows.append({"time": START + k * MINUTE, "price": price})
        out[asset] = rows
    return out


def transport_for(candles: dict):
    from datetime import datetime, timezone

    def parse(text):
        return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp() * 1000)

    def transport(url, timeout):
        parts, query = urlsplit(url), parse_qs(urlsplit(url).query)
        asset = "LINK" if "LINK-USD" in parts.path else "BTC"
        lo, hi = parse(query["start"][0]), parse(query["end"][0])
        rows = [[(c["time"] - MINUTE) // 1000, c["price"] - 1, c["price"] + 1, c["price"], c["price"], 1]
                for c in candles[asset] if lo <= c["time"] - MINUTE <= hi][::-1]
        return 200, {"date": "Sat, 09 Mar 2024 12:00:00 GMT"}, canonical_json(rows).encode()

    return transport


def play(settings: dict, dataset: dict, kind: str, first: int, last: int, manual: bool = False) -> dict:
    config = {**settings["config"], "durationMs": dataset["scoreEnd"] - dataset["scoreStart"]}
    account = create_account(config)
    frames = dataset["frames"]
    ingest(account, frames[first])
    cursor = first
    while cursor < last and account["status"] != "completed":
        cursor += 1
        ingest(account, frames[cursor])
    if manual:
        manual_trade(account, "BTC", "buy", 100, frames[cursor])
    return {"account": account, "cursor": cursor}


def build_records() -> dict[str, dict]:
    records = {}
    settings = sample_settings()
    lookback = settings["config"]["lookbackIntervals"]
    full = evidence.browser_sample_dataset(settings["replay"]["halfSpreadBps"], lookback)
    frames = full["frames"][:140]  # the same prefix parity/make-browser-records.mjs uses
    dataset = {**full, "frames": frames, "scoreStart": frames[lookback]["time"], "scoreEnd": frames[-1]["time"]}
    for name, last, manual in (("python-run-sample-completed", len(frames) - 1, False),
                               ("python-run-sample-partial-manual", lookback + 40, True)):
        played = play(settings, dataset, "sample", lookback, last, manual)
        market = evidence.packed_browser_market("sample", dataset, settings, played["cursor"], account=played["account"])
        records[name] = make_run_record(played["account"], market, name=name, run_id=name)

    span, warmup = 180, 60
    range_settings = normalize_settings({"config": {"lookbackIntervals": 7, "horizonMs": 300000, "bufferBps": 0, "feeBps": 1,
                                                    "slippageBps": 0, "initialCash": 1000},
                                         "replay": {"source": "range", "start": "2024-03-09T12:00",
                                                    "end": "2024-03-09T15:00", "halfSpreadBps": 3.5}})
    clock = iter(range(1_710_000_000_000, 1_710_000_100_000, 7))
    fetcher = CandleFetcher(transport=transport_for(synthetic_candles(span, warmup)), sleep=lambda s: None,
                            clock=lambda: next(clock))
    result = fetcher.fetch_range(utc_minute(range_settings["replay"]["start"]), utc_minute(range_settings["replay"]["end"]),
                                 half_spread_bps=3.5, warmup_minutes=warmup, history_limit=8, required_history=8)
    ranged = result.dataset()
    played = play(range_settings, ranged, "historical", 0, 90)
    market = evidence.packed_browser_market("historical", ranged, range_settings, played["cursor"], account=played["account"])
    records["python-run-range-partial"] = make_run_record(played["account"], market, name="python-run-range-partial",
                                                          run_id="python-run-range-partial")
    return records


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, record in build_records().items():
        (OUT / f"{name}.json").write_text(json.dumps(record) + "\n")
        print(name, record["status"], "frames", len(record["market"]["dataset"]["frames"]), "cursor", record["market"]["cursor"],
              "trades", record["summary"]["tradeCount"], "manual", record["manualTradeCount"])
