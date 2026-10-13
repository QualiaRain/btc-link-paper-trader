"""Stepwise replay sessions: causality, validation and stale-version handling, exports (HTTP, in-process)."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from paper_trail.api import create_app
from paper_trail.configuration import normalize_settings
from paper_trail.engine import ingest
from paper_trail.records import RunStore
from paper_trail.replay import prepare_replay, run_replay, start_account
from parity_runner import digest
from test_parity import diff

PARITY = Path(__file__).resolve().parents[2] / "parity" / "sessions"
RANGE_CASE = json.loads((PARITY / "inputs" / "range-sessions.json").read_text())["scenarios"][0]
SAMPLE = {"settings": {"config": {}}}


@pytest.fixture
def store(tmp_path):
    return RunStore(tmp_path / "runs")


@pytest.fixture
def client(store, tmp_path):
    return TestClient(create_app(store=store, web_dir=tmp_path / "no-web"))


def create(client, body=SAMPLE, status=201):
    response = client.post("/v1/sessions", json=body)
    assert response.status_code == status, response.text
    return response.json()


def advance(client, state, mode="frames", count=1, status=200, version=None):
    response = client.post(f"/v1/sessions/{state['id']}/advance", json={
        "mode": mode, "count": count, "expectedVersion": state["version"] if version is None else version})
    assert response.status_code == status, response.text
    return response.json()


def order(client, state, asset="BTC", side="buy", dollars=100, status=200, version=None):
    body = {"asset": asset, "side": side, "expectedVersion": state["version"] if version is None else version}
    if dollars is not None:
        body["dollars"] = dollars
    response = client.post(f"/v1/sessions/{state['id']}/orders", json=body)
    assert response.status_code == status, response.text
    return response.json()


def save(client, state, status=200, **extra):
    response = client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": state["version"], **extra})
    assert response.status_code == status, response.text
    return response.json()


def close(client, state, status=200, version="current"):
    body = None if version is None else {"expectedVersion": state["version"] if version == "current" else version}
    response = client.request("DELETE", f"/v1/sessions/{state['id']}", json=body)
    assert response.status_code == status, response.text
    return response.json()


def get_state(client, sid):
    return client.get(f"/v1/sessions/{sid}").json()


def account_of(client, sid):
    return client.get(f"/v1/sessions/{sid}/account").json()["account"]


# ---- causality ------------------------------------------------------------------------------------------------
def test_create_ingests_only_the_first_scored_frame_and_matches_a_replay_start():
    settings = normalize_settings({"config": {}})
    config, dataset = prepare_replay(settings)
    reference = start_account(config, dataset)
    app = TestClient(create_app(store=RunStore(), web_dir="/nonexistent"))
    state = create(app)
    assert state["version"] == 1 and state["status"] == "active" and state["savedVersion"] is None
    assert state["cursor"] == dataset["cursor"] == state["warmupFrameCount"] == 7 and state["manualTradeCount"] == 0
    assert state["currentFrame"]["time"] == dataset["scoreStart"] == reference["lastFrameAt"] == state["scoreStart"]
    assert account_of(app, state["id"]) == json.loads(json.dumps(reference))
    assert state["runId"] != state["id"]


def test_after_k_advances_the_account_equals_k_engine_ingests_and_history_is_prefix_stable(client):
    config, dataset = prepare_replay(normalize_settings({"config": {"horizonMs": 300000}}))
    reference = start_account(config, dataset)
    state = create(client, {"settings": {"config": {"horizonMs": 300000}}})
    previous_ledger = account_of(client, state["id"])["ledger"]
    assert previous_ledger[0]["type"] == "start"
    for k in range(1, 41):
        ingest(reference, dataset["frames"][dataset["cursor"] + k])
        step = advance(client, state)
        state = step["state"]
        assert state["cursor"] == dataset["cursor"] + k and state["version"] == k + 1
        account = account_of(client, state["id"])
        assert diff(json.loads(json.dumps(reference)), account) is None
        assert account["ledger"][:len(previous_ledger)] == previous_ledger  # earlier events never change
        assert account["ledger"][len(previous_ledger):] == step["events"]
        previous_ledger = account["ledger"]


def test_no_response_ever_contains_a_frame_time_later_than_the_current_frame(client, store):
    state = create(client, {"settings": RANGE_CASE["settings"], "candles": RANGE_CASE["candles"]})
    future = {c["time"] for series in RANGE_CASE["candles"].values() for c in series if c["time"] > state["currentFrame"]["time"]}
    assert future  # the full series is longer than what the session has revealed

    def check(state_doc, account=None, record=None):
        now = state_doc["currentFrame"]["time"]
        assert all(q["observedAt"] <= now for q in state_doc["currentFrame"]["quotes"].values())
        assert state_doc["summary"]["valuationAt"] is None or state_doc["summary"]["valuationAt"] <= now
        if account:
            assert all(e["time"] <= now for e in account["ledger"]) and all(p["time"] <= now for p in account["equity"])
            assert account["lastFrameAt"] <= now and all(f["issuedAt"] <= now for f in account["forecasts"])
            assert all((f["observedAt"] or 0) <= now for f in account["forecasts"])
        if record:
            evidence = record["market"]["dataset"]["evidence"]
            assert all(row["time"] <= now for rows in evidence["prices"].values() for row in rows)
            assert evidence["sharedCount"] <= state_doc["cursor"] + 1
            assert all(c["observedThrough"] <= now for c in record["market"]["dataset"]["coverage"].values())

    for step in range(25):
        result = advance(client, state, count=1 + step % 3)
        state = result["state"]
        assert all(e["time"] <= state["currentFrame"]["time"] for e in result["events"])
        if step % 6 == 0:
            snapshot = save(client, state)
            state = snapshot["state"]
            check(state, record=client.get(f"/v1/runs/{state['runId']}/export").json())
        check(state, account=account_of(client, state["id"]))
    # The mid-replay snapshot text contains no candle from the future at all.
    text = json.dumps(client.get(f"/v1/runs/{state['runId']}/export").json())
    now = state["currentFrame"]["time"]
    present = {int(t) for t in re.findall(r'"time": (\d+)', text)}
    later = {c["time"] for series in RANGE_CASE["candles"].values() for c in series if c["time"] > now}
    assert later and present and max(present) <= now and not (present & later)


def test_a_finished_session_snapshot_carries_the_complete_evidence(client):
    state = create(client, {"settings": RANGE_CASE["settings"], "candles": RANGE_CASE["candles"]})
    state = advance(client, state, "finish")["state"]
    state = save(client, state)["state"]
    market = client.get(f"/v1/runs/{state['runId']}/export").json()["market"]
    assert market["dataset"]["evidence"]["sharedCount"] == state["frameCount"]
    assert market["dataset"]["coverage"]["LINK"]["endPresent"] is True


# ---- advance semantics ----------------------------------------------------------------------------------------
def test_decision_mode_stops_at_the_frame_that_reaches_the_next_decision_time(client):
    state = create(client, {"settings": {"config": {"horizonMs": 900000}}})
    for _ in range(5):
        target = state["nextDecisionAt"]
        assert target == get_state(client, state["id"])["nextDecisionAt"]
        step = advance(client, state, "decision")
        state = step["state"]
        assert state["currentFrame"]["time"] >= target > state["currentFrame"]["time"] - 900000
        assert sum(1 for e in step["events"] if e["type"] == "decision") == 2  # one decision per asset


def test_finish_runs_to_the_end_and_matches_a_complete_replay(client):
    state = create(client)
    done = advance(client, state, "finish")
    final = done["state"]
    assert final["status"] == "completed" and final["cursor"] == final["frameCount"] - 1 and final["nextDecisionAt"] is None
    account, _ = run_replay(normalize_settings({"config": {}}))
    assert diff(json.loads(json.dumps(account)), account_of(client, state["id"])) is None
    assert done["framesIngested"] == final["frameCount"] - 1 - state["cursor"]


def test_session_saved_after_finish_equals_a_post_replays_run(client):
    state = create(client)
    state = advance(client, state, "finish")["state"]
    saved = save(client, state)["run"]
    replay = client.post("/v1/replays", json=SAMPLE).json()["run"]
    assert saved["hashes"] == replay["hashes"] and saved["summary"] == replay["summary"]


@pytest.mark.parametrize("body", [
    {"settings": {"config": {}, "replay": {"source": "range", "start": "2024-03-09T12:00", "end": "2024-03-09T13:00"}}},
    {"settings": {"config": {"horizonMs": 1234}}},
])
def test_session_creation_refuses_what_a_replay_refuses(client, body):
    error = create(client, body, status=422)["error"]
    replay = client.post("/v1/replays", json=body).json()["error"]
    assert error == replay and client.get("/v1/runs").json() == {"runs": []}


def test_invalid_session_requests_use_the_stable_error_shape(client):
    assert create(client, {"settings": {"config": {"feeBp": 1}}}, status=422)["error"]["code"] == "invalid_request"
    state = create(client)
    for path, body in (("advance", {"mode": "sideways", "expectedVersion": 1}), ("advance", {"mode": "frames", "count": 0, "expectedVersion": 1}),
                       ("advance", {"mode": "frames"}), ("orders", {"asset": "ETH", "side": "buy", "dollars": 5, "expectedVersion": 1}),
                       ("orders", {"asset": "BTC", "side": "short", "dollars": 5, "expectedVersion": 1}),
                       ("orders", {"asset": "BTC", "side": "buy", "dollars": "5", "expectedVersion": 1}),
                       ("save", {"name": "x"})):
        response = client.post(f"/v1/sessions/{state['id']}/{path}", json=body)
        assert response.status_code == 422 and response.json()["error"]["code"] == "invalid_request", (path, body)
    assert get_state(client, state["id"]) == state


# ---- stale versions and rejected calls change nothing ---------------------------------------------------------
def test_wrong_expected_version_is_a_stale_409_that_changes_nothing(client):
    state = advance(client, create(client))["state"]
    state = order(client, state)["state"]
    assert state["version"] == 3
    before_account = account_of(client, state["id"])
    calls = (
        lambda v: client.post(f"/v1/sessions/{state['id']}/advance", json={"mode": "frames", "expectedVersion": v}),
        lambda v: client.post(f"/v1/sessions/{state['id']}/orders", json={"asset": "BTC", "side": "buy", "dollars": 5, "expectedVersion": v}),
        lambda v: client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": v}),
        lambda v: client.request("DELETE", f"/v1/sessions/{state['id']}", json={"expectedVersion": v}))
    for call in calls:
        for wrong in (1, 2, 4, 99):
            response = call(wrong)
            assert response.status_code == 409
            assert response.json() == {"error": {"code": "stale_session", "message": response.json()["error"]["message"],
                                                 "currentVersion": 3}}
            assert get_state(client, state["id"]) == state and account_of(client, state["id"]) == before_account
    assert client.get("/v1/runs").json() == {"runs": []}  # a stale save wrote nothing


def test_order_rejections_use_order_rejected_and_leave_state_and_version_untouched(client):
    state = create(client, {"settings": {"config": {"allocationFraction": 0}}})
    before = account_of(client, state["id"])
    cases = [("BTC", "sell", None), ("LINK", "sell", 25), ("BTC", "buy", None), ("BTC", "buy", 0), ("LINK", "buy", -3),
             ("BTC", "sell", 0), ("BTC", "sell", -2)]
    for asset, side, dollars in cases:
        error = order(client, state, asset, side, dollars, status=422)["error"]
        assert error["code"] == "order_rejected" and error["message"], (asset, side, dollars)
        assert get_state(client, state["id"]) == state and account_of(client, state["id"]) == before
    assert state["version"] == 1


def test_sell_defaults_to_the_whole_position_and_a_buy_spends_what_it_can(client):
    state = create(client, {"settings": {"config": {"allocationFraction": 0, "initialCash": 150}}})
    state = order(client, state, "BTC", "buy", 100)["state"]
    state = order(client, state, "BTC", "buy", 1000)["state"]  # capped by the remaining cash
    assert state["summary"]["cash"] == 0 and state["manualTradeCount"] == 2
    order(client, state, "LINK", "buy", 10, status=422)  # nothing left to spend
    sold = order(client, state, "BTC", "sell", None)
    assert sold["state"]["summary"]["perAsset"]["BTC"]["qty"] == 0
    assert [e["actor"] for e in sold["events"]] == ["manual"] and sold["framesIngested"] == 0


def test_completed_session_refuses_advance_and_orders_without_changing_version(client):
    state = advance(client, create(client), "finish")["state"]
    assert state["status"] == "completed"
    for response in (client.post(f"/v1/sessions/{state['id']}/advance", json={"mode": "frames", "expectedVersion": state["version"]}),
                     client.post(f"/v1/sessions/{state['id']}/orders", json={"asset": "BTC", "side": "buy", "dollars": 5, "expectedVersion": state["version"]}),
                     client.post(f"/v1/sessions/{state['id']}/orders", json={"asset": "BTC", "side": "sell", "expectedVersion": state["version"]})):
        assert response.status_code == 409 and response.json()["error"]["code"] == "session_completed"
    assert get_state(client, state["id"]) == state
    assert save(client, state)["state"]["status"] == "completed"  # a finished replay can still be saved


def test_unknown_sessions_are_404(client):
    for method, path, body in (("GET", "", None), ("GET", "/account", None), ("POST", "/advance", {"mode": "finish", "expectedVersion": 1}),
                               ("POST", "/orders", {"asset": "BTC", "side": "buy", "dollars": 5, "expectedVersion": 1}),
                               ("POST", "/save", {"expectedVersion": 1}), ("DELETE", "", None)):
        response = client.request(method, f"/v1/sessions/nope{path}", json=body)
        assert response.status_code == 404 and response.json()["error"]["code"] == "session_not_found"


def test_closed_sessions_are_read_only_and_say_so(client):
    state = advance(client, create(client))["state"]
    closed = close(client, state)
    assert closed["status"] == "closed" and closed["version"] == state["version"] + 1
    assert get_state(client, state["id"]) == closed and account_of(client, state["id"])["status"] == "running"
    for call in (lambda: advance(client, closed, status=409), lambda: order(client, closed, status=409),
                 lambda: save(client, closed, status=409), lambda: close(client, closed, status=409)):
        assert call()["error"]["code"] == "session_closed"
    assert get_state(client, state["id"]) == closed


def test_close_without_a_body_is_allowed(client):
    assert close(client, create(client), version=None)["status"] == "closed"


# ---- imported settings, exports ------------------------------------------------------------------------------
def test_imported_timing_limits_survive_a_session_save_and_settings_export(client):
    imported = {"config": {"maxQuoteAgeMs": 45000, "maxOutcomeLatenessMs": 12000, "horizonMs": 300000}}
    settings = client.post("/v1/settings/normalize", json=imported).json()
    state = create(client, {"settings": settings})
    assert state["config"]["maxQuoteAgeMs"] == 45000 and state["config"]["maxOutcomeLatenessMs"] == 12000
    state = save(client, advance(client, state, count=10)["state"])["state"]
    exported = client.get(f"/v1/runs/{state['runId']}/settings").json()
    assert exported["config"]["maxQuoteAgeMs"] == 45000 and exported["config"]["maxOutcomeLatenessMs"] == 12000
    assert client.post("/v1/settings/normalize", json=exported).json() == exported
    assert exported["replay"] == settings["replay"]


GOLDEN_ACTIONS = ("finish-then-nothing-more-allowed", "manual-buy-and-sell-mix", "stop-loss-then-same-frame-buy-rejected")


@pytest.mark.parametrize("name", GOLDEN_ACTIONS)
def test_export_after_finish_and_save_equals_the_session_account_and_the_js_golden(client, name):
    case = json.loads((PARITY / "inputs" / "sample-sessions.json").read_text())
    scenario = next(s for s in case["scenarios"] if s["name"] == name)
    golden = json.loads((PARITY / "expected" / "sample-sessions.json").read_text())["scenarios"][name]
    state = create(client, {"settings": scenario["settings"]})
    for action in scenario["actions"]:
        payload = {k: v for k, v in action.items() if k != "op"}
        payload["expectedVersion"] = state["version"]
        response = client.post(f"/v1/sessions/{state['id']}/{'advance' if action['op'] == 'advance' else 'orders'}", json=payload)
        if response.status_code == 200:
            state = response.json()["state"]
    if state["status"] != "completed":
        state = advance(client, state, "finish")["state"]
    state = save(client, state)["state"]
    exported = client.get(f"/v1/runs/{state['runId']}/export").json()
    live = account_of(client, state["id"])
    assert exported["account"] == live and exported["summary"] == state["summary"]
    assert exported["id"] == state["runId"] and exported["status"] == "completed"
    assert exported["manualTradeCount"] == state["manualTradeCount"]
    assert diff(golden["final"]["account"], digest(exported["account"])) is None
    assert diff(golden["final"]["summary"], exported["summary"]) is None
    assert exported["hashes"]["configSha256"] == client.get(f"/v1/runs/{state['runId']}").json()["hashes"]["configSha256"]


def test_session_save_records_status_name_and_manual_count(client):
    state = create(client, {**SAMPLE, "name": "  my steps "})
    state = order(client, advance(client, state, count=3)["state"])["state"]
    saved = save(client, state)
    assert saved["run"]["status"] == "running" and saved["run"]["name"] == "my steps"
    assert saved["run"]["manualTradeCount"] == 1 and saved["run"]["id"] == state["runId"]
    state = saved["state"]
    assert state["savedVersion"] == state["version"] == 4
    renamed = save(client, state, name="renamed")
    assert renamed["run"]["name"] == "renamed" and renamed["state"]["savedVersion"] == 5
    assert advance(client, renamed["state"], "finish")["state"]["savedVersion"] == 5  # unsaved work is visible: savedVersion < version
    assert client.get("/v1/runs").json()["runs"][0]["status"] == "running"


def test_session_snapshots_persist_through_the_run_store(tmp_path):
    """Snapshots persist through the run store like any other run."""
    first = TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "x"))
    state = save(first, advance(first, create(first), count=5)["state"])["state"]
    second = TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "x"))
    record = second.get(f"/v1/runs/{state['runId']}/export").json()
    assert record["id"] == state["runId"] and record["account"]["lastFrameAt"] == state["currentFrame"]["time"]
    assert get_state(second, state["id"])["error"]["code"] == "session_not_found"  # sessions are in memory only
