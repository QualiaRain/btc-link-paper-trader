"""Live paper mode against goldens produced by the existing JavaScript (parity/live).

* `fetch-live-market`: the SAME canned Coinbase responses go through market.js `fetchLiveMarket` (stubbed fetch, fixed
  Date.now) and through `live.fetch_live_market` (injected transport and clock); frame, history, provenance and
  error messages must be equal.
* `live-sessions`: the same action lists go through the app.js live flow (start, liveTick, order) on engine.js and
  through the HTTP session API (`POST /v1/sessions` with mode live, `/tick`, `/orders`); events, state, account
  digest, summary and the market-snapshot hash must match.
No network is used: the Python transport and clock are replaced by the canned world.
`node parity/live/golden.test.mjs` proves the goldens still equal what the JavaScript produces.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from paper_trail import live
from paper_trail.api import create_app
from paper_trail.records import RunStore
from parity_runner import digest
from test_parity import diff
from test_parity_sessions import events_out

PARITY = Path(__file__).resolve().parents[2] / "parity" / "live"
CASES = sorted(p.stem for p in (PARITY / "inputs").glob("*.json"))
BASE = "https://api.exchange.coinbase.com"
STATE_KEYS = ("version", "kind", "cursor", "frameCount", "warmupFrameCount", "scoreStart", "scoreEnd", "status",
              "currentFrame", "nextDecisionAt", "manualTradeCount", "summary")


def route(world: dict, path: str) -> dict:
    if path in (world.get("routes") or {}):
        return world["routes"][path]
    for asset in ("BTC", "LINK"):
        if path == f"/products/{asset}-USD/candles?granularity=60":
            return {"status": 200, "json": world["series"][asset]}
        if path == f"/products/{asset}-USD/ticker":
            return {"status": 200, "json": world["ticker"][asset]}
    return {"status": 404, "json": {"message": "NotFound"}}


def transport_for(world: dict):
    def transport(url: str, timeout: float):
        assert url.startswith(BASE) and timeout == 15
        r = route(world, url[len(BASE):])
        body = r["text"].encode() if "text" in r else json.dumps(r["json"]).encode()
        return r.get("status", 200), body
    return transport


def normalize_error(message: str, world: dict) -> str:
    return re.sub(r"^(Market data unavailable \([^)]*\): ).*$", r"\1<invalid json>", message, flags=re.S) \
        if world.get("invalidJson") else message


def run_fetch(scenario: dict) -> dict:
    try:
        frame = live.fetch_live_market(scenario["horizonMs"], transport=transport_for(scenario),
                                       clock=lambda: float(scenario["now"]), base=BASE)
        return {"frame": frame}
    except live.LiveMarketError as error:
        return {"error": normalize_error(str(error), scenario)}


def run_session(client: TestClient, scenario: dict, world: dict) -> dict:
    def use(step: dict) -> None:
        world.clear()
        world.update({"series": scenario["series"], "now": step["now"], "ticker": step.get("ticker"),
                      "routes": step.get("routes"), "invalidJson": step.get("invalidJson")})

    use(scenario["open"])
    created = client.post("/v1/sessions", json={"settings": scenario["settings"]})
    if created.status_code != 201:
        return {"error": normalize_error(created.json()["error"]["message"], scenario["open"])}
    state = created.json()
    sid = state["id"]
    out: dict = {"open": {k: state[k] for k in STATE_KEYS}, "steps": []}
    for action in scenario["steps"]:
        use(action)
        shown = {k: action[k] for k in ("op", "asset", "side", "dollars") if k in action}
        if action["op"] == "tick":
            response = client.post(f"/v1/sessions/{sid}/tick", json={"expectedVersion": state["version"]})
        else:
            payload = {k: v for k, v in shown.items() if k != "op"}
            response = client.post(f"/v1/sessions/{sid}/orders", json={**payload, "expectedVersion": state["version"]})
        step: dict = {"action": shown}
        if response.status_code == 200:
            result = response.json()
            step["framesIngested"], step["events"] = result["framesIngested"], events_out(result["events"])
            state = result["state"]
        else:
            error = response.json()["error"]
            step["code"] = error["code"]
            if error["code"] in ("order_rejected", "live_unavailable"):
                step["message"] = normalize_error(error["message"], action)
            assert client.get(f"/v1/sessions/{sid}").json() == state, "a rejected call must not change the session"
        step["state"] = {k: state[k] for k in STATE_KEYS}
        out["steps"].append(step)
    account = client.get(f"/v1/sessions/{sid}/account").json()["account"]
    saved = client.post(f"/v1/sessions/{sid}/save", json={"expectedVersion": state["version"]}).json()
    record = client.get(f"/v1/runs/{saved['run']['id']}/export").json()
    assert len(record["market"]["dataset"]["frames"]) == state["frameCount"] and record["market"]["kind"] == "live"
    out["final"] = {"account": account if scenario.get("fullAccount") else digest(account), "summary": state["summary"],
                    "market": {"frameCount": state["frameCount"], "sha256": record["hashes"]["marketSha256"]}}
    return out


@pytest.fixture
def world(monkeypatch):
    holder: dict = {}
    monkeypatch.setattr(live, "default_transport", lambda url, timeout: transport_for(holder)(url, timeout))
    monkeypatch.setattr(live, "default_clock", lambda: float(holder["now"]))
    monkeypatch.delenv("PAPER_TRAIL_LIVE_BASE_URL", raising=False)
    return holder


def golden(name: str) -> dict:
    return json.loads((PARITY / "expected" / f"{name}.json").read_text())


def compare(name: str, actual: dict) -> None:
    expected = golden(name)["scenarios"]
    actual = json.loads(json.dumps(actual))
    assert actual.keys() == expected.keys()
    problems = [f"{scenario}: {found}" for scenario in actual if (found := diff(expected[scenario], actual[scenario]))]
    assert not problems, "\n".join(problems)


def test_live_inputs_are_present():
    assert CASES == ["fetch-live-market", "live-sessions"]
    assert len(golden("fetch-live-market")["scenarios"]) >= 12 and len(golden("live-sessions")["scenarios"]) >= 4


def test_python_fetch_live_market_matches_the_javascript_golden():
    case = json.loads((PARITY / "inputs" / "fetch-live-market.json").read_text())
    assert golden("fetch-live-market")["kind"] == case["kind"] == "live-fetch"
    compare("fetch-live-market", {s["name"]: run_fetch(s) for s in case["scenarios"]})


def test_python_live_sessions_match_the_javascript_golden(world, tmp_path):
    case = json.loads((PARITY / "inputs" / "live-sessions.json").read_text())
    client = TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "no-web"))
    compare("live-sessions", {s["name"]: run_session(client, s, world) for s in case["scenarios"]})


def test_goldens_exercise_the_cases_they_claim():
    fetches = golden("fetch-live-market")["scenarios"]
    messages = [s["error"] for s in fetches.values() if "error" in s]
    for fragment in ("crossed bid/ask quote", "stale or future exchange trade timestamp", "invalid exchange timestamp",
                     "Invalid market price", "Minute history is stale", "Fewer than seven completed", "Conflicting duplicate minute",
                     "Invalid candle OHLC bounds", "Invalid candle row", "Invalid minute bucket", "Market source HTTP 500",
                     "Market source HTTP 404", "Unsupported forecast horizon", "Invalid Coinbase candle response"):
        assert any(fragment in m for m in messages), fragment
    good = [s["frame"] for s in fetches.values() if "frame" in s]
    assert len(good) >= 5 and {len(f["history"]["BTC"]) for f in good} >= {120, 300}
    assert all(set(f["provenance"]) == {"BTC", "LINK"} and f["quotes"]["BTC"]["simulatedQuote"] is False for f in good)
    sessions = golden("live-sessions")["scenarios"]
    assert "error" in sessions["opening-fetch-fails-no-session"]
    gap = sessions["ticks-gap-and-completion-at-duration"]
    types = {e["type"] for st in gap["steps"] if isinstance(st.get("events"), list) for e in st["events"]}
    assert {"gap", "complete"} <= types and gap["steps"][-1]["code"] == "session_completed"
    failed = sessions["failed-reads-change-nothing"]["steps"]
    assert sum(st.get("code") == "live_unavailable" for st in failed) >= 4
    orders = sessions["manual-orders-ingest-a-fresh-frame-then-trade"]["steps"]
    assert all(st["framesIngested"] == 1 for st in orders if st["action"]["op"] == "order" and "events" in st)
    assert any(e["type"] == "stop_loss" for st in sessions["stop-loss-after-manual-buys"]["steps"] for e in st.get("events", []))
