"""Sessions that name a candle job: real HTTP retrieval from a loopback fake exchange, then stepwise replay whose
snapshots carry browser-format fetched evidence (verified with the existing history.js, never the future)."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from paper_trail.api import create_app
from paper_trail.candles import BASE_URL_ENV
from paper_trail.records import RunStore

from test_candle_jobs import wait_for
from test_candle_jobs import servers  # noqa: F401  (fixture)
from test_candle_job_replays import JOB, SETTINGS, completed_job

ROOT = Path(__file__).resolve().parents[2]
needs_node = pytest.mark.skipif(not shutil.which("node"), reason="node is needed to run history.js")


@pytest.fixture
def api(servers, monkeypatch, tmp_path):  # noqa: F811
    server = servers()
    monkeypatch.setenv(BASE_URL_ENV, server.base)
    store = RunStore(tmp_path / "runs")
    return TestClient(create_app(store=store, web_dir=tmp_path / "none")), store, server


def verify(record: dict) -> dict:
    out = subprocess.run(["node", str(Path(__file__).parent / "js" / "verify_record.mjs")], input=json.dumps(record),
                         capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def post(client, path, body):
    response = client.post(path, json=body)
    assert response.status_code == 200, response.text
    return response.json()


@needs_node
def test_partial_and_finished_snapshots_of_a_job_session_verify_with_history_js(api):
    client, store, _ = api
    job = completed_job(client)
    created = client.post("/v1/sessions", json={"settings": SETTINGS, "candleJobId": job["id"]})
    assert created.status_code == 201, created.text
    state = created.json()
    assert state["kind"] == "historical" and store.owner_of(state["runId"]) == state["id"]
    state = post(client, f"/v1/sessions/{state['id']}/advance", {"mode": "frames", "count": 9, "expectedVersion": 1})["state"]
    state = post(client, f"/v1/sessions/{state['id']}/save", {"expectedVersion": state["version"]})["state"]
    partial = client.get(f"/v1/runs/{state['runId']}/export").json()
    checked = verify(partial)
    assert checked["configHashOk"] and checked["marketHashOk"] and checked["historyRestored"]
    assert checked["futureFrames"] == 0 and checked["frameCount"] == checked["cursor"] + 1 == 10
    assert checked["lastFrameAt"] == state["currentFrame"]["time"]
    assert partial["market"]["dataset"]["historyEncoding"] == "history-catalog-v1" and partial["status"] == "running"
    assert len(partial["market"]["dataset"]["provenance"]) == len(job["receipts"])
    # Finish and save again: the complete evidence equals what a one-shot replay of the same job stores.
    state = post(client, f"/v1/sessions/{state['id']}/advance", {"mode": "finish", "expectedVersion": state["version"]})["state"]
    state = post(client, f"/v1/sessions/{state['id']}/save", {"expectedVersion": state["version"]})["state"]
    done = client.get(f"/v1/runs/{state['runId']}/export").json()
    checked = verify(done)
    assert checked["configHashOk"] and checked["marketHashOk"] and checked["futureFrames"] == 0
    assert checked["cursor"] == checked["frameCount"] - 1 and done["status"] == "completed"
    one_shot = client.post("/v1/replays", json={"settings": SETTINGS, "candleJobId": job["id"]}).json()
    assert done["hashes"]["marketSha256"] == one_shot["run"]["hashes"]["marketSha256"]
    assert done["account"]["ledger"] == one_shot["account"]["ledger"]


def test_a_job_session_equals_a_session_from_the_same_inline_candles(api):
    client, _, _ = api
    job = completed_job(client)
    fetched = client.app.state.candle_jobs.resolve(job["id"], client.post("/v1/settings/normalize", json=SETTINGS).json())
    via_job = client.post("/v1/sessions", json={"settings": SETTINGS, "candleJobId": job["id"]}).json()
    inline = client.post("/v1/sessions", json={"settings": SETTINGS, "candles": fetched.candles()}).json()
    for state in (via_job, inline):
        post(client, f"/v1/sessions/{state['id']}/advance", {"mode": "finish", "expectedVersion": 1})
    assert client.get(f"/v1/sessions/{via_job['id']}/account").json()["account"]["ledger"] == \
        client.get(f"/v1/sessions/{inline['id']}/account").json()["account"]["ledger"]


def test_job_misuse_surfaces_its_code_and_creates_no_session_or_claim(api, servers, monkeypatch):  # noqa: F811
    client, store, _ = api
    job = completed_job(client)

    def refused(body, status):
        response = client.post("/v1/sessions", json=body)
        assert response.status_code == status, response.text
        assert store._owners == {}  # no run id was claimed
        return response.json()["error"]["code"]

    assert refused({"settings": SETTINGS, "candleJobId": "nope"}, 404) == "job_not_found"
    assert refused({"settings": SETTINGS, "candleJobId": job["id"], "candles": {"BTC": [], "LINK": []}}, 422) == "invalid_request"
    assert refused({"settings": {"config": {}}, "candleJobId": job["id"]}, 422) == "invalid_request"
    other = {**SETTINGS, "config": {"horizonMs": 300000, "lookbackIntervals": 9}}
    assert refused({"settings": other, "candleJobId": job["id"]}, 422) == "job_mismatch"
    live = {"settings": {"config": {"mode": "live"}}, "candleJobId": job["id"]}
    assert refused(live, 422) == "replay_rejected"


def test_a_job_that_is_still_running_is_not_ready(servers, monkeypatch, tmp_path):  # noqa: F811
    slow = servers(lambda i, a, s, e: (200, "[]", 2))
    monkeypatch.setenv(BASE_URL_ENV, slow.base)
    store = RunStore(tmp_path / "runs")
    client = TestClient(create_app(store=store, web_dir=tmp_path / "none"))
    created = client.post("/v1/candle-jobs", json=JOB)
    assert created.status_code == 202
    response = client.post("/v1/sessions", json={"settings": SETTINGS, "candleJobId": created.json()["id"]})
    assert response.status_code == 409 and response.json()["error"]["code"] == "job_not_ready"
    assert store._owners == {}
