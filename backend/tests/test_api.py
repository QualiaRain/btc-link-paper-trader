"""Behaviour of the /v1 API through its real HTTP interface (in-process ASGI)."""
from __future__ import annotations

import copy
import json

from paper_trail.api import create_app
from paper_trail.records import RunStore
from fastapi.testclient import TestClient

SAMPLE = {"settings": {"config": {}}}


def test_health_and_defaults_preserve_documented_defaults(client):
    health = client.get("/v1/health").json()
    assert health == {"status": "ok", "apiVersion": "1", "engine": "paper-trail-python", "realTrading": False}
    defaults = client.get("/v1/defaults").json()
    c = defaults["settings"]["config"]
    assert (c["initialCash"], c["horizonMs"], c["lookbackIntervals"], c["bufferBps"], c["allocationFraction"],
            c["stopLossBps"], c["feeBps"], c["slippageBps"], c["model"]) == (1000, 420000, 7, 10, 0.5, 0, 10, 2, "trend")
    assert defaults["settings"]["replay"] == {"source": "sample", "start": "", "end": "", "halfSpreadBps": 2}
    assert defaults["horizonsMs"] == [60000, 300000, 420000, 900000, 3600000, 25200000, 86400000]


def test_replay_runs_saves_and_exports_results_and_settings(client):
    response = client.post("/v1/replays", json={**SAMPLE, "name": "first run"})
    assert response.status_code == 200
    body = response.json()
    run, summary, account = body["run"], body["summary"], body["account"]
    assert run["name"] == "first run" and run["status"] == "completed"
    assert summary["status"] == "completed" and summary["cashBenchmark"] == 1000
    assert account["config"]["initialCash"] == 1000 and account["status"] == "completed"
    assert account["positions"]["BTC"]["qty"] == 0 and account["positions"]["LINK"]["qty"] == 0  # closed on the final frame
    assert summary["settledForecasts"] > 0 and summary["buyHoldEquity"] > 0
    # Stored in history.
    assert [r["id"] for r in client.get("/v1/runs").json()["runs"]] == [run["id"]]
    record = client.get(f"/v1/runs/{run['id']}").json()
    assert record["format"] == "paper-trail-run-v2" and record["summary"] == summary
    # Results export is the full record, downloadable, with hashes.
    export = client.get(f"/v1/runs/{run['id']}/export")
    assert export.status_code == 200 and "attachment" in export.headers["content-disposition"]
    exported = export.json()
    assert exported["id"] == run["id"] and exported["hashes"]["configSha256"] == run["hashes"]["configSha256"]
    assert exported["account"]["ledger"] == record["account"]["ledger"]
    # Settings export round-trips through normalization and freezes the replay duration.
    settings = client.get(f"/v1/runs/{run['id']}/settings").json()
    assert settings["format"] == "paper-trail-settings-v2" and settings["config"]["durationMs"] == account["config"]["durationMs"]
    assert client.post("/v1/settings/normalize", json=settings).json() == settings


def test_configurable_horizon_risk_and_costs_change_the_result(client):
    base = client.post("/v1/replays", json=SAMPLE).json()["summary"]
    costly = client.post("/v1/replays", json={"settings": {"config": {
        "initialCash": 2500, "horizonMs": 900000, "lookbackIntervals": 20, "feeBps": 40, "slippageBps": 15,
        "bufferBps": 5, "stopLossBps": 150, "allocationFraction": 0.25}, "replay": {"halfSpreadBps": 4}}}).json()
    assert costly["account"]["config"]["initialCash"] == 2500 and costly["account"]["config"]["horizonMs"] == 900000
    assert costly["summary"]["cashBenchmark"] == 2500 and costly["summary"]["equity"] != base["equity"]
    trade_sources = {e["source"] for e in costly["account"]["ledger"] if e["type"] == "trade"}
    assert trade_sources == {"Historical Coinbase candle close with ASSUMED 4 bps half-spread"}


def test_imported_timing_limits_survive_settings_round_trips(client):
    """Regression for the browser fix that stopped the settings form from resetting imported timing limits."""
    imported = {"config": {"maxQuoteAgeMs": 45000, "maxOutcomeLatenessMs": 12000, "horizonMs": 300000}}
    normalized = client.post("/v1/settings/normalize", json=imported).json()
    assert normalized["config"]["maxQuoteAgeMs"] == 45000 and normalized["config"]["maxOutcomeLatenessMs"] == 12000
    run = client.post("/v1/replays", json={"settings": normalized}).json()
    assert run["account"]["config"]["maxQuoteAgeMs"] == 45000 and run["account"]["config"]["maxOutcomeLatenessMs"] == 12000
    exported = client.get(f"/v1/runs/{run['run']['id']}/settings").json()
    assert exported["config"]["maxQuoteAgeMs"] == 45000 and exported["config"]["maxOutcomeLatenessMs"] == 12000
    assert client.post("/v1/settings/normalize", json=exported).json() == exported


def test_invalid_requests_get_a_stable_error_shape(client):
    def error(payload, status=422):
        response = client.post("/v1/replays", json=payload)
        assert response.status_code == status and set(response.json()) == {"error"}
        return response.json()["error"]

    assert error({"settings": {"config": {"feeBp": 1}}}) == {"code": "invalid_request", "message": "Unknown configuration field: feeBp"}
    assert "initialCash: must be a finite number" in error({"settings": {"config": {"initialCash": "1000"}}})["message"]
    assert error({"settings": {"config": {"horizonMs": 1234}}}) == {"code": "replay_rejected", "message": "Choose one of the supported forecast horizons."}
    assert "allocationFraction" in error({"settings": {"config": {"allocationFraction": 0.51}}})["message"]
    assert error({"settings": {"config": {"mode": "live"}}}) == {  # replay only: no live polling, no orders
        "code": "replay_rejected", "message": "Only replay mode is supported by this service"}
    assert error({"settings": {"config": {}, "replay": {"source": "range", "start": "2024-03-09T12:00", "end": "2024-03-09T13:00"}}}) == {
        "code": "replay_rejected", "message": "A date-range replay needs candles for BTC and LINK"}
    missing = client.get("/v1/runs/does-not-exist")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "run_not_found"
    assert client.get("/v1/runs/x/settings").status_code == 404 and client.get("/v1/runs/x/export").status_code == 404


def test_date_range_replay_with_supplied_candles_and_causal_warmup(client):
    start = 1709985600000  # 2024-03-09T12:00Z
    step = 60000

    def series(first, last, base):
        return [{"time": t, "price": base + (t - start) / step * 0.01} for t in range(first, last + 1, step)]

    settings = {"config": {"horizonMs": 300000}, "replay": {"source": "range", "start": "2024-03-09T12:00",
                                                           "end": "2024-03-09T13:00", "halfSpreadBps": 2}}
    ok = client.post("/v1/replays", json={"settings": settings, "candles": {
        "BTC": series(start - 90 * step, start + 60 * step, 60000), "LINK": series(start - 90 * step, start + 60 * step, 19)}})
    assert ok.status_code == 200
    account = ok.json()["account"]
    assert account["startedAt"] == start and account["endsAt"] == start + 60 * step
    # Warmup supplies history but never earns returns: nothing is scored before the start.
    assert min(e["time"] for e in account["ledger"]) == start
    # LINK has too little causal warmup: the whole run is refused rather than silently skipping one asset.
    short = client.post("/v1/replays", json={"settings": settings, "candles": {
        "BTC": series(start - 90 * step, start + 60 * step, 60000), "LINK": series(start - 3 * step, start + 60 * step, 19)}})
    assert short.status_code == 422 and short.json()["error"]["message"].startswith("LINK: only 4 causal observations")
    # A missing exact boundary fails too.
    gap = series(start - 90 * step, start + 60 * step, 19)
    del gap[-1]
    refused = client.post("/v1/replays", json={"settings": settings, "candles": {"BTC": series(start - 90 * step, start + 60 * step, 1), "LINK": gap}})
    assert refused.status_code == 422 and "Exact start/end close missing" in refused.json()["error"]["message"]
    assert len(client.get("/v1/runs").json()["runs"]) == 1  # refused requests create no run


def test_candle_input_is_validated(client):
    settings = {"config": {"horizonMs": 60000}, "replay": {"source": "range", "start": "2024-03-09T12:00", "end": "2024-03-09T12:10"}}
    start = 1709985600000
    good = [{"time": start + i * 60000, "price": 10.0} for i in range(-70, 11)]
    for bad_rows, fragment in (([{"time": start + 5, "price": 1}], "UTC minute-close"),
                               ([{"time": start, "price": -1}], "invalid candle values"),
                               ([{"time": start, "price": 1}, {"time": start, "price": 2}], "conflicting duplicate")):
        response = client.post("/v1/replays", json={"settings": settings, "candles": {"BTC": bad_rows, "LINK": good}})
        assert response.status_code == 422 and fragment in response.json()["error"]["message"], response.json()
    assert client.post("/v1/replays", json={"settings": settings, "candles": {"BTC": good}}).status_code == 422


def test_runs_persist_across_service_restarts(tmp_path):
    first = TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "x"))
    run_id = first.post("/v1/replays", json=SAMPLE).json()["run"]["id"]
    second = TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "x"))
    assert [r["id"] for r in second.get("/v1/runs").json()["runs"]] == [run_id]
    assert second.get(f"/v1/runs/{run_id}/export").json()["id"] == run_id


def test_browser_exported_runs_import_and_re_export_unchanged(client, browser_completed, browser_partial):
    for fixture in (browser_completed, browser_partial):
        imported = client.post("/v1/runs/import", json=fixture)
        assert imported.status_code == 200, imported.text
        meta = imported.json()
        assert meta["id"] == fixture["id"] and meta["summary"]["equity"] == fixture["summary"]["equity"]
        assert meta["manualTradeCount"] == fixture["manualTradeCount"]
        # The imported run is stored verbatim: a re-export carries the original evidence hashes and ledger.
        again = client.get(f"/v1/runs/{fixture['id']}/export").json()
        assert again["hashes"] == fixture["hashes"] and again["account"]["ledger"] == fixture["account"]["ledger"]
        assert again["market"] == fixture["market"]
    assert {r["id"] for r in client.get("/v1/runs").json()["runs"]} == {browser_completed["id"], browser_partial["id"]}
    assert client.get(f"/v1/runs/{browser_partial['id']}").json()["manualTradeCount"] == 1
    # Imported settings still export for reuse in a new Python run.
    settings = client.get(f"/v1/runs/{browser_completed['id']}/settings").json()
    assert settings["config"]["lookbackIntervals"] == 7 and settings["replay"]["halfSpreadBps"] == 0.5


def test_browser_live_session_snapshots_import_but_the_service_only_replays(client, browser_live):
    meta = client.post("/v1/runs/import", json=browser_live)
    assert meta.status_code == 200 and meta.json()["config"]["mode"] == "live"
    assert client.get(f"/v1/runs/{browser_live['id']}").json()["account"]["config"]["mode"] == "live"
    assert client.get(f"/v1/runs/{browser_live['id']}/export").json()["hashes"] == browser_live["hashes"]
    exported = client.get(f"/v1/runs/{browser_live['id']}/settings")  # regression: this used to be a 500
    assert exported.status_code == 200 and exported.json()["config"]["mode"] == "live"
    assert client.post("/v1/settings/normalize", json=exported.json()).status_code == 200
    assert client.post("/v1/replays", json={"settings": exported.json()}).status_code == 422  # but it cannot be replayed here


def test_import_rejects_tampered_or_incomplete_records(client, browser_completed):
    def post(record):
        return client.post("/v1/runs/import", json=record)

    tampered = copy.deepcopy(browser_completed)
    tampered["account"]["cash"] += 1
    assert "summary does not match" in post(tampered).json()["error"]["message"]
    config = copy.deepcopy(browser_completed)
    config["config"]["feeBps"] = 99
    assert "config hash" in post(config).json()["error"]["message"]
    market = copy.deepcopy(browser_completed)
    market["market"]["scoreEnd"] += 1
    assert "market hash" in post(market).json()["error"]["message"]
    wrong_format = {**browser_completed, "format": "paper-trail-run-v1"}
    assert post(wrong_format).status_code == 422
    assert post({**browser_completed, "id": "../escape"}).status_code == 422
    assert post({"format": "paper-trail-run-v2"}).status_code == 422
    assert client.get("/v1/runs").json() == {"runs": []}  # nothing was stored


def test_reimport_is_idempotent_and_never_silently_overwrites(client, browser_completed):
    assert client.post("/v1/runs/import", json=browser_completed).status_code == 200
    assert client.post("/v1/runs/import", json=browser_completed).status_code == 200  # identical: no-op
    first = client.get("/v1/runs").json()["runs"][0]
    newer = {**browser_completed, "createdAt": "2030-01-01T00:00:00.000Z", "updatedAt": "2030-01-01T00:00:00.000Z"}
    conflict = client.post("/v1/runs/import", json=newer)
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "run_exists"
    assert client.get("/v1/runs").json()["runs"][0]["updatedAt"] == first["updatedAt"]
    replaced = client.post("/v1/runs/import?replace=true", json=newer)
    runs = client.get("/v1/runs").json()["runs"]
    assert replaced.status_code == 200 and len(runs) == 1
    assert runs[0]["createdAt"] == browser_completed["createdAt"] and runs[0]["updatedAt"] == "2030-01-01T00:00:00.000Z"


def test_import_never_replaces_a_python_run_without_consent(client, browser_completed):
    python_run = client.post("/v1/replays", json=SAMPLE).json()["run"]["id"]
    before = client.get(f"/v1/runs/{python_run}/export").json()
    clash = client.post("/v1/runs/import", json={**browser_completed, "id": python_run})
    assert clash.status_code == 409
    assert client.get(f"/v1/runs/{python_run}/export").json() == before


def test_service_never_exposes_trading_or_credentials(client):
    paths = set(client.get("/openapi.json").json()["paths"])
    assert all(p.startswith("/v1/") for p in paths)
    assert not any(word in p for p in paths for word in ("order", "trade", "key", "wallet", "auth"))
    assert json.dumps(client.get("/openapi.json").json()).count("password") == 0
