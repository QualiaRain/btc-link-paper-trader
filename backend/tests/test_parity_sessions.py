"""Stepwise sessions against goldens produced by the existing JavaScript (parity/sessions).

`parity/sessions/harness.mjs` replays an action list (advance / order) through engine.js with the same dataset
construction as app.js; here the SAME actions go through the HTTP API of the Python session service. The account
digest, summary, session state and per-step events must match (exact for ints/strings, 1e-12 relative for floats).
`node parity/sessions/golden.test.mjs` proves the goldens still equal what the JavaScript produces.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from paper_trail.api import create_app
from paper_trail.records import RunStore
from parity_runner import digest
from test_parity import diff

PARITY = Path(__file__).resolve().parents[2] / "parity" / "sessions"
CASES = sorted(p.stem for p in (PARITY / "inputs").glob("*.json"))
STATE_KEYS = ("version", "kind", "cursor", "frameCount", "warmupFrameCount", "scoreStart", "scoreEnd", "status",
              "currentFrame", "nextDecisionAt", "manualTradeCount", "summary", "coverage", "receiptCount")


def events_out(events: list[dict]):
    if len(events) <= 40:
        return events
    by_type: dict[str, int] = {}
    for e in events:
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
    return {"count": len(events), "byType": by_type, "first": events[0], "last": events[-1],
            "trades": [[e["id"], e["time"], e["actor"], e["asset"], e["side"], e["qty"], e["price"], e["fee"],
                        e["notional"], e["cashDelta"]] for e in events if e["type"] == "trade"]}


def run_session(client: TestClient, scenario: dict) -> dict:
    body: dict = {"settings": scenario["settings"]}
    if "candles" in scenario:
        body["candles"] = scenario["candles"]
    created = client.post("/v1/sessions", json=body)
    if created.status_code != 201:
        return {"error": created.json()["error"]["message"]}
    state = created.json()
    sid = state["id"]
    out: dict = {"open": {k: state[k] for k in STATE_KEYS}, "steps": []}
    for action in scenario["actions"]:
        payload = {k: v for k, v in action.items() if k != "op"}
        payload["expectedVersion"] = state["version"]
        path = "advance" if action["op"] == "advance" else "orders"
        response = client.post(f"/v1/sessions/{sid}/{path}", json=payload)
        step: dict = {"action": action}
        if response.status_code == 200:
            result = response.json()
            step["framesIngested"], step["events"] = result["framesIngested"], events_out(result["events"])
            state = result["state"]
        else:
            error = response.json()["error"]
            step["code"] = error["code"]
            if error["code"] == "order_rejected":
                step["message"] = error["message"]
            unchanged = client.get(f"/v1/sessions/{sid}").json()
            assert unchanged == state, "a rejected call must not change the session"
        step["state"] = {k: state[k] for k in STATE_KEYS}
        out["steps"].append(step)
    account = client.get(f"/v1/sessions/{sid}/account").json()["account"]
    out["final"] = {"account": account if scenario.get("fullAccount") else digest(account), "summary": state["summary"]}
    return out


def python_results(case: dict, tmp_path) -> dict:
    client = TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "no-web"))
    return json.loads(json.dumps({s["name"]: run_session(client, s) for s in case["scenarios"]}))


def golden(name: str) -> dict:
    return json.loads((PARITY / "expected" / f"{name}.json").read_text())


def test_session_inputs_are_present():
    assert CASES == ["range-sessions", "sample-sessions"]
    assert sum(len(json.loads((PARITY / "inputs" / f"{n}.json").read_text())["scenarios"]) for n in CASES) >= 8


@pytest.mark.parametrize("name", CASES)
def test_python_sessions_match_javascript_golden(name, tmp_path):
    case = json.loads((PARITY / "inputs" / f"{name}.json").read_text())
    expected = golden(name)
    assert expected["name"] == case["name"] and expected["kind"] == case["kind"] == "session"
    actual = python_results(case, tmp_path)
    assert actual.keys() == expected["scenarios"].keys()
    problems = [f"{scenario}: {found}" for scenario in actual
                if (found := diff(expected["scenarios"][scenario], actual[scenario]))]
    assert not problems, "\n".join(problems)


def test_goldens_exercise_the_cases_they_claim():
    """Guard against vacuous parity: the behaviours named in the scenarios must really occur in the JS output."""
    scenarios = {**golden("sample-sessions")["scenarios"], **golden("range-sessions")["scenarios"]}
    assert len(scenarios) >= 8 and not any("error" in s for s in scenarios.values())

    def steps(name):
        return scenarios[name]["steps"]

    def types(step):
        events = step.get("events", [])
        return {e["type"] for e in events} if isinstance(events, list) else set(events["byType"])

    assert all(s["framesIngested"] == 1 for s in steps("frames-one-at-a-time"))
    assert {s["framesIngested"] for s in steps("frames-in-batches")} >= {1, 3, 5, 17, 250}
    decisions = [s for s in steps("decision-stepping") if s["action"].get("mode") == "decision"]
    assert len(decisions) == 6 and all("decision" in types(s) for s in decisions)
    assert steps("finish-then-nothing-more-allowed")[1]["state"]["status"] == "completed"
    assert [s.get("code") for s in steps("finish-then-nothing-more-allowed")[2:]] == ["session_completed"] * 4
    mix = steps("manual-buy-and-sell-mix")
    assert any(s["action"]["side"] == "buy" for s in mix if s["action"]["op"] == "order" and "events" in s)
    assert any(s["action"]["side"] == "sell" for s in mix if s["action"]["op"] == "order" and "events" in s)
    stop = steps("stop-loss-then-same-frame-buy-rejected")
    assert any("stop_loss" in types(s) for s in stop)
    assert any(s.get("message") == "Stopped asset cannot reenter in the same frame" for s in stop)
    rejected = steps("rejected-orders-leave-state-unchanged")
    assert {s.get("message") for s in rejected if s.get("code")} >= {
        "The order produced no trade: no position to sell", "A buy needs dollars greater than zero", "Invalid order"}
    assert all(s["state"]["version"] == 1 for s in rejected[:7])
    assert any("no cash available" in s.get("message", "") for s in steps("cash-exhausted"))
    gapped = scenarios["range-gapped-frames-and-decisions"]
    assert gapped["open"]["kind"] == "historical" and gapped["open"]["frameCount"] < 61  # minutes were missing, not filled
    assert gapped["steps"][-2]["state"]["status"] == "completed"
