"""Deterministic paper ledger, ported from engine.js.

The account is a plain dict with the same camelCase keys as the JavaScript
account so that saved browser runs and Python runs share one JSON shape. All
prices and clocks are supplied by the caller; nothing here touches the network.
"""
from __future__ import annotations

import math
import sys
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

ASSETS = ("BTC", "LINK")
MAX_FLOAT = sys.float_info.max  # Number.MAX_VALUE

DEFAULTS: dict[str, Any] = {
    "initialCash": 1000, "horizonMs": 420000, "feeBps": 2, "slippageBps": 2,
    "bufferBps": 10, "model": "trend", "mode": "replay", "durationMs": 48 * 3600000,
    "maxQuoteAgeMs": 60000, "maxOutcomeLatenessMs": 30000, "lookbackIntervals": 7,
    "allocationFraction": 0.5, "stopLossBps": 0,
    "maxDrawdownBps": 0, "dailyLossBps": 0, "cashYieldBps": 0,
}
DAY = 86400000
YEAR = 365 * DAY


def iso(t: float) -> str:
    """`new Date(t).toISOString()` for a millisecond epoch."""
    whole = int(t // 1000)
    millis = int(t - whole * 1000)
    stamp = datetime.fromtimestamp(whole, tz=timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S") + f".{millis:03d}Z"


def finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)



def create_account(config: Any = None) -> dict[str, Any]:
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("Invalid configuration")
    for key in config:
        if key not in DEFAULTS:
            raise ValueError(f"Unknown configuration field: {key}")
    c = {**DEFAULTS, **config}
    for key in ("initialCash", "horizonMs", "durationMs", "maxQuoteAgeMs"):
        if not finite(c[key]) or c[key] <= 0:
            raise ValueError(f"Invalid {key}")
    if not finite(c["maxOutcomeLatenessMs"]) or c["maxOutcomeLatenessMs"] < 0:
        raise ValueError("Invalid maxOutcomeLatenessMs")
    for key in ("feeBps", "slippageBps", "bufferBps"):
        if not finite(c[key]) or c[key] < 0 or c[key] >= 10000:
            raise ValueError(f"Invalid {key}")
    if c["model"] not in ("trend", "same-price") or c["mode"] not in ("live", "replay"):
        raise ValueError("Invalid model or mode")
    maxima = {"initialCash": 1e9, "horizonMs": 31 * 86400000, "durationMs": 366 * 86400000,
              "maxQuoteAgeMs": 86400000, "maxOutcomeLatenessMs": 86400000,
              "feeBps": 1000, "slippageBps": 1000, "bufferBps": 1000}
    for key, maximum in maxima.items():
        if c[key] > maximum:
            raise ValueError(f"{key} exceeds supported maximum")
    lookback = c["lookbackIntervals"]
    if not finite(lookback) or float(lookback) != math.floor(lookback) or lookback < 1 or lookback > 240:
        raise ValueError("lookbackIntervals must be an integer from 1 to 240")
    c["lookbackIntervals"] = int(lookback)
    if not finite(c["allocationFraction"]) or c["allocationFraction"] < 0 or c["allocationFraction"] > 0.5:
        raise ValueError("allocationFraction must be between 0 and 0.5")
    for key in ("stopLossBps", "maxDrawdownBps", "dailyLossBps"):
        if not finite(c[key]) or c[key] < 0 or c[key] > 9999:
            raise ValueError(f"{key} must be between 0 and 9999")
    if not finite(c["cashYieldBps"]) or c["cashYieldBps"] < 0 or c["cashYieldBps"] > 2000:
        raise ValueError("cashYieldBps must be between 0 and 2000")
    return {
        "config": c, "cash": c["initialCash"],
        "positions": {"BTC": {"qty": 0, "costBasis": 0}, "LINK": {"qty": 0, "costBasis": 0}},
        "ledger": [], "forecasts": [], "equity": [],
        "startedAt": None, "endsAt": None, "lastDecisionAt": None, "lastFrameAt": None,
        "lastValidFrameAt": None, "status": "ready",
        "baseline": {"cash": c["initialCash"],
                     "positions": {"BTC": {"qty": 0, "costBasis": 0}, "LINK": {"qty": 0, "costBasis": 0}}},
        "sequence": 0,
    }


def _event(a: dict, kind: str, time: float, **details: Any) -> None:
    a["sequence"] += 1
    a["ledger"].append({"id": a["sequence"], "type": kind, "time": time, "at": iso(time), **details})


def _quote_ok(a: dict, q: Any, time: float) -> bool:
    if not isinstance(q, dict):
        return False
    if not all(finite(q.get(k)) for k in ("bid", "ask", "mid", "observedAt")):
        return False
    return (q["bid"] > 0 and q["ask"] >= q["bid"] and q["mid"] >= q["bid"] and q["mid"] <= q["ask"]
            and q["observedAt"] <= time and time - q["observedAt"] <= a["config"]["maxQuoteAgeMs"])


def _valid_frame(a: dict, f: Any) -> bool:
    if not isinstance(f, dict) or not finite(f.get("time")):
        return False
    quotes = f.get("quotes")
    quotes = quotes if isinstance(quotes, dict) else {}
    return all(_quote_ok(a, quotes.get(s), f["time"]) for s in ASSETS)


def _prices(a: dict, q: dict) -> dict[str, float]:
    s = a["config"]["slippageBps"] / 10000
    f = a["config"]["feeBps"] / 10000
    return {"buy": q["ask"] * (1 + s), "sell": q["bid"] * (1 - s), "fee": f}


def _fill(a: dict, book: dict, asset: str, side: str, dollars: float, frame: dict, actor: str) -> None:
    q = frame["quotes"][asset]
    p = _prices(a, q)
    position = book["positions"][asset]
    if side == "buy":
        total = min(dollars, book["cash"])
        if not total > 1e-10:
            return
        notional = total / (1 + p["fee"])
        qty = notional / p["buy"]
        fee = total - notional
        book["cash"] -= total
        position["qty"] += qty
        position["costBasis"] = (position.get("costBasis") or 0) + total
    else:
        # `dollars` is the desired net proceeds, capped by the existing position.
        qty = min(position["qty"], dollars / (p["sell"] * (1 - p["fee"])))
        if not qty > 1e-14:
            return
        notional = qty * p["sell"]
        fee = notional * p["fee"]
        total = notional - fee
        remaining = 1 - qty / position["qty"]
        position["costBasis"] = (position.get("costBasis") or 0) * remaining
        position["qty"] -= qty
        book["cash"] += total
    book["cash"] = max(0, book["cash"])
    if position["qty"] < 1e-14:
        position["qty"] = 0
        position["costBasis"] = 0
    _event(a, "trade", frame["time"], actor=actor, asset=asset, side=side, qty=qty,
           price=p["buy"] if side == "buy" else p["sell"], fee=fee, notional=notional,
           cashDelta=-total if side == "buy" else total, quoteObservedAt=q["observedAt"],
           quoteAt=iso(q["observedAt"]), source=q.get("source") if q.get("source") is not None else "unspecified")


def _liquidation(a: dict, book: dict, frame: dict) -> float:
    # Same summation order as engine.js: assets are summed from zero, then added to cash.
    assets = 0
    for s in ASSETS:
        p = _prices(a, frame["quotes"][s])
        assets = assets + book["positions"][s]["qty"] * p["sell"] * (1 - p["fee"])
    return book["cash"] + assets


def _start(a: dict, frame: dict) -> None:
    if a["startedAt"] is not None:
        return
    a["startedAt"] = frame["time"]
    a["endsAt"] = frame["time"] + a["config"]["durationMs"]
    a["status"] = "running"
    _event(a, "start", frame["time"], actor="system", mode=a["config"]["mode"], config=dict(a["config"]))
    budget = a["config"]["initialCash"] / 2
    for s in ASSETS:
        _fill(a, a["baseline"], s, "buy", budget, frame, "benchmark")


def _setting(a: dict, key: str) -> float:
    """`a.config[key] || 0`: accounts saved before a setting existed run without it."""
    return a["config"].get(key) or 0


# Idle cash earns the configured annual yield, compounded continuously over the
# elapsed time since the previous valid frame, including unobserved gaps.
def _growth(a: dict, ms: float) -> float:
    return math.exp(_setting(a, "cashYieldBps") / 10000 * ms / YEAR)


def _accrue(a: dict, frame: dict) -> None:
    if not _setting(a, "cashYieldBps") or a["lastValidFrameAt"] is None \
            or not frame["time"] > a["lastValidFrameAt"] or not a["cash"] > 0:
        return
    earned = a["cash"] * (_growth(a, frame["time"] - a["lastValidFrameAt"]) - 1)
    a["cash"] += earned
    a["interest"] = (a.get("interest") if a.get("interest") is not None else 0) + earned


def _mark(a: dict, frame: dict) -> None:
    point = {"time": frame["time"], "at": iso(frame["time"]), "value": _liquidation(a, a, frame),
             "buyHoldValue": _liquidation(a, a["baseline"], frame),
             "cashValue": a["config"]["initialCash"] * _growth(a, frame["time"] - a["startedAt"])}
    if a["equity"] and a["equity"][-1]["time"] == frame["time"]:
        a["equity"][-1] = point
    else:
        a["equity"].append(point)


def _prediction(a: dict, asset: str, frame: dict) -> dict | None:
    anchor = frame["quotes"][asset]["mid"]
    if a["config"]["model"] == "same-price":
        return {"anchor": anchor, "prediction": anchor, "historyEnd": None}
    # Each history timestamp is a completed minute's availability time. Conflicting
    # duplicate timestamps are rejected; sparse observations use real elapsed time.
    seen: dict[float, float] = {}
    history = frame.get("history")
    rows_in = (history.get(asset) if isinstance(history, dict) else None) or []
    for row in rows_in:
        if not isinstance(row, dict):
            continue
        t, price = row.get("time"), row.get("price")
        if not finite(t) or t > frame["time"] or not finite(price) or price <= 0:
            continue
        if t in seen and seen[t] != price:
            return None
        seen[t] = price
    rows = sorted(seen.items(), key=lambda item: item[0])
    lookback = a["config"]["lookbackIntervals"]
    if len(rows) < lookback + 1:
        return None
    last, past = rows[-1], rows[-(lookback + 1)]
    elapsed = last[0] - past[0]
    if not elapsed > 0 or frame["time"] - last[0] > max(120000, a["config"]["maxQuoteAgeMs"]):
        return None
    drift = max(-0.03, min(0.03, math.log(last[1] / past[1]) * a["config"]["horizonMs"] / elapsed))
    return {"anchor": anchor, "prediction": anchor * math.exp(drift), "historyEnd": last[0]}


def _settle(a: dict, frame: dict) -> None:
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
            _event(a, "forecast_expired", frame["time"], actor="system", forecastId=f["id"], asset=f["asset"],
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
        _event(a, "forecast_settled", frame["time"], actor="system", forecastId=f["id"], asset=f["asset"],
               targetAt=f["targetAt"], observedAt=f["observedAt"], latenessMs=f["latenessMs"])


def _close(a: dict, frame: dict, actor: str) -> None:
    for s in ASSETS:
        _fill(a, a, s, "sell", MAX_FLOAT, frame, actor)


def _stop_positions(a: dict, frame: dict) -> set[str]:
    stopped: set[str] = set()
    if not a["config"]["stopLossBps"]:
        return stopped
    for asset in ASSETS:
        position = a["positions"][asset]
        p = _prices(a, frame["quotes"][asset])
        net = position["qty"] * p["sell"] * (1 - p["fee"])
        if position["qty"] > 0 and position["costBasis"] > 0 \
                and net <= position["costBasis"] * (1 - a["config"]["stopLossBps"] / 10000):
            _event(a, "stop_loss", frame["time"], actor="auto", asset=asset, netLiquidation=net,
                   costBasis=position["costBasis"], thresholdBps=a["config"]["stopLossBps"],
                   quoteObservedAt=frame["quotes"][asset]["observedAt"],
                   reason="Observed bid less modeled slippage and exit fee breached loss from fee-inclusive "
                          "entry cost; no intraminute execution assumed")
            _fill(a, a, asset, "sell", MAX_FLOAT, frame, "auto")
            stopped.add(asset)
            position["lastStoppedAt"] = frame["time"]
    return stopped


# Account-level hard limits, checked at observed frames before decisions. A breach
# closes positions at modeled exit costs and blocks new entries; forecasts continue.
# Risk state exists only when a limit is configured.
def _halt_reason(a: dict) -> str | None:
    risk = a.get("risk")
    if not isinstance(risk, dict):
        return None
    if risk.get("killedAt") is not None:
        return "max_drawdown"
    if risk.get("haltedUntil") is not None:
        return "daily_loss"
    return None


def _enforce_limits(a: dict, frame: dict) -> None:
    drawdown, daily = _setting(a, "maxDrawdownBps"), _setting(a, "dailyLossBps")
    if not drawdown and not daily:
        return
    if a.get("risk") is None:
        a["risk"] = {"peakValue": a["config"]["initialCash"], "dayStart": None, "dayOpenValue": None,
                     "killedAt": None, "haltedUntil": None}
    r = a["risk"]
    value = _liquidation(a, a, frame)
    day = math.floor(frame["time"] / DAY) * DAY
    if r["haltedUntil"] is not None and frame["time"] >= r["haltedUntil"]:
        _event(a, "risk_resume", frame["time"], actor="auto", limit="daily_loss",
               reason="New UTC day; daily loss halt lifted")
        r["haltedUntil"] = None
    if r["dayStart"] != day:
        r["dayStart"] = day
        r["dayOpenValue"] = value
    r["peakValue"] = max(r["peakValue"], value)
    if r["killedAt"] is not None or r["haltedUntil"] is not None:
        return
    breach: dict[str, Any] | None = None
    if drawdown and value <= r["peakValue"] * (1 - drawdown / 10000):
        breach = {"limit": "max_drawdown", "thresholdBps": drawdown, "referenceValue": r["peakValue"],
                  "reason": "Net liquidation value fell from its observed peak by at least the drawdown limit; "
                            "no new entries for the rest of the session"}
    elif daily and value <= r["dayOpenValue"] * (1 - daily / 10000):
        breach = {"limit": "daily_loss", "thresholdBps": daily, "referenceValue": r["dayOpenValue"],
                  "resumesAt": day + DAY, "resumeAt": iso(day + DAY),
                  "reason": "Net liquidation value fell from the UTC day opening value by at least the daily loss "
                            "limit; no new entries until the next UTC day"}
    if breach is None:
        return
    _event(a, "risk_halt", frame["time"], actor="auto", netLiquidation=value, **breach)
    _close(a, frame, "auto")
    if breach["limit"] == "max_drawdown":
        r["killedAt"] = frame["time"]
    else:
        r["haltedUntil"] = breach["resumesAt"]


def ingest(a: dict, frame: Any) -> dict:
    if not isinstance(frame, dict) or not finite(frame.get("time")):
        raise ValueError("Invalid frame time")
    if a["lastFrameAt"] is not None and frame["time"] <= a["lastFrameAt"]:
        return a
    if not _valid_frame(a, frame):
        _event(a, "invalid_frame", frame["time"], actor="system",
               reason="Missing, stale, future or invalid quote; no fill or equity mark")
        a["lastFrameAt"] = frame["time"]
        return a
    if a["status"] == "completed":
        # A final target may not have a qualifying quote in the completion frame.
        # Resolve later evidence without reopening trading or revising final equity.
        _settle(a, frame)
        a["lastFrameAt"] = frame["time"]
        a["lastValidFrameAt"] = frame["time"]
        return a
    _start(a, frame)
    _accrue(a, frame)
    config = a["config"]
    if config["mode"] == "live" and a["lastValidFrameAt"] is not None \
            and frame["time"] - a["lastValidFrameAt"] > min(config["horizonMs"], 120000):
        _event(a, "gap", frame["time"], actor="system", gapMs=frame["time"] - a["lastValidFrameAt"],
               reason="No intervening fills simulated; resumed at observed quotes")
    _settle(a, frame)
    stopped = _stop_positions(a, frame)
    _enforce_limits(a, frame)
    blocked_by = _halt_reason(a)
    if frame["time"] >= a["endsAt"]:
        _close(a, frame, "auto")
        a["status"] = "completed"
        _event(a, "complete", frame["time"], actor="system", lateByMs=frame["time"] - a["endsAt"])
    elif a["lastDecisionAt"] is None or frame["time"] - a["lastDecisionAt"] >= config["horizonMs"]:
        _close(a, frame, "auto")
        budget = a["cash"] * config["allocationFraction"]
        for asset in ASSETS:
            if asset in stopped:
                _event(a, "decision_skipped", frame["time"], actor="auto", asset=asset,
                       reason="Stop loss: no same-frame reentry")
                continue
            pred = _prediction(a, asset, frame)
            if pred is None:
                _event(a, "decision_skipped", frame["time"], actor="auto", asset=asset,
                       reason="Insufficient, stale or conflicting completed history")
                continue
            target_at = frame["time"] + config["horizonMs"]
            if target_at > a["endsAt"]:
                _event(a, "decision_skipped", frame["time"], actor="auto", asset=asset,
                       reason="Horizon extends past session end")
                continue
            f = {"id": f"f{len(a['forecasts']) + 1}", "asset": asset, "model": config["model"],
                 "issuedAt": frame["time"], "issueAt": iso(frame["time"]), "targetAt": target_at,
                 "targetTime": iso(target_at), **pred, "status": "pending",
                 "observedAt": None, "actual": None, "latenessMs": None}
            a["forecasts"].append(f)
            p = _prices(a, frame["quotes"][asset])
            # The forecast applies to mid. Assume the current bid/mid ratio at the future
            # exit, retaining spread, both slippage charges and both fees in the hurdle.
            expected = (pred["prediction"] / pred["anchor"]) * (p["sell"] / p["buy"]) \
                * (1 - p["fee"]) / (1 + p["fee"])
            buy = expected > 1 + config["bufferBps"] / 10000
            # A halted decision still records what the rule would have done.
            blocked = {"blockedBy": blocked_by, "wouldBuy": buy} if blocked_by else {}
            _event(a, "decision", frame["time"], actor="auto", asset=asset, forecastId=f["id"],
                   action="buy" if buy and not blocked_by else "cash", expectedNetRatio=expected,
                   requiredNetRatio=1 + config["bufferBps"] / 10000, **blocked)
            if buy and not blocked_by:
                _fill(a, a, asset, "buy", budget, frame, "auto")
        a["lastDecisionAt"] = frame["time"]
    a["lastFrameAt"] = frame["time"]
    a["lastValidFrameAt"] = frame["time"]
    _mark(a, frame)
    return a


def manual_trade(a: dict, asset: str, side: str, dollars: Any, frame: Any) -> dict:
    if asset not in ASSETS or side not in ("buy", "sell") or not finite(dollars) or dollars <= 0:
        raise ValueError("Invalid order")
    if not _valid_frame(a, frame) or a["status"] == "completed" \
            or (a["lastFrameAt"] is not None and frame["time"] < a["lastFrameAt"]):
        raise ValueError("Unavailable or stale trading frame")
    # Process settlement and scheduled automatic actions before a newer manual
    # frame consumes the clock. A frame already ingested by the UI is reused.
    if a["lastFrameAt"] is None or frame["time"] > a["lastFrameAt"]:
        ingest(a, frame)
    if frame["time"] >= a["endsAt"]:
        raise ValueError("Paper session has ended")
    if side == "buy" and a["positions"][asset].get("lastStoppedAt") == frame["time"]:
        raise ValueError("Stopped asset cannot reenter in the same frame")
    if side == "buy" and _halt_reason(a):
        raise ValueError("Drawdown limit reached: new entries are stopped for this session"
                         if _halt_reason(a) == "max_drawdown" else
                         "Daily loss limit reached: new entries resume next UTC day")
    _fill(a, a, asset, side, dollars, frame, "manual")
    _mark(a, frame)
    a["lastFrameAt"] = frame["time"]
    a["lastValidFrameAt"] = frame["time"]
    return a


def _avg(xs: list[dict], key: str) -> float | None:
    if not xs:
        return None
    total = 0
    for x in xs:
        total = total + x[key]
    return total / len(xs)


def get_summary(a: dict) -> dict[str, Any]:
    last = a["equity"][-1] if a["equity"] else None
    initial = a["config"]["initialCash"]
    peak, max_dd, dd = initial, 0, 0
    for point in a["equity"]:
        peak = max(peak, point["value"])
        dd = 100 * (peak - point["value"]) / peak
        max_dd = max(max_dd, dd)
    done = [f for f in a["forecasts"] if f["status"] == "settled"]
    trades = [e for e in a["ledger"] if e["type"] == "trade" and e["actor"] != "benchmark"]
    equity = last["value"] if last else initial
    hold = last["buyHoldValue"] if last else initial
    # `last?.cashValue ?? initial` and `a.interest ?? 0`
    cash_benchmark = last.get("cashValue") if last and last.get("cashValue") is not None else initial
    interest = a.get("interest") if a.get("interest") is not None else 0
    fees = 0
    for t in trades:
        fees = fees + t["fee"]
    per_asset = {}
    for s in ASSETS:
        fs = [f for f in done if f["asset"] == s]
        per_asset[s] = {"count": len(fs), "mae": _avg(fs, "absoluteError"),
                        "samePriceMae": _avg(fs, "baselineAbsoluteError"), "qty": a["positions"][s]["qty"]}
    return {
        "status": a["status"], "equity": equity, "cash": a["cash"],
        "returnPct": 100 * (equity / initial - 1), "buyHoldEquity": hold,
        "buyHoldReturnPct": 100 * (hold / initial - 1), "cashBenchmark": cash_benchmark,
        "interestEarned": interest,
        "drawdownPct": dd, "maxDrawdownPct": max_dd, "fees": fees, "tradeCount": len(trades),
        "forecastCount": len(a["forecasts"]), "settledForecasts": len(done),
        "pendingForecasts": sum(1 for f in a["forecasts"] if f["status"] == "pending"),
        "expiredForecasts": sum(1 for f in a["forecasts"] if f["status"] == "expired"),
        "mae": _avg(done, "absoluteError"), "samePriceMae": _avg(done, "baselineAbsoluteError"),
        "perAsset": per_asset,
        "riskHalts": sum(1 for e in a["ledger"] if e["type"] == "risk_halt"), "tradingHalted": _halt_reason(a),
        "valuationAt": last["time"] if last else None,
        "valuationIsNetLiquidation": True,
    }


def clone_account(a: dict) -> dict:
    return deepcopy(a)
