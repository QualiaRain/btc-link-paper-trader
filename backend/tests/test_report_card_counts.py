"""Per-asset forecast report card counts (engine.js forecastCounts) and how imports treat summaries saved without them."""
from __future__ import annotations

import copy
import json
import math
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from paper_trail.configuration import normalize_settings
from paper_trail.engine import REPORT_CARD_COUNTS, create_account, get_summary, ingest
from paper_trail.records import make_run_record, verify_imported_record
from paper_trail.replay import run_replay

ROOT = Path(__file__).resolve().parents[2]
JS = Path(__file__).parent / "js"
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to run the existing JavaScript")
T, MINUTE = 1_700_000_000_000, 60000


def node(script: str, *args: str, stdin: str | None = None):
    out = subprocess.run(["node", str(JS / script), *args], input=stdin, capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert out.returncode == 0, out.stderr[-800:]
    return json.loads(out.stdout)


def frame(time, btc, link, history):
    q = lambda p: {"bid": p - .01, "ask": p + .01, "mid": p, "observedAt": time, "source": "fixture"}  # noqa: E731
    return {"time": time, "quotes": {"BTC": q(btc), "LINK": q(link)}, "history": {"BTC": history, "LINK": history}}


def test_summary_counts_direction_hits_misses_and_flat_outcomes():
    """report-card.test.js 'summary counts direction hits, misses and flat outcomes'."""
    history = [{"time": T - (7 - i) * MINUTE, "price": 100 * math.exp(i * .0005)} for i in range(8)]
    a = create_account({"model": "trend", "horizonMs": 7 * MINUTE, "lookbackIntervals": 7, "durationMs": 60 * MINUTE})
    ingest(a, frame(T, 100, 100, history))
    assert len(a["forecasts"]) == 2
    ingest(a, frame(T + 7 * MINUTE, 101, 100, history))  # BTC rises (hit); LINK is unchanged (flat outcome)
    per = get_summary(a)["perAsset"]
    assert [per["BTC"][k] for k in ("directionHits", "directionMisses", "directionFlat")] == [1, 0, 0]
    assert [per["LINK"][k] for k in ("directionHits", "directionMisses", "directionFlat")] == [0, 0, 1]
    assert list(per["BTC"]) == ["count", "mae", "samePriceMae", *REPORT_CARD_COUNTS, "qty"]  # engine.js key order


def _settled(anchor: float, prediction: float, actual: float, asset: str = "BTC", **errors) -> dict:
    return {"id": "f", "asset": asset, "status": "settled", "anchor": anchor, "prediction": prediction, "actual": actual,
            "absoluteError": errors.get("absoluteError", abs(prediction - actual)),
            "baselineAbsoluteError": errors.get("baselineAbsoluteError", abs(anchor - actual))}


def _boundary_forecasts() -> list[dict]:
    """Forecasts on both sides of the 1e-12 * max(1, anchor) tolerance, for directions and for ties."""
    rnd = random.Random(7)
    out = []
    for anchor in (1.0, 0.5, 1e-3, 16.25, 99999.5, 61234.56789):
        eps = 1e-12 * max(1, anchor)
        for k in (0, 0.25, 0.5, 0.999, 1, 1.001, 2, 1e6):
            for sign in (1, -1):
                out.append(_settled(anchor, anchor + sign * k * eps, anchor + rnd.choice([1, -1]) * rnd.random() * anchor * 1e-3))
                out.append(_settled(anchor, anchor + rnd.choice([1, -1]) * anchor * 1e-3, anchor + sign * k * eps))
                out.append(_settled(anchor, anchor * 1.001, anchor * 1.0005, absoluteError=1.0, baselineAbsoluteError=1.0 + sign * k * eps))
        out.append(_settled(anchor, anchor, anchor))
        out.append(_settled(anchor, anchor - eps, anchor + eps))
    for i, f in enumerate(out):
        f["asset"] = "BTC" if i % 3 else "LINK"
    return out


@needs_node
def test_counts_equal_engine_js_at_every_tolerance_boundary():
    accounts = []
    fs = _boundary_forecasts()
    for chunk in (fs, fs[::2], fs[1::3], fs[:1], []):
        a = create_account({})
        a["forecasts"] = copy.deepcopy(chunk)
        accounts.append(a)
    expected = node("summary.mjs", stdin=json.dumps(accounts))
    actual = json.loads(json.dumps([get_summary(a) for a in accounts]))
    assert actual == expected
    # The boundary set exercises every outcome.
    totals = {k: sum(s["perAsset"][a][k] for a in ("BTC", "LINK")) for s in actual[:1] for k in REPORT_CARD_COUNTS}
    assert all(totals[k] > 10 for k in REPORT_CARD_COUNTS), totals


# --------------------------------------------------------------------------- imports

def _python_record(run_id: str = "counts", config: dict | None = None) -> dict:
    account, _ = run_replay(normalize_settings({"config": config or {}}))
    return json.loads(json.dumps(make_run_record(account, {"kind": "sample"}, run_id=run_id)))


def test_new_records_carry_the_counts_and_import():
    record = _python_record()
    for per in record["summary"]["perAsset"].values():
        assert all(isinstance(per[k], int) for k in REPORT_CARD_COUNTS)
        assert per["directionHits"] + per["directionMisses"] + per["directionFlat"] == per["count"] > 0
    assert verify_imported_record(record) is record


@pytest.mark.parametrize("fixture", ["browser_completed", "browser_partial", "browser_live"])
def test_records_saved_before_the_report_card_still_import(request, fixture):
    record = request.getfixturevalue(fixture)
    assert not any(k in per for per in record["summary"]["perAsset"].values() for k in REPORT_CARD_COUNTS)
    assert verify_imported_record(record) is record


def test_a_partial_omission_never_passes():
    record = _python_record()
    for asset in ("BTC", "LINK"):
        for key in REPORT_CARD_COUNTS:
            one = copy.deepcopy(record)
            del one["summary"]["perAsset"][asset][key]  # one count missing
            with pytest.raises(ValueError, match="summary does not match"):
                verify_imported_record(one)
        whole_asset = copy.deepcopy(record)
        for key in REPORT_CARD_COUNTS:  # every count of one asset missing, the other asset's present
            del whole_asset["summary"]["perAsset"][asset][key]
        with pytest.raises(ValueError, match="summary does not match"):
            verify_imported_record(whole_asset)


def test_wrong_or_null_counts_never_pass():
    record = _python_record()
    for value in (None, 0, record["summary"]["perAsset"]["BTC"]["directionHits"] + 1):
        for key in REPORT_CARD_COUNTS:
            if record["summary"]["perAsset"]["LINK"][key] == value:
                continue
            altered = copy.deepcopy(record)
            altered["summary"]["perAsset"]["LINK"][key] = value
            with pytest.raises(ValueError, match="summary does not match"):
                verify_imported_record(altered)


def test_omitting_every_count_still_checks_everything_else():
    record = _python_record()
    legacy = copy.deepcopy(record)
    for per in legacy["summary"]["perAsset"].values():
        for key in REPORT_CARD_COUNTS:
            del per[key]
    assert verify_imported_record(legacy) is legacy  # looks like a summary saved before the report card
    for path, value in ((("perAsset", "BTC", "count"), 1), (("perAsset", "LINK", "mae"), 123.0), (("settledForecasts",), 3)):
        altered = copy.deepcopy(legacy)
        target = altered["summary"]
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        with pytest.raises(ValueError, match="summary does not match"):
            verify_imported_record(altered)
    # The account must still agree with the rest of the summary: a damaged forecast error is caught.
    edited = copy.deepcopy(legacy)
    settled = next(f for f in edited["account"]["forecasts"] if f["status"] == "settled")
    settled["absoluteError"] += 1
    with pytest.raises(ValueError, match="summary does not match"):
        verify_imported_record(edited)


def test_risk_era_records_without_counts_import_but_new_state_is_still_checked():
    """A record from between the risk-limit and report-card releases: risk config and summary fields, no counts."""
    record = _python_record("risk-era", {"maxDrawdownBps": 40, "dailyLossBps": 25, "cashYieldBps": 2000,
                                         "bufferBps": 0, "horizonMs": 300000})
    for per in record["summary"]["perAsset"].values():
        for key in REPORT_CARD_COUNTS:
            del per[key]
    assert verify_imported_record(record) is record
    del record["summary"]["interestEarned"]  # risk-era records must still carry the risk/yield summary fields
    with pytest.raises(ValueError, match="summary does not match"):
        verify_imported_record(record)


@needs_node
@pytest.mark.parametrize("steps", ["30", ""])
def test_current_browser_exports_carry_the_counts_and_import(client, steps):
    record = node("browser_record.mjs", *([steps] if steps else []))
    per = record["summary"]["perAsset"]
    assert all(k in per[a] for a in ("BTC", "LINK") for k in REPORT_CARD_COUNTS)
    assert verify_imported_record(copy.deepcopy(record)) == record
    assert get_summary(record["account"])["perAsset"] == per
    response = client.post("/v1/runs/import", json=record)
    assert response.status_code == 200, response.text
    assert client.get(f"/v1/runs/{record['id']}/export").json() == record
