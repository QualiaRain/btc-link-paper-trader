"""Python counterpart of parity/harness.mjs: runs the same inputs through the Python backend."""
from __future__ import annotations

import hashlib
from typing import Any

from paper_trail.canonical import canonical_json
from paper_trail.configuration import normalize_settings
from paper_trail.engine import create_account, get_summary, ingest, manual_trade
from paper_trail.records import make_run_record
from paper_trail.replay import run_replay


def run_account(scenario: dict) -> dict:
    try:
        account = create_account(scenario.get("config") or {})
    except ValueError as error:
        return {"createError": str(error)}
    # Simulates an account saved before these settings existed (its frozen config lacks them).
    for field in scenario.get("dropConfigFields") or []:
        account["config"].pop(field, None)
    errors = []
    for index, step in enumerate(scenario["steps"]):
        try:
            if step["op"] == "ingest":
                ingest(account, step.get("frame"))
            else:
                manual_trade(account, step["asset"], step["side"], step["dollars"], step["frame"])
        except ValueError as error:
            errors.append({"step": index, "message": str(error)})
    return {"account": account, "summary": get_summary(account), "errors": errors}


def run_settings(scenario: dict) -> list:
    out = []
    for item in scenario["inputs"]:
        try:
            out.append({"ok": normalize_settings(item)})
        except ValueError as error:
            out.append({"error": str(error)})
    return out


def run_canonical(scenario: dict) -> list:
    return [{"text": canonical_json(v), "sha256": hashlib.sha256(canonical_json(v).encode()).hexdigest()}
            for v in scenario["values"]]


def digest(account: dict) -> dict:
    counts: dict[str, int] = {}
    for e in account["ledger"]:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    trades = [[e["id"], e["time"], e["actor"], e["asset"], e["side"], e["qty"], e["price"], e["fee"],
               e["notional"], e["cashDelta"], e["source"]] for e in account["ledger"] if e["type"] == "trade"]
    decisions = [[e["id"], e["time"], e["asset"], e.get("action") or e.get("reason"),
                  e.get("expectedNetRatio")] for e in account["ledger"]
                 if e["type"] in ("decision", "decision_skipped")]
    forecasts = [[f["id"], f["asset"], f["status"], f["issuedAt"], f["targetAt"], f["anchor"], f["prediction"],
                  f["historyEnd"], f["actual"], f["latenessMs"], f.get("absoluteError"),
                  f.get("baselineAbsoluteError")] for f in account["forecasts"]]
    equity = [[p["time"], p["value"], p["buyHoldValue"]] for i, p in enumerate(account["equity"])
              if i % 20 == 0 or i == len(account["equity"]) - 1]
    return {"config": account["config"], "cash": account["cash"], "positions": account["positions"],
            "status": account["status"], "startedAt": account["startedAt"], "endsAt": account["endsAt"],
            "lastDecisionAt": account["lastDecisionAt"], "lastFrameAt": account["lastFrameAt"],
            "sequence": account["sequence"], "baseline": account["baseline"], "ledgerCounts": counts,
            "trades": trades, "decisions": decisions, "forecasts": forecasts, "equity": equity,
            "equityCount": len(account["equity"]),
            "riskEvents": [e for e in account["ledger"] if e["type"] in ("risk_halt", "risk_resume")],
            "blockedDecisions": [[e["id"], e["time"], e["asset"], e["blockedBy"], e["wouldBuy"]]
                                 for e in account["ledger"] if e.get("blockedBy")],
            "risk": account.get("risk"), "interest": account.get("interest")}


def _describe(settings: dict, account: dict, dataset: dict, compact: bool) -> dict:
    market = {"kind": "replay", "dataset": {"scoreStart": dataset["scoreStart"], "scoreEnd": dataset["scoreEnd"]},
              "settings": settings}
    record = make_run_record(account, market, name="parity", run_id="parity-run")
    return {"account": digest(account) if compact else account, "summary": get_summary(account),
            "scoreStart": dataset["scoreStart"], "scoreEnd": dataset["scoreEnd"],
            "settingsExport": {**settings, "config": dict(account["config"])},
            "record": {"status": record["status"], "config": record["config"], "summary": record["summary"],
                       "manualTradeCount": record["manualTradeCount"],
                       "configSha256": record["hashes"]["configSha256"]}}


def run_sample_replay(scenario: dict) -> dict:
    try:
        settings = normalize_settings(scenario["settings"])
        account, dataset = run_replay(settings)
        return _describe(settings, account, dataset, True)
    except ValueError as error:
        return {"error": str(error)}


def run_range_replay(scenario: dict) -> dict:
    try:
        settings = normalize_settings(scenario["settings"])
        account, dataset = run_replay(settings, scenario["candles"])
        result = _describe(settings, account, dataset, False)
    except ValueError as error:
        return {"error": str(error)}
    frames = dataset["frames"]
    result["frameTimes"] = [f["time"] for f in frames]
    result["firstHistory"] = {a: frames[0]["history"][a] for a in ("BTC", "LINK")}
    result["lastHistory"] = {a: frames[-1]["history"][a] for a in ("BTC", "LINK")}
    keys = ("expectedCount", "observedCount", "missingCount", "startPresent", "endPresent", "warmupObservedCount")
    result["coverage"] = {a: {k: dataset["coverage"][a][k] for k in keys} for a in ("BTC", "LINK")}
    return result


RUNNERS = {"account": run_account, "settings": run_settings, "canonical": run_canonical,
           "sample-replay": run_sample_replay, "range-replay": run_range_replay}


def run_case(case: dict) -> dict:
    return {s["name"]: RUNNERS[case["kind"]](s) for s in case["scenarios"]}
