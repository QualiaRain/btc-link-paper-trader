"""Live paper sessions: tick/order flows, stale and kind rules, ownership, completion, failed reads (fake market)."""
from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from paper_trail import live
from paper_trail.api import create_app
from paper_trail.canonical import sha256_canonical
from paper_trail.errors import ApiProblem
from paper_trail.records import RunStore
from paper_trail.sessions import SessionService
from test_live import MINUTE, FakeMarket, market  # noqa: F401  (fixture)

LIVE = {"settings": {"config": {"mode": "live", "horizonMs": 60000, "lookbackIntervals": 3, "durationMs": 1800000}}}


@pytest.fixture
def store(tmp_path):
    return RunStore(tmp_path / "runs")


@pytest.fixture
def client(store, tmp_path, market):
    return TestClient(create_app(store=store, web_dir=tmp_path / "no-web"))


def start(client, body=LIVE, status=201):
    response = client.post("/v1/sessions", json=body)
    assert response.status_code == status, response.text
    return response.json()


def tick(client, state, market=None, step_ms=20000, status=200, version=None):
    if market is not None:
        market.now += step_ms
    response = client.post(f"/v1/sessions/{state['id']}/tick", json={"expectedVersion": state["version"] if version is None else version})
    assert response.status_code == status, response.text
    return response.json()


def order(client, state, market=None, asset="BTC", side="buy", dollars=100, status=200, version=None, step_ms=5000):
    if market is not None:
        market.now += step_ms
    body = {"asset": asset, "side": side, "expectedVersion": state["version"] if version is None else version}
    if dollars is not None:
        body["dollars"] = dollars
    response = client.post(f"/v1/sessions/{state['id']}/orders", json=body)
    assert response.status_code == status, response.text
    return response.json()


def test_a_live_session_starts_from_a_fresh_server_side_frame(client, market, store):
    state = start(client)
    assert state["kind"] == "live" and state["status"] == "active" and state["version"] == 1
    assert state["cursor"] == 0 and state["frameCount"] == 1 and state["warmupFrameCount"] == 0
    assert state["scoreStart"] == market.now and state["scoreEnd"] == market.now + 1800000
    assert state["currentFrame"]["time"] == market.now and state["currentFrame"]["quotes"]["BTC"]["observedAt"] == market.now
    assert state["currentFrame"]["quotes"]["BTC"]["source"] == "Coinbase Exchange public ticker bid/ask"
    assert state["config"]["mode"] == "live" and state["nextDecisionAt"] == market.now + 60000
    assert store.owner_of(state["runId"]) == state["id"]
    default = start(client, {"settings": {"config": {"mode": "live"}}})  # default duration is 48 hours
    assert default["scoreEnd"] - default["scoreStart"] == 48 * 3600000


def test_a_live_session_refuses_supplied_candles(client):
    body = {**LIVE, "candles": {"BTC": [], "LINK": []}}
    error = client.post("/v1/sessions", json=body)
    assert error.status_code == 422 and error.json()["error"]["code"] == "replay_rejected"


def test_tick_fetches_ingests_and_exposes_only_the_latest_frame(client, market):
    state = start(client)
    first_requests = len(market.requests)
    step = tick(client, state, market)
    after = step["state"]
    assert len(market.requests) == first_requests + 4 and step["framesIngested"] == 1
    assert after["version"] == 2 and after["cursor"] == 1 and after["frameCount"] == 2
    assert after["currentFrame"]["time"] == market.now and all(e["time"] <= market.now for e in step["events"])
    account = client.get(f"/v1/sessions/{state['id']}/account").json()["account"]
    assert account["lastFrameAt"] == market.now and account["sequence"] == len(account["ledger"])
    assert [e["type"] for e in account["ledger"]][0] == "start"


def test_a_tick_after_a_long_pause_records_a_gap_and_invents_no_fills(client, market):
    state = start(client)
    gap = tick(client, state, market, step_ms=5 * MINUTE)
    assert any(e["type"] == "gap" and e["gapMs"] == 5 * MINUTE for e in gap["events"])
    assert not any(e["type"] == "trade" and e["actor"] == "manual" for e in gap["events"])


def test_history_is_trimmed_to_the_lookback_in_the_stored_market(client, market):
    state = start(client)
    state = tick(client, state, market)["state"]
    saved = client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": state["version"]}).json()
    record = client.get(f"/v1/runs/{saved['run']['id']}/export").json()
    frames = record["market"]["dataset"]["frames"]
    assert [len(f["history"]["BTC"]) for f in frames] == [4, 4] and len(frames) == 2
    assert record["market"]["kind"] == "live" and record["market"]["lastObservedFrame"] == frames[-1]
    assert record["hashes"]["marketSha256"] == sha256_canonical(record["market"])
    assert record["status"] == "running" and record["market"]["scoreStart"] == state["scoreStart"]
    exported = client.get(f"/v1/runs/{saved['run']['id']}/settings")
    assert exported.status_code == 200 and exported.json()["config"]["mode"] == "live"


def test_orders_ingest_a_fresh_frame_then_trade_at_it(client, market):
    state = start(client)
    traded = order(client, state, market)
    assert traded["framesIngested"] == 1 and traded["state"]["frameCount"] == 2 and traded["state"]["version"] == 2
    assert traded["state"]["currentFrame"]["time"] == market.now and traded["state"]["manualTradeCount"] == 1
    trade = [e for e in traded["events"] if e["type"] == "trade"][0]
    assert trade["actor"] == "manual" and trade["time"] == market.now and trade["cashDelta"] < 0
    sold = order(client, traded["state"], market, side="sell", dollars=None)
    assert sold["state"]["summary"]["perAsset"]["BTC"]["qty"] == 0


def test_rejected_live_orders_discard_the_fresh_frame_and_change_nothing(client, market):
    state = start(client)
    before = client.get(f"/v1/sessions/{state['id']}/account").json()
    for kwargs in ({"side": "sell", "dollars": None}, {"side": "buy", "dollars": None}, {"side": "buy", "dollars": 0},
                   {"side": "sell", "dollars": -1}):
        error = order(client, state, market, status=422, **kwargs)["error"]
        assert error["code"] == "order_rejected"
        assert client.get(f"/v1/sessions/{state['id']}/account").json() == before
    assert client.get(f"/v1/sessions/{state['id']}").json() == state


def test_failed_reads_are_a_502_that_changes_nothing(client, market):
    state = start(client)
    before = client.get(f"/v1/sessions/{state['id']}/account").json()
    broken = [{"status": 500, "json": {}}, {"status": 404, "json": {}}, {"text": "not json"}, {"status": 200, "json": {"x": 1}}]
    for path in ("/products/BTC-USD/candles?granularity=60", "/products/LINK-USD/ticker"):
        for failure in broken:
            market.fail[path] = failure
            for call in (lambda: tick(client, state, market, status=502),
                         lambda: order(client, state, market, status=502)):
                error = call()["error"]
                assert error["code"] == "live_unavailable" and error["message"]
                assert client.get(f"/v1/sessions/{state['id']}/account").json() == before
        market.fail.clear()
    market.ticker_age_ms = 130000  # an old last trade is refused, not traded on
    assert "stale or future exchange trade timestamp" in tick(client, state, market, status=502)["error"]["message"]
    market.ticker_age_ms = 800
    assert tick(client, state, market)["state"]["version"] == 2  # recovers on the next good read


def test_creation_with_a_failed_read_makes_no_session(client, market, store):
    market.fail["/products/LINK-USD/ticker"] = {"status": 500, "json": {}}
    error = client.post("/v1/sessions", json=LIVE)
    assert error.status_code == 502 and error.json()["error"]["code"] == "live_unavailable"
    assert store._owners == {}


def test_kinds_are_not_interchangeable(client, market):
    state = start(client)
    replay = client.post("/v1/sessions", json={"settings": {"config": {}}}).json()
    advance = client.post(f"/v1/sessions/{state['id']}/advance", json={"mode": "frames", "expectedVersion": 1})
    assert advance.status_code == 409 and advance.json()["error"]["code"] == "wrong_session_kind"
    wrong = client.post(f"/v1/sessions/{replay['id']}/tick", json={"expectedVersion": 1})
    assert wrong.status_code == 409 and wrong.json()["error"]["code"] == "wrong_session_kind"
    assert client.get(f"/v1/sessions/{state['id']}").json() == state and client.get(f"/v1/sessions/{replay['id']}").json() == replay


def test_stale_versions_are_409_without_fetching_or_changing_anything(client, market):
    state = tick(client, start(client), market)["state"]
    before = client.get(f"/v1/sessions/{state['id']}/account").json()
    requests = len(market.requests)
    calls = (lambda v: client.post(f"/v1/sessions/{state['id']}/tick", json={"expectedVersion": v}),
             lambda v: client.post(f"/v1/sessions/{state['id']}/orders", json={"asset": "BTC", "side": "buy", "dollars": 5, "expectedVersion": v}),
             lambda v: client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": v}),
             lambda v: client.request("DELETE", f"/v1/sessions/{state['id']}", json={"expectedVersion": v}))
    for call in calls:
        for wrong in (1, 3, 99):
            response = call(wrong)
            assert response.status_code == 409 and response.json()["error"]["code"] == "stale_session"
            assert response.json()["error"]["currentVersion"] == 2
    assert len(market.requests) == requests and client.get(f"/v1/sessions/{state['id']}/account").json() == before
    assert client.get("/v1/runs").json() == {"runs": []}


def test_the_session_completes_at_its_configured_duration(client, market):
    body = {"settings": {"config": {**LIVE["settings"]["config"], "durationMs": 300000}}}
    state = start(client, body)
    buy = order(client, state, market, dollars=100)["state"]
    assert buy["manualTradeCount"] == 1
    done = tick(client, buy, market, step_ms=300000)
    assert done["state"]["status"] == "completed" and done["state"]["nextDecisionAt"] is None
    assert [e["type"] for e in done["events"]][-2:] == ["trade", "complete"] and done["state"]["summary"]["perAsset"]["BTC"]["qty"] == 0
    for response in (client.post(f"/v1/sessions/{state['id']}/tick", json={"expectedVersion": done["state"]["version"]}),
                     client.post(f"/v1/sessions/{state['id']}/orders", json={"asset": "BTC", "side": "buy", "dollars": 5, "expectedVersion": done["state"]["version"]})):
        assert response.status_code == 409 and response.json()["error"]["code"] == "session_completed"
    requests = len(market.requests)
    saved = client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": done["state"]["version"]})
    assert saved.status_code == 200 and saved.json()["run"]["status"] == "completed" and len(market.requests) == requests


def test_run_ownership_saves_and_close_follow_the_replay_rules(client, market, store):
    state = start(client)
    state = tick(client, state, market)["state"]
    first = client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": state["version"]}).json()
    assert first["run"]["id"] == state["runId"] and first["state"]["savedVersion"] == first["state"]["version"] == 3
    stored = client.get(f"/v1/runs/{state['runId']}/export").json()
    record = {**json.loads(json.dumps(stored)), "id": state["runId"]}
    for query in ("", "?replace=true"):
        conflict = client.post(f"/v1/runs/import{query}", json=record)
        assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "run_owned"
    moved = tick(client, first["state"], market)["state"]
    assert client.get(f"/v1/runs/{state['runId']}/export").json() == stored  # the snapshot never changes by itself
    second = client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": moved["version"]}).json()
    assert second["run"]["createdAt"] == first["run"]["createdAt"] and len(client.get("/v1/runs").json()["runs"]) == 1
    closed = client.request("DELETE", f"/v1/sessions/{state['id']}", json={"expectedVersion": second["state"]["version"]})
    assert closed.status_code == 200 and closed.json()["status"] == "closed" and store.owner_of(state["runId"]) is None
    version = closed.json()["version"]
    requests = len(market.requests)
    for response in (client.post(f"/v1/sessions/{state['id']}/tick", json={"expectedVersion": version}),
                     client.post(f"/v1/sessions/{state['id']}/orders", json={"asset": "BTC", "side": "buy", "dollars": 5, "expectedVersion": version}),
                     client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": version}),
                     client.request("DELETE", f"/v1/sessions/{state['id']}", json={"expectedVersion": version})):
        assert response.status_code == 409 and response.json()["error"]["code"] == "session_closed"
    assert len(market.requests) == requests and client.get(f"/v1/runs/{state['runId']}").json()["account"]["lastFrameAt"] == market.now
    assert client.get(f"/v1/sessions/{state['id']}").json()["currentFrame"]["time"] == market.now  # readable after close


def test_two_live_sessions_never_share_a_run_id_and_unknown_ids_are_404(client, market):
    a, b = start(client), start(client)
    assert a["runId"] != b["runId"] and a["id"] != b["id"]
    response = client.post("/v1/sessions/nope/tick", json={"expectedVersion": 1})
    assert response.status_code == 404 and response.json()["error"]["code"] == "session_not_found"


def test_live_and_replay_sessions_share_the_capacity_cap(market, store):
    def fetch(horizon, lookback):
        return live.trim_live(live.fetch_live_market(horizon), lookback)

    service = SessionService(store, max_sessions=2, live_fetch=fetch)
    settings = {"config": {"mode": "live", "horizonMs": 60000, "lookbackIntervals": 3, "durationMs": 3600000}, "replay": {}}
    from paper_trail.configuration import normalize_settings
    live_settings = normalize_settings(settings)
    a = service.create(live_settings, None, None)
    b = service.create(normalize_settings({"config": {}}), None, None)
    with pytest.raises(ApiProblem) as full:
        service.create(live_settings, None, None)
    assert full.value.status == 429
    service.close(a["id"], None)
    c = service.create(live_settings, None, None)  # evicts the closed live session
    assert c["kind"] == "live" and store.owner_of(a["runId"]) is None
    with pytest.raises(ApiProblem):
        service.get(a["id"])
    assert service.get(b["id"])["kind"] != "live"


def test_concurrent_ticks_with_the_same_version_have_one_winner(market, store, tmp_path):
    app = create_app(store=store, web_dir=tmp_path / "x")
    state = start(TestClient(app))
    market.now += 1000
    n = 12
    barrier = threading.Barrier(n)

    def call(_):
        client = TestClient(app)
        barrier.wait()
        return client.post(f"/v1/sessions/{state['id']}/tick", json={"expectedVersion": 1})

    with ThreadPoolExecutor(max_workers=n) as pool:
        results = list(pool.map(call, range(n)))
    assert sorted(r.status_code for r in results) == [200] + [409] * (n - 1)
    assert all(r.json()["error"]["currentVersion"] == 2 for r in results if r.status_code == 409)
    assert TestClient(app).get(f"/v1/sessions/{state['id']}").json()["frameCount"] == 2  # ingested exactly once
