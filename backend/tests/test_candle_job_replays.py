"""Replays that name a candle job: real HTTP candle retrieval from a loopback fake Coinbase server, then a replay
whose evidence carries the retrieval receipts; verified with the existing history.js."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from paper_trail.api import create_app
from paper_trail.candles import BASE_URL_ENV
from paper_trail.configuration import normalize_settings
from paper_trail.records import RunStore

from test_candle_jobs import wait_for
from test_candle_jobs import servers  # noqa: F401  (fixture)

ROOT = Path(__file__).resolve().parents[2]
START, END = "2024-03-09T12:00", "2024-03-09T12:30"
SETTINGS = {"config": {"horizonMs": 300000, "lookbackIntervals": 7}, "replay": {"source": "range", "start": START, "end": END, "halfSpreadBps": 2}}
JOB = {"start": START, "end": END, "lookbackIntervals": 7, "model": "trend"}


@pytest.fixture
def api(servers, monkeypatch, tmp_path):  # noqa: F811
    server = servers()
    monkeypatch.setenv(BASE_URL_ENV, server.base)
    return TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "none")), server


def completed_job(client, **override):
    created = client.post("/v1/candle-jobs", json={**JOB, **override})
    assert created.status_code == 202, created.text
    job = wait_for(lambda: (j := client.get(f"/v1/candle-jobs/{created.json()['id']}").json())["status"] != "running" and j, timeout=20)
    assert job["status"] == "completed", job
    return job


def test_replay_from_a_candle_job_stores_fetched_evidence_with_receipts(api):
    client, server = api
    job = completed_job(client)
    replay = client.post("/v1/replays", json={"settings": SETTINGS, "candleJobId": job["id"]})
    assert replay.status_code == 200, replay.text
    body = replay.json()
    assert body["summary"]["status"] == "completed" and body["account"]["startedAt"] == 1709985600000
    record = client.get(f"/v1/runs/{body['run']['id']}/export").json()
    dataset = record["market"]["dataset"]
    assert dataset["historyEncoding"] == "history-catalog-v1"
    assert len(dataset["provenance"]) == len(job["receipts"]) and len(job["receipts"]) == len(server.requests)
    assert {p["sha256"] for p in dataset["provenance"]} == {r["sha256"] for r in job["receipts"]}
    if shutil.which("node"):
        out = subprocess.run(["node", str(Path(__file__).parent / "js" / "verify_record.mjs")], input=json.dumps(record),
                             capture_output=True, text=True, cwd=ROOT, timeout=120)
        checked = json.loads(out.stdout)
        assert checked["configHashOk"] and checked["marketHashOk"] and checked["historyRestored"]
        assert checked["cursor"] == checked["frameCount"] - 1 and checked["futureFrames"] == 0


def test_job_replay_equals_the_same_replay_from_inline_candles(api):
    client, _ = api
    job = completed_job(client)
    via_job = client.post("/v1/replays", json={"settings": SETTINGS, "candleJobId": job["id"]}).json()
    # The same candles supplied inline give the same account (only the evidence block differs).
    fetched = client.app.state.candle_jobs.resolve(job["id"], normalize_settings(SETTINGS, check_range_end=False))
    inline = client.post("/v1/replays", json={"settings": SETTINGS, "candles": {a: fetched.candles()[a] for a in ("BTC", "LINK")}}).json()
    assert via_job["summary"] == inline["summary"]
    assert via_job["account"]["ledger"] == inline["account"]["ledger"]


def test_candle_job_misuse_is_refused_with_specific_codes(api):
    client, _ = api
    job = completed_job(client)

    def code(payload, status):
        response = client.post("/v1/replays", json=payload)
        assert response.status_code == status, response.text
        return response.json()["error"]["code"]

    assert code({"settings": SETTINGS, "candleJobId": "nope"}, 404) == "job_not_found"
    assert code({"settings": SETTINGS, "candleJobId": job["id"], "candles": {"BTC": [], "LINK": []}}, 422) == "invalid_request"
    assert code({"settings": {"config": {}}, "candleJobId": job["id"]}, 422) == "invalid_request"          # sample source
    other = {**SETTINGS, "config": {"horizonMs": 300000, "lookbackIntervals": 9}}
    assert code({"settings": other, "candleJobId": job["id"]}, 422) == "job_mismatch"
    assert client.get("/v1/runs").json() == {"runs": []}                                                        # nothing created
