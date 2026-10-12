"""Parity between history.js / market.js / replay.js / app.js and the Python evidence module.

`parity/evidence/expected/*.json` is produced by running the EXISTING JavaScript (`packMarket`, `unpackMarket`,
`makeRunRecord`, `exportRun`, `loadSample`, `fetchHistoricalRange`) over `parity/evidence/inputs/*.json`;
`parity/evidence/golden.test.mjs` fails if the goldens stop matching the JavaScript. Python must reproduce the
packed market (canonical JSON and SHA-256), the unpacked frames, and the same errors for malformed packed input.
Python-created records are verified by the real history.js in `parity/evidence/python-record.test.mjs`.
"""
from __future__ import annotations

import copy
import hashlib
import itertools
import json
from pathlib import Path

import pytest

from paper_trail import evidence
from paper_trail.candles import CandleFetcher
from paper_trail.canonical import canonical_json, sha256_canonical
from paper_trail.configuration import normalize_settings
from paper_trail.engine import create_account, ingest
from paper_trail.records import make_run_record

from test_candles import candle_transport  # noqa: F401  (shared helpers live next to the candle tests)

PARITY = Path(__file__).resolve().parents[2] / "parity"
EVIDENCE = PARITY / "evidence"
MINUTE = 60000
TEXT_LIMIT = 30000  # must equal TEXT_LIMIT in parity/evidence/harness.mjs


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def summarize(value) -> dict:
    text = canonical_json(value)
    utf16 = len(text.encode("utf-16-le", "surrogatepass")) // 2  # JavaScript string length
    return {"sha256": sha(text), "length": utf16, **({"text": text} if len(text) <= TEXT_LIMIT else {})}


def load(kind: str):
    case = json.loads((EVIDENCE / "inputs" / f"{kind}.json").read_text())
    golden = json.loads((EVIDENCE / "expected" / f"{kind}.json").read_text())
    assert golden["name"] == case["name"] and golden["kind"] == case["kind"]
    assert golden["scenarios"].keys() == {s["name"] for s in case["scenarios"]}
    return case, golden


def attempt(fn):
    try:
        return {"ok": fn()}
    except ValueError as error:
        return {"error": str(error)}


def run_pack(scenario: dict) -> dict:
    packed = attempt(lambda: evidence.pack_market(copy.deepcopy(scenario["market"])))
    if "error" in packed:
        return {"error": packed["error"]}
    unpacked = attempt(lambda: evidence.unpack_market(packed["ok"]))
    out = {"packed": summarize(packed["ok"])}
    out["unpacked"] = {"error": unpacked["error"]} if "error" in unpacked else summarize(unpacked["ok"])
    out["repacked"] = None if "error" in unpacked else summarize(evidence.pack_market(unpacked["ok"]))["sha256"]
    return out


def run_unpack(scenario: dict) -> dict:
    result = attempt(lambda: evidence.unpack_market(copy.deepcopy(scenario["market"])))
    return {"error": result["error"]} if "error" in result else {"unpacked": summarize(result["ok"])}


def thin(frames: list, every: int | None) -> list:
    if not every:
        return frames
    out = []
    for i, f in enumerate(frames):
        if i % every or not f.get("history") or len(f["history"]["BTC"]) < 5:
            out.append(f)
        else:
            out.append({**f, "history": {a: [r for j, r in enumerate(f["history"][a]) if j != 3] for a in ("BTC", "LINK")}})
    return out


def build_dataset(spec: dict, settings: dict):
    if spec["source"] == "sample":
        half, lookback = settings["replay"]["halfSpreadBps"], settings["config"]["lookbackIntervals"]
        full = evidence.browser_sample_dataset(half, lookback)
        frames = full["frames"]
        if spec.get("frameLimit"):
            frames = frames[:spec["frameLimit"]]
        frames = thin(frames, spec.get("thinEvery"))
        dataset = {**full, "frames": frames, "scoreStart": frames[lookback]["time"], "scoreEnd": frames[-1]["time"]}
        return dataset, "sample", lookback
    ticks = itertools.count()
    clock = lambda: spec["clockBase"] + 7 * next(ticks)  # noqa: E731  same counter as the JS harness's Date.now
    from paper_trail.configuration import utc_minute
    config = settings["config"]
    fetcher = CandleFetcher(transport=candle_transport_for(spec["candles"]), sleep=lambda s: None, clock=clock)
    result = fetcher.fetch_range(
        utc_minute(settings["replay"]["start"]), utc_minute(settings["replay"]["end"]),
        half_spread_bps=settings["replay"]["halfSpreadBps"], warmup_minutes=max(60, 2 * config["lookbackIntervals"] + 10),
        history_limit=config["lookbackIntervals"] + 1,
        required_history=config["lookbackIntervals"] + 1 if config["model"] == "trend" else 0)
    return result.dataset(), "historical", 0


def candle_transport_for(candles: dict):
    from urllib.parse import parse_qs, urlsplit
    from datetime import datetime, timezone

    def parse(text):
        return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp() * 1000)

    def transport(url, timeout):
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        asset = "LINK" if "LINK-USD" in parts.path else "BTC"
        start, end = parse(query["start"][0]), parse(query["end"][0])
        rows = [[(c["time"] - MINUTE) / 1000, c["price"] - 1, c["price"] + 1, c["price"], c["price"], 1]
                for c in candles[asset] if start <= c["time"] - MINUTE <= end][::-1]
        return 200, {"date": "Sat, 09 Mar 2024 12:00:00 GMT"}, canonical_json(rows).encode()

    return transport


def frames_digest(scenario: dict, unpacked: dict, dataset: dict) -> dict:
    if scenario.get("skipFramesHash"):  # canonicalising ~1M history rows in pure Python takes tens of seconds
        assert unpacked["dataset"]["frames"] == dataset["frames"]
        return {}
    return {"framesSha256": summarize(unpacked["dataset"]["frames"])["sha256"]}


def run_snapshots(scenario: dict) -> dict:
    settings = normalize_settings(scenario["settings"])
    dataset, kind, first = build_dataset(scenario["dataset"], settings)
    config = {**settings["config"], "durationMs": dataset["scoreEnd"] - dataset["scoreStart"]}
    account = create_account(config)
    ingest(account, dataset["frames"][first])
    cursors = []
    for spec in scenario["cursors"]:
        cursor = len(dataset["frames"]) + spec if spec < 0 else spec
        market = evidence.packed_browser_market(kind, dataset, settings, cursor, account=account)
        record = make_run_record(account, market, name="evidence", run_id="evidence-run")
        unpacked = evidence.unpack_market(record["market"])
        packed_ds = record["market"]["dataset"]
        cursors.append({
            "cursor": cursor, "marketSha256": record["hashes"]["marketSha256"],
            "configSha256": record["hashes"]["configSha256"], "market": summarize(record["market"]),
            "exportedMarketSha256": summarize(evidence.pack_market(record["market"]))["sha256"],
            **frames_digest(scenario, unpacked, dataset),
            "lastObservedFrameSha256": summarize(unpacked["lastObservedFrame"])["sha256"],
            "frameCount": len(dataset["frames"]),
            "catalog": {a: len(packed_ds["historyCatalog"][a]) for a in ("BTC", "LINK")},
            "refKinds": sorted({"indices" if "indices" in r else "range" for f in packed_ds["frames"]
                                for r in f.get("historyRefs", {}).values()})})
    out = {"kind": kind, "scoreStart": dataset["scoreStart"], "scoreEnd": dataset["scoreEnd"],
           "capturedAt": dataset.get("capturedAt"), "cursors": cursors}
    if scenario["dataset"]["source"] == "range":
        out["dataset"] = summarize(dataset)
    return out


def run_fixture(scenario: dict) -> dict:
    record = json.loads((EVIDENCE / scenario["path"]).read_text())
    unpacked = evidence.unpack_market(record["market"])
    return {"recordMarketSha256": record["hashes"]["marketSha256"], "marketSha256": sha256_canonical(record["market"]),
            "unpacked": summarize(unpacked), "repackedSha256": sha256_canonical(evidence.pack_market(unpacked)),
            "frames": len(unpacked["dataset"]["frames"]), "cursor": record["market"]["cursor"],
            "firstHistory": unpacked["dataset"]["frames"][0]["history"],
            "lastHistory": unpacked["dataset"]["frames"][-1]["history"]}


RUNNERS = {"pack-market": run_pack, "unpack-market": run_unpack, "app-snapshot": run_snapshots, "fixture": run_fixture}


@pytest.mark.parametrize("kind", ["pack-market", "unpack-market", "app-snapshots", "fixtures"])
def test_python_matches_javascript_golden(kind):
    case, golden = load(kind)
    runner = RUNNERS[case["kind"]]
    failures = []
    for scenario in case["scenarios"]:
        actual = json.loads(json.dumps(runner(scenario)))
        expected = golden["scenarios"][scenario["name"]]
        if actual != expected:
            keys = [k for k in expected if expected[k] != actual.get(k)] or ["(keys)"]
            failures.append(f"{scenario['name']}: differs in {keys}: expected {str(expected.get(keys[0]))[:300]!r} "
                            f"got {str(actual.get(keys[0]))[:300]!r}")
    assert not failures, "\n".join(failures)


def test_python_unpack_of_pack_restores_the_original_frames_and_catalogs_are_deduplicated():
    case, _ = load("pack-market")
    checked = 0
    for scenario in case["scenarios"]:
        market = scenario["market"]
        dataset = (market or {}).get("dataset") if isinstance(market, dict) else None
        if not isinstance(dataset, dict) or not isinstance(dataset.get("frames"), list):
            continue
        try:
            packed = evidence.pack_dataset(copy.deepcopy(dataset))
        except ValueError:
            continue
        if packed is dataset or "historyEncoding" in dataset:
            continue
        restored = evidence.unpack_dataset(packed)["frames"]
        for original, back in zip(dataset["frames"], restored):
            expected = {k: v for k, v in original.items() if k != "history"}
            if not evidence._js_falsy(original.get("history")):
                expected["history"] = original["history"]
            assert canonical_json(back) == canonical_json(expected), scenario["name"]
        checked += 1
    assert checked >= 8


def test_goldens_are_not_vacuous():
    _, snapshots = load("app-snapshots")
    kinds = {k for s in snapshots["scenarios"].values() for c in s["cursors"] for k in c["refKinds"]}
    assert kinds == {"range", "indices"}
    assert len({c["marketSha256"] for s in snapshots["scenarios"].values() for c in s["cursors"]}) >= 25
    _, unpack = load("unpack-market")
    assert len({v["error"] for v in unpack["scenarios"].values() if "error" in v}) >= 3


# ----------------------------------------------------------------- the existing browser fixtures, end to end

def test_python_reproduces_the_browser_completed_fixture_market_exactly():
    """Rebuild parity/make-browser-records.mjs's completed run from the bundled sample: same marketSha256."""
    record = json.loads((PARITY / "fixtures" / "browser-run-completed.json").read_text())
    sample = evidence.load_browser_sample()
    frames = sample["frames"][:140]
    cursor = record["market"]["cursor"]
    settings = record["market"]["settings"]
    lookback = settings["config"]["lookbackIntervals"]
    dataset = {**sample, "frames": frames, "scoreStart": frames[lookback]["time"], "scoreEnd": frames[-1]["time"],
               "warmupFrameCount": lookback}
    market = evidence.packed_browser_market("sample", dataset, settings, cursor)
    assert canonical_json(market) == canonical_json(record["market"])
    assert sha256_canonical(market) == record["hashes"]["marketSha256"]
    assert evidence.unpack_market(record["market"])["dataset"]["frames"] == dataset["frames"]


@pytest.mark.parametrize("name", ["browser-run-completed", "browser-run-partial-manual", "browser-run-live-partial"])
def test_unpack_of_existing_fixtures_reproduces_frames_and_hashes(name):
    record = json.loads((PARITY / "fixtures" / f"{name}.json").read_text())
    market = record["market"]
    unpacked = evidence.unpack_market(market)
    frames = unpacked["dataset"]["frames"]
    assert all("history" in f and "historyRefs" not in f for f in frames)
    assert canonical_json(evidence.pack_market(unpacked)) == canonical_json(market)
    assert evidence.market_sha256(unpacked) == record["hashes"]["marketSha256"]
    assert unpacked["lastObservedFrame"] == frames[market["cursor"]]


def test_browser_market_snapshot_fallbacks_match_app_js():
    ds = {"frames": [{"time": 1}], "scoreStart": 1, "scoreEnd": 1}
    assert evidence.browser_market("sample", ds, {"s": 1}, 0) == {
        "kind": "sample", "dataset": ds, "cursor": 0, "lastObservedFrame": {"time": 1}, "scoreStart": 1, "scoreEnd": 1,
        "settings": {"s": 1}}
    live = evidence.browser_market("live", {"frames": []}, {}, 0, account={"startedAt": 5, "endsAt": None})
    assert live["scoreStart"] == 5 and live["scoreEnd"] is None and "lastObservedFrame" not in live
    bare = evidence.browser_market("live", None, None, 0)
    assert "scoreStart" not in bare and bare["settings"] is None
    frame = {"time": 9}
    assert evidence.browser_market("live", ds, {}, 0, last_observed_frame=frame)["lastObservedFrame"] is frame


# ----------------------------------------------------------------- Python-created records

def _load_fixture_script():
    import importlib.util
    path = Path(__file__).resolve().parents[1] / "scripts" / "make_python_run_fixtures.py"
    spec = importlib.util.spec_from_file_location("make_python_run_fixtures", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_python_run_fixtures_equal_what_the_script_builds():
    from paper_trail.records import verify_imported_record
    built = _load_fixture_script().build_records()
    assert sorted(built) == ["python-run-range-partial", "python-run-sample-completed", "python-run-sample-partial-manual"]
    for name, record in built.items():
        committed = json.loads((EVIDENCE / "fixtures" / f"{name}.json").read_text())
        for key in ("createdAt", "updatedAt"):  # the only clock-dependent fields
            committed.pop(key), record.pop(key)
        assert committed == record, name
        assert committed["hashes"]["marketSha256"] == sha256_canonical(committed["market"])
        assert committed["market"]["dataset"]["historyEncoding"] == evidence.ENCODING
        assert committed["market"]["lastObservedFrame"]["history"]
    # the service's own importer accepts them too (they are valid browser-format runs)
    for path in (EVIDENCE / "fixtures").glob("python-run-*.json"):
        verify_imported_record(json.loads(path.read_text()))


def test_python_created_market_hash_equals_browsers_for_the_same_inputs():
    """A Python-built record's market hashes like the browser's: rebuilding it from the unpacked frames agrees."""
    record = json.loads((EVIDENCE / "fixtures" / "python-run-range-partial.json").read_text())
    unpacked = evidence.unpack_market(record["market"])
    assert evidence.market_sha256(unpacked) == record["hashes"]["marketSha256"]


def test_packed_size_and_time_stay_practical():
    """A 31-day range at the default lookback (44,641 shared minutes, 8-row histories) packs in a few seconds."""
    import time
    frames = []
    prices = {"BTC": 60000.0, "LINK": 18.0}
    series = {a: [] for a in prices}
    for minute in range(44641):
        row_time = 1_709_985_600_000 + minute * MINUTE
        history = {}
        quotes = {}
        for asset in prices:
            prices[asset] = round(prices[asset] * (1 + ((minute * 7919) % 101 - 50) / 40000), 4)
            series[asset].append({"time": row_time, "price": prices[asset]})
            history[asset] = series[asset][-8:]
            quotes[asset] = {"bid": prices[asset] * 0.9998, "ask": prices[asset] * 1.0002, "mid": prices[asset],
                             "observedAt": row_time, "source": "Historical Coinbase close with ASSUMED 2 bps half-spread",
                             "simulatedQuote": True}
        frames.append({"time": row_time, "quotes": quotes, "history": history})
    dataset = {"source": "synthetic", "scoreStart": frames[0]["time"], "scoreEnd": frames[-1]["time"], "frames": frames}
    started = time.perf_counter()
    packed = evidence.pack_market({"kind": "historical", "dataset": dataset, "cursor": 0, "lastObservedFrame": frames[0]})
    pack_seconds = time.perf_counter() - started
    assert pack_seconds < 5, pack_seconds
    assert len(packed["dataset"]["historyCatalog"]["BTC"]) == 44641
    assert all(set(f["historyRefs"]["BTC"]) == {"start", "length"} for f in packed["dataset"]["frames"][:100])
    started = time.perf_counter()
    unpacked = evidence.unpack_market(packed)
    assert time.perf_counter() - started < 5
    assert unpacked["dataset"]["frames"][-1]["history"] == frames[-1]["history"]


def test_window_fast_path_gives_the_same_packing_as_the_general_path():
    """Shared row objects take the sliding-window shortcut; deep copies take the per-row path: same output."""
    frames = evidence.browser_sample_dataset(2, 7)["frames"][:160]
    shared = {"frames": frames, "scoreStart": 1}
    copied = {"frames": copy.deepcopy(frames), "scoreStart": 1}
    thinned = {"frames": thin(frames, 5), "scoreStart": 1}
    thinned_copy = {"frames": copy.deepcopy(thin(frames, 5)), "scoreStart": 1}
    for a, b in ((shared, copied), (thinned, thinned_copy)):
        assert canonical_json(evidence.pack_dataset(a)) == canonical_json(evidence.pack_dataset(b))
    assert any("indices" in r for f in evidence.pack_dataset(thinned)["frames"] for r in f["historyRefs"].values())
