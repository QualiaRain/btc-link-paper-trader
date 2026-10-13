"""Settlement skips finished forecasts and stops at the first future target (engine.js PR #7), without changing results.

The index of the first possibly pending forecast is kept on the account object, never as a JSON item, so accounts,
records and API responses are unchanged, and a restored (plain dict) account settles exactly like the original.
"""
from __future__ import annotations

import copy
import json
import math
import random

import pytest

from paper_trail import engine
from paper_trail.engine import create_account, get_summary, ingest, iso, manual_trade
from paper_trail.records import make_run_record

T = 1_700_000_000_000
MINUTE = 60000


def quote(price: float, observed_at: float) -> dict:
    return {"bid": price - .01, "ask": price + .01, "mid": price, "observedAt": observed_at, "source": "fixture"}


def hist(time: float) -> list[dict]:
    return [{"time": time - (7 - i) * MINUTE, "price": 100 * math.exp(i * .0005)} for i in range(8)]


def frame(time: float, link_observed_at: float | None = None) -> dict:
    """LINK's quote can lag behind the frame time; BTC's is always fresh (settle.test.js)."""
    seen = time if link_observed_at is None else link_observed_at
    return {"time": time, "quotes": {"BTC": quote(100, time), "LINK": quote(100, seen)},
            "history": {"BTC": hist(time), "LINK": hist(min(time, seen))}}


def account() -> dict:
    return create_account({"horizonMs": MINUTE, "lookbackIntervals": 7, "durationMs": 60 * MINUTE,
                           "maxQuoteAgeMs": 10 * MINUTE, "maxOutcomeLatenessMs": 10 * MINUTE})


def test_a_forecast_held_pending_by_a_stale_quote_settles_later_after_newer_forecasts_settled_past_it():
    a = account()
    ingest(a, frame(T))
    btc0, link0 = a["forecasts"]
    assert link0["asset"] == "LINK"
    for m in (1, 2, 3):  # LINK's quote stays at T, so its first target (T+1m) has no qualifying observation
        ingest(a, frame(T + m * MINUTE, T))
    assert btc0["status"] == "settled" and link0["status"] == "pending"
    assert any(f["asset"] == "BTC" and f["issuedAt"] > T and f["status"] == "settled" for f in a["forecasts"])
    ingest(a, frame(T + 4 * MINUTE))
    assert link0["status"] == "settled" and link0["latenessMs"] == 3 * MINUTE
    order = [e["forecastId"] for e in a["ledger"] if e["type"] == "forecast_settled"]
    assert len(set(order)) == len(order), "each forecast settles once"


def test_restoring_an_account_from_saved_json_keeps_settling_correctly():
    a = account()
    ingest(a, frame(T))
    ingest(a, frame(T + MINUTE, T))
    restored = json.loads(json.dumps(a))
    assert type(restored) is dict  # a plain dict: no settle index, so it scans from the first forecast
    for acct in (a, restored):
        ingest(acct, frame(T + 2 * MINUTE, T))
        ingest(acct, frame(T + 3 * MINUTE))
    assert restored == json.loads(json.dumps(a))
    assert next(f for f in restored["forecasts"] if f["asset"] == "LINK" and f["issuedAt"] == T)["status"] == "settled"


def test_the_settle_index_is_never_part_of_the_account_json_or_records():
    a = account()
    for m in range(6):
        ingest(a, frame(T + m * MINUTE, T if m in (1, 2) else None))
    assert getattr(a, "_settle_from", None) is not None  # the index exists ...
    keys = {"config", "cash", "positions", "ledger", "forecasts", "equity", "startedAt", "endsAt", "lastDecisionAt",
            "lastFrameAt", "lastValidFrameAt", "status", "baseline", "sequence"}
    assert set(a) == keys  # ... but is not an item
    text = json.dumps(a)
    assert "_settle_from" not in text and json.loads(text) == dict(a)
    record = make_run_record(a, {"kind": "sample"}, run_id="settle-index")
    assert set(record["account"]) == keys and "_settle_from" not in json.dumps(record)


def test_copies_and_replaced_forecast_lists_never_reuse_a_stale_index():
    a = account()
    for m in range(5):
        ingest(a, frame(T + m * MINUTE))
    copied = copy.deepcopy(a)  # sessions work on deep copies: the index travels with its own forecasts list
    assert copied._settle_from[0] is copied["forecasts"] and copied._settle_from[1] == a._settle_from[1]
    replaced = copy.deepcopy(a)
    replaced["forecasts"] = [dict(f, status="pending") if f["asset"] == "LINK" else f for f in replaced["forecasts"]]
    ingest(replaced, frame(T + 5 * MINUTE))
    # A new list is scanned from the start, so the re-opened LINK forecasts are settled again here.
    relisted = [e["forecastId"] for e in replaced["ledger"][len(a["ledger"]):] if e["type"] == "forecast_settled"]
    assert {f["id"] for f in replaced["forecasts"] if f["asset"] == "LINK" and f["targetAt"] <= T + 5 * MINUTE} <= set(relisted)


# --------------------------------------------------------------------------- equivalence with the old full scan

def _settle_full_scan(a: dict, frame: dict) -> None:
    """engine.py's settle before the optimization: every forecast, every frame (kept verbatim as the reference)."""
    for f in a["forecasts"]:
        q = frame["quotes"][f["asset"]]
        if f["status"] != "pending" or frame["time"] <= f["issuedAt"] or frame["time"] < f["targetAt"] \
                or q["observedAt"] < f["targetAt"]:
            continue
        lateness = q["observedAt"] - f["targetAt"]
        if lateness > a["config"]["maxOutcomeLatenessMs"]:
            f["status"] = "expired"
            f["observedAt"] = q["observedAt"]
            f["observationAt"] = iso(q["observedAt"])
            f["processedAt"] = frame["time"]
            f["latenessMs"] = lateness
            f["reason"] = "First eligible observation exceeded the preconfigured outcome lateness tolerance"
            engine._event(a, "forecast_expired", frame["time"], actor="system", forecastId=f["id"], asset=f["asset"],
                          targetAt=f["targetAt"], observedAt=f["observedAt"], latenessMs=lateness,
                          maxOutcomeLatenessMs=a["config"]["maxOutcomeLatenessMs"], reason=f["reason"])
            continue
        f["status"] = "settled"
        f["observedAt"] = q["observedAt"]
        f["observationAt"] = iso(q["observedAt"])
        f["processedAt"] = frame["time"]
        f["actual"] = q["mid"]
        f["latenessMs"] = q["observedAt"] - f["targetAt"]
        f["absoluteError"] = abs(f["prediction"] - f["actual"])
        f["baselineAbsoluteError"] = abs(f["anchor"] - f["actual"])
        engine._event(a, "forecast_settled", frame["time"], actor="system", forecastId=f["id"], asset=f["asset"],
                      targetAt=f["targetAt"], observedAt=f["observedAt"], latenessMs=f["latenessMs"])


def _stale_run(seed: int, n: int) -> list[dict]:
    """1-minute frames; each asset's quote goes stale for 1-9 minutes at random, some frames are invalid,
    some arrive late (irregular spacing), and a few frames repeat or go back in time."""
    rnd = random.Random(seed)
    prices = {"BTC": [60000.0], "LINK": [15.0]}
    for _ in range(n):
        for s in prices:
            prices[s].append(prices[s][-1] * math.exp(.004 * (rnd.random() - .5)))
    times = []
    t = T
    for _ in range(n):
        t += MINUTE + (rnd.choice([0, 0, 0, 15000, 45000]))
        times.append(t)
    shown = {}
    for s in prices:
        rows, stale_until, start = [], -1, 0
        for i in range(n):
            if i > stale_until and i > 8 and rnd.random() < (.12 if s == "LINK" else .05):
                start, stale_until = i, i + 1 + rnd.randrange(9)
            rows.append(start if start < i <= stale_until else i)
        shown[s] = rows
    frames = []
    for i in range(n):
        quotes, history = {}, {}
        for s in prices:
            j = shown[s][i]
            quotes[s] = {"bid": prices[s][j] * .9998, "ask": prices[s][j] * 1.0002, "mid": prices[s][j],
                         "observedAt": times[j], "source": "fixture"}
            history[s] = [{"time": times[k], "price": prices[s][k]} for k in range(max(0, j - 9), j + 1)]
        frames.append({"time": times[i], "quotes": None if rnd.random() < .02 else quotes, "history": history})
        if rnd.random() < .02 and i > 2:
            frames.append(copy.deepcopy(frames[-3]))  # an out-of-order repeat, ignored by ingest
    return frames


CONFIGS = [
    {"horizonMs": MINUTE, "lookbackIntervals": 3, "maxQuoteAgeMs": 10 * MINUTE, "maxOutcomeLatenessMs": 10 * MINUTE, "bufferBps": 0},
    {"horizonMs": MINUTE, "lookbackIntervals": 5, "maxQuoteAgeMs": 10 * MINUTE, "maxOutcomeLatenessMs": 90000},
    {"horizonMs": 3 * MINUTE, "lookbackIntervals": 7, "maxQuoteAgeMs": 10 * MINUTE, "maxOutcomeLatenessMs": 120000,
     "stopLossBps": 50, "maxDrawdownBps": 200, "dailyLossBps": 100, "cashYieldBps": 2000, "bufferBps": 0},
    {"horizonMs": 2 * MINUTE, "lookbackIntervals": 2, "maxQuoteAgeMs": 10 * MINUTE, "maxOutcomeLatenessMs": 0, "mode": "live"},
]


@pytest.mark.parametrize("index", range(len(CONFIGS)))
def test_long_stale_quote_runs_produce_the_same_accounts_as_the_full_scan(monkeypatch, index):
    n = 1500
    frames = _stale_run(100 + index, n)
    config = {**CONFIGS[index], "durationMs": n * MINUTE}  # frames run late, so some arrive after completion

    def play(restore_every: int | None) -> dict:
        a = create_account(config)
        for i, f in enumerate(frames):
            ingest(a, f)
            if i % 97 == 50:  # interleave manual orders, which ingest newer frames first
                try:
                    manual_trade(a, "BTC", "buy" if i % 2 else "sell", 25, f)
                except ValueError:
                    pass
            if restore_every and i % restore_every == 0:
                a = json.loads(json.dumps(a))  # saved and restored: no settle index
        return a

    fast = play(None)
    restored = play(173)
    monkeypatch.setattr(engine, "_settle", _settle_full_scan)
    reference = play(None)
    held = [f for f in reference["forecasts"]
            if any(g["issuedAt"] > f["issuedAt"] and (g.get("processedAt") or math.inf) < (f.get("processedAt") or math.inf)
                   for g in reference["forecasts"][int(f["id"][1:]):int(f["id"][1:]) + 40])]
    assert len(reference["forecasts"]) > 300 and len(held) > 20, "the run must hold forecasts behind settled ones"
    assert json.dumps(fast) == json.dumps(reference)
    assert json.dumps(restored) == json.dumps(reference)
    assert get_summary(fast) == get_summary(reference)
