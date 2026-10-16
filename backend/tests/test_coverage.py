"""Coverage is part of the answer: the sample's coverage block, the summary's gap and invalid-frame counts, and
how run listings, sessions and imports carry them (mirrors coverage.test.js at the repository root)."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from paper_trail import evidence
from paper_trail.canonical import canonical_json
from paper_trail.configuration import normalize_settings
from paper_trail.engine import COVERAGE_COUNTS, create_account, get_summary, ingest
from paper_trail.records import coverage_summary, make_run_record, run_metadata, verify_imported_record
from paper_trail.replay import run_replay, sample_dataset

ROOT = Path(__file__).resolve().parents[2]
MINUTE = 60000
T = 1_704_067_200_000  # 2024-01-01T00:00:00Z


def frame(time: int) -> dict:
    q = {"bid": 99.98, "ask": 100.02, "mid": 100, "observedAt": time, "source": "fixture"}
    history = [{"time": time - MINUTE, "price": 100}, {"time": time, "price": 100}]
    return {"time": time, "quotes": {"BTC": dict(q), "LINK": dict(q)}, "history": {"BTC": history, "LINK": history}}


def test_sample_coverage_states_what_data_readme_claims():
    """1,648 shared observations in a 1,800-minute window, 152 missing; the same shape as a date range's coverage."""
    sample = evidence.load_browser_sample()
    coverage = evidence.sample_coverage(sample, 7)
    for asset in ("BTC", "LINK"):
        c = coverage[asset]
        assert (c["expectedCount"], c["observedCount"], c["missingCount"]) == (1800, 1648, 152)
        assert len(c["missingTimes"]) == 152 and c["missingFraction"] == 152 / 1800
        assert c["startPresent"] and c["endPresent"] and c["warmupObservedCount"] == 7 and c["duplicateRows"] == 0
        times = {f["time"] for f in sample["frames"]}
        assert all(sample["periodStart"] <= t <= sample["periodEnd"] and t % MINUTE == 0 and t not in times
                   for t in c["missingTimes"])
    assert coverage["BTC"] == coverage["LINK"] and coverage["BTC"]["missingTimes"] is not coverage["LINK"]["missingTimes"]
    assert sorted(coverage["BTC"]) == ["duplicateRows", "endPresent", "expectedCount", "missingCount", "missingFraction",
                                       "missingTimes", "observedCount", "startPresent", "warmupObservedCount"]
    with pytest.raises(ValueError, match="warmup"):
        evidence.sample_coverage(sample, -1)
    with pytest.raises(ValueError, match="minute-close"):
        evidence.sample_coverage({**sample, "periodStart": sample["periodStart"] + 1})
    # Both dataset builders carry it, and the browser-format one is what the JS goldens hash (app-snapshots).
    assert evidence.browser_sample_dataset(2, 7)["coverage"] == coverage
    assert sample_dataset(2, 7)["coverage"] == coverage
    assert sample_dataset(2, 30)["coverage"]["BTC"]["warmupObservedCount"] == 30


def test_sample_coverage_matches_the_javascript_byte_for_byte():
    """The committed golden was produced by market.js sampleCoverage via the evidence harness; the canonical text of
    the Python block must be identical, since it is part of the hashed market evidence."""
    golden = json.loads((ROOT / "parity" / "evidence" / "expected" / "app-snapshots.json").read_text())
    full = golden["scenarios"]["sample-full"]["cursors"][0]["marketSha256"]
    settings = normalize_settings({"config": {"lookbackIntervals": 7, "horizonMs": 300000, "bufferBps": 0, "feeBps": 1,
                                              "slippageBps": 0, "initialCash": 1000}, "replay": {"source": "sample", "halfSpreadBps": 2}})
    dataset = evidence.browser_sample_dataset(2, 7)
    assert evidence.market_sha256(evidence.browser_market("sample", dataset, settings, 7)) == full
    text = canonical_json(dataset["coverage"]["BTC"])
    assert text.startswith('{"duplicateRows":0,"endPresent":true,"expectedCount":1800,"missingCount":152,"missingFraction":0.08444444444444445,"missingTimes":[')


def test_sample_coverage_rejects_invalid_observation_times():
    for times in ([0, MINUTE // 2, MINUTE], [0, 0, MINUTE], [0, MINUTE, 2 * MINUTE], [0, 0, 2 * MINUTE]):
        with pytest.raises(ValueError, match="Sample observations"):
            evidence.sample_coverage({"periodStart": 0, "periodEnd": MINUTE, "frames": [{"time": t} for t in times]})
    sparse = evidence.sample_coverage({"periodStart": 0, "periodEnd": 2 * MINUTE, "frames": [{"time": 0}, {"time": 2 * MINUTE}]})
    assert sparse["BTC"]["missingTimes"] == [MINUTE]
    assert sparse["BTC"]["observedCount"] + sparse["BTC"]["missingCount"] == sparse["BTC"]["expectedCount"]


def test_summary_counts_gaps_and_invalid_frames():
    live = create_account({"mode": "live", "model": "same-price"})
    ingest(live, frame(T))
    ingest(live, frame(T + 3600000))  # an hour without quotes: a gap event, no intervening fills
    ingest(live, {"time": T + 3600000 + 1000, "quotes": {"BTC": {"bid": 1, "ask": 1, "mid": 1, "observedAt": T}, "LINK": {}}})
    ingest(live, {"time": T + 3600000 + 2000, "quotes": {}})
    summary = get_summary(live)
    assert (summary["gapEvents"], summary["invalidFrames"]) == (1, 2)
    assert sum(1 for e in live["ledger"] if e["type"] == "gap") == 1
    assert sum(1 for e in live["ledger"] if e["type"] == "invalid_frame") == 2
    replay = create_account({"model": "same-price"})
    ingest(replay, frame(T))
    ingest(replay, frame(T + 3600000))  # replays never record gap events
    assert (get_summary(replay)["gapEvents"], get_summary(replay)["invalidFrames"]) == (0, 0)
    assert list(summary)[list(summary).index("tradingHalted") + 1:list(summary).index("valuationAt")] == list(COVERAGE_COUNTS)


def test_run_listings_carry_coverage_counts_receipts_and_kind():
    settings = normalize_settings({"config": {"horizonMs": 300000}})
    account, dataset = run_replay(settings)
    market = evidence.packed_browser_market("sample", evidence.browser_sample_dataset(settings["replay"]["halfSpreadBps"], 7),
                                            settings, len(dataset["frames"]) - 1)
    meta = run_metadata(make_run_record(account, market, run_id="sample"))
    expected = {"expectedCount": 1800, "observedCount": 1648, "missingCount": 152, "warmupObservedCount": 7}
    assert meta["coverage"] == {"BTC": expected, "LINK": expected}
    assert meta["receiptCount"] == 0 and meta["kind"] == "sample"
    assert (meta["summary"]["gapEvents"], meta["summary"]["invalidFrames"]) == (0, 0)
    ranged = make_run_record(account, {"kind": "historical", "dataset": {
        "scoreStart": 1, "scoreEnd": 2, "provenance": [{"url": "a"}, {"url": "b"}, {"url": "c"}],
        "coverage": {"BTC": {"expectedCount": 3, "observedCount": 2, "missingCount": 1, "warmupObservedCount": 8, "missingTimes": [5]},
                     "LINK": {"expectedCount": 3, "observedCount": 3, "missingCount": 0, "warmupObservedCount": 9, "missingTimes": []}}}},
        run_id="range")
    listed = run_metadata(ranged)
    assert listed["receiptCount"] == 3 and listed["kind"] == "historical"
    assert listed["coverage"]["LINK"] == {"expectedCount": 3, "observedCount": 3, "missingCount": 0, "warmupObservedCount": 9}
    bare = run_metadata(make_run_record(account, {"kind": "live", "dataset": {"frames": []}}, run_id="live"))
    assert bare["coverage"] is None and bare["receiptCount"] == 0 and bare["kind"] == "live"
    assert coverage_summary({"BTC": {"expectedCount": 1}}) is None and coverage_summary(None) is None
    assert coverage_summary({"BTC": {"expectedCount": True, "observedCount": 1, "missingCount": 0, "warmupObservedCount": 0},
                             "LINK": {"expectedCount": 1, "observedCount": 1, "missingCount": 0, "warmupObservedCount": 0}}) is None


def test_sessions_expose_coverage_and_receipts(client):
    created = client.post("/v1/sessions", json={"settings": {"config": {"horizonMs": 300000}}}).json()
    assert created["coverage"]["BTC"] == {"expectedCount": 1800, "observedCount": 1648, "missingCount": 152, "warmupObservedCount": 7}
    assert created["receiptCount"] == 0
    assert created["summary"]["gapEvents"] == 0 and created["summary"]["invalidFrames"] == 0
    start = 1_709_985_600_000  # 2024-03-09T12:00Z
    candles = {a: [{"time": start + k * MINUTE, "price": 100.0 + k} for k in range(-60, 61) if k != 30 or a == "BTC"]
               for a in ("BTC", "LINK")}
    ranged = client.post("/v1/sessions", json={"settings": {"config": {"horizonMs": 300000}, "replay": {
        "source": "range", "start": "2024-03-09T12:00", "end": "2024-03-09T13:00"}}, "candles": candles}).json()
    assert ranged["coverage"] == {"BTC": {"expectedCount": 61, "observedCount": 61, "missingCount": 0, "warmupObservedCount": 60},
                                  "LINK": {"expectedCount": 61, "observedCount": 60, "missingCount": 1, "warmupObservedCount": 60}}
    assert ranged["receiptCount"] == 0, "caller-supplied candles carry no retrieval receipts"
    assert client.get("/v1/runs").json()["runs"] == []
    # A causal mid-session snapshot reports coverage only through the revealed frame (here the first one)...
    saved = client.post(f"/v1/sessions/{ranged['id']}/save", json={"expectedVersion": ranged["version"]}).json()
    assert saved["run"]["coverage"]["LINK"] == {"expectedCount": 1, "observedCount": 1, "missingCount": 0, "warmupObservedCount": 60}
    assert saved["run"]["receiptCount"] == 0 and saved["run"]["kind"] == "historical"
    # ...and a finished session saves the whole range's coverage, which the listing then carries.
    done = client.post(f"/v1/sessions/{ranged['id']}/advance", json={"mode": "finish", "expectedVersion": saved["state"]["version"]}).json()
    client.post(f"/v1/sessions/{ranged['id']}/save", json={"expectedVersion": done["state"]["version"]})
    run = client.get("/v1/runs").json()["runs"][0]
    assert run["coverage"] == ranged["coverage"] and run["receiptCount"] == 0 and run["kind"] == "historical"
    assert run["summary"]["gapEvents"] == 0 and run["summary"]["invalidFrames"] == 0


def test_imports_accept_summaries_saved_before_the_counts_but_never_a_wrong_count(browser_live, browser_completed):
    """The browser's own legacy live export holds one gap event and no count: it imports, and listings show the
    count as not recorded rather than zero. A stated count must equal the ledger's; a partial omission fails."""
    assert sum(1 for e in browser_live["account"]["ledger"] if e["type"] == "gap") == 1
    assert not any(k in browser_live["summary"] for k in COVERAGE_COUNTS)
    assert verify_imported_record(browser_live) is browser_live
    assert run_metadata(browser_live)["summary"].get("gapEvents") is None
    for key, wrong in (("gapEvents", 0), ("gapEvents", 2), ("invalidFrames", 1)):
        altered = copy.deepcopy(browser_live)
        altered["summary"]["gapEvents"] = 1
        altered["summary"]["invalidFrames"] = 0
        altered["summary"][key] = wrong
        with pytest.raises(ValueError, match="summary does not match"):
            verify_imported_record(altered)
    stated = copy.deepcopy(browser_live)
    stated["summary"].update({"gapEvents": 1, "invalidFrames": 0})
    assert verify_imported_record(stated) is stated
    partial = copy.deepcopy(browser_completed)
    partial["summary"]["invalidFrames"] = 0  # one count without the other is compared as is and fails
    with pytest.raises(ValueError, match="summary does not match"):
        verify_imported_record(partial)


def test_a_new_record_cannot_drop_its_counts_silently_when_the_ledger_has_events(client, browser_live):
    """Through the API: the stated counts are checked against the ledger."""
    forged = copy.deepcopy(browser_live)
    forged["summary"].update({"gapEvents": 0, "invalidFrames": 0})
    response = client.post("/v1/runs/import", json=forged)
    assert response.status_code == 422 and "summary does not match" in response.json()["error"]["message"]
    assert client.post("/v1/runs/import", json=browser_live).status_code == 200
    listed = client.get("/v1/runs").json()["runs"][0]
    assert listed["summary"]["gapEvents"] is None and listed["coverage"] is None and listed["kind"] == "live"
