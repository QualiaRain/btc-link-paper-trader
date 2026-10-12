"""Run evidence wired to the browser's saved-run format, checked against the EXISTING history.js (via node)."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
JS = Path(__file__).parent / "js"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to run the existing JavaScript")

SETTINGS = [
    {"config": {}},
    {"config": {"lookbackIntervals": 20, "horizonMs": 900000, "feeBps": 25}, "replay": {"source": "sample", "halfSpreadBps": 3.5}},
]


def node(script, arg=None, stdin=None):
    out = subprocess.run(["node", str(JS / script), *([arg] if arg else [])], input=stdin, capture_output=True,
                         text=True, cwd=ROOT, timeout=120)
    assert out.returncode == 0, out.stderr[-800:]
    return json.loads(out.stdout)


@pytest.mark.parametrize("settings", SETTINGS)
def test_complete_sample_replay_market_hash_equals_the_browsers(client, settings):
    run = client.post("/v1/replays", json={"settings": settings}).json()["run"]
    expected = node("market_hash.mjs", json.dumps(settings))
    assert run["hashes"]["marketSha256"] == expected["marketSha256"]
    assert run["hashes"]["configSha256"] == expected["configSha256"]
    record = client.get(f"/v1/runs/{run['id']}/export").json()
    assert record["market"]["cursor"] == expected["cursor"]
    assert record["market"]["dataset"]["historyEncoding"] == "history-catalog-v1"


def test_python_record_validates_and_opens_with_the_existing_history_js(client):
    run_id = client.post("/v1/replays", json={"settings": {"config": {}}}).json()["run"]["id"]
    text = client.get(f"/v1/runs/{run_id}/export").text
    checked = node("verify_record.mjs", stdin=text)
    assert checked["configHashOk"] and checked["marketHashOk"] and checked["historyRestored"]
    assert checked["cursor"] == checked["frameCount"] - 1 and checked["lastObservedAt"] == checked["lastFrameAt"]
    assert checked["lastObservedAt"] == checked["scoreEnd"] and checked["futureFrames"] == 0


def test_partial_session_snapshot_carries_no_future_frames(client):
    state = client.post("/v1/sessions", json={"settings": {"config": {}}}).json()
    stepped = client.post(f"/v1/sessions/{state['id']}/advance",
                          json={"mode": "frames", "count": 12, "expectedVersion": state["version"]}).json()["state"]
    saved = client.post(f"/v1/sessions/{state['id']}/save", json={"expectedVersion": stepped["version"]}).json()
    text = client.get(f"/v1/runs/{saved['run']['id']}/export").text
    checked = node("verify_record.mjs", stdin=text)
    assert checked["configHashOk"] and checked["marketHashOk"]
    assert checked["futureFrames"] == 0 and checked["frameCount"] == stepped["cursor"] + 1
    assert checked["lastObservedAt"] == stepped["currentFrame"]["time"] and checked["cursor"] == stepped["cursor"]
    assert checked["scoreEnd"] == stepped["scoreEnd"]            # the declared range is kept; later frames are not
    # later frames' prices are absent from the export entirely
    later = json.loads(text)["market"]["dataset"]["historyCatalog"]["BTC"]
    assert max(row["time"] for row in later) <= stepped["currentFrame"]["time"]
