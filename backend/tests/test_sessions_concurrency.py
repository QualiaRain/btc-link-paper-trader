"""Concurrent calls on one session serialize; the stale losers get a 409 and nothing is applied twice."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from paper_trail.api import create_app
from paper_trail.records import RunStore
from test_sessions import SAMPLE, account_of, create, get_state

N = 16


def race(app, calls):
    """Run each call in its own thread with its own client, released together."""
    barrier = threading.Barrier(len(calls))

    def run(call):
        client = TestClient(app)
        barrier.wait()
        return call(client)

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        return list(pool.map(run, calls))


def test_concurrent_advances_with_the_same_version_have_exactly_one_winner(tmp_path):
    app = create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "x")
    client = TestClient(app)
    for _ in range(4):
        state = create(client)
        sid = state["id"]
        results = race(app, [lambda c: c.post(f"/v1/sessions/{sid}/advance", json={"mode": "frames", "count": 3, "expectedVersion": 1})] * N)
        codes = sorted(r.status_code for r in results)
        assert codes == [200] + [409] * (N - 1)
        for r in results:
            if r.status_code == 409:
                assert r.json()["error"] == {"code": "stale_session", "message": r.json()["error"]["message"], "currentVersion": 2}
        after = get_state(client, sid)
        assert after["version"] == 2 and after["cursor"] == state["cursor"] + 3  # applied exactly once


def test_concurrent_mixed_mutations_serialize(tmp_path):
    app = create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "x")
    client = TestClient(app)
    state = create(client)
    sid = state["id"]
    calls = [lambda c: c.post(f"/v1/sessions/{sid}/advance", json={"mode": "frames", "expectedVersion": 1}),
             lambda c: c.post(f"/v1/sessions/{sid}/orders", json={"asset": "BTC", "side": "buy", "dollars": 50, "expectedVersion": 1}),
             lambda c: c.post(f"/v1/sessions/{sid}/save", json={"expectedVersion": 1}),
             lambda c: c.request("DELETE", f"/v1/sessions/{sid}", json={"expectedVersion": 1})] * 3
    results = race(app, calls)
    assert sorted(r.status_code for r in results) == [200] + [409] * (len(calls) - 1)
    assert get_state(client, sid)["version"] == 2


def test_a_chain_of_concurrent_clients_advances_each_step_exactly_once(tmp_path):
    """Optimistic concurrency: clients retry on stale; the total progress equals the number of successes."""
    app = create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "x")
    client = TestClient(app)
    state = create(client)
    sid, wins = state["id"], []

    def worker(c):
        for _ in range(5):
            while True:
                current = c.get(f"/v1/sessions/{sid}").json()
                r = c.post(f"/v1/sessions/{sid}/advance", json={"mode": "frames", "expectedVersion": current["version"]})
                if r.status_code == 200:
                    wins.append(r.json()["state"]["version"])
                    break
                assert r.status_code == 409 and r.json()["error"]["code"] == "stale_session"

    race(app, [worker] * 6)
    final = get_state(client, sid)
    assert len(wins) == 30 and sorted(wins) == list(range(2, 32))
    assert final["version"] == 31 and final["cursor"] == state["cursor"] + 30
    account = account_of(client, sid)
    assert account["lastFrameAt"] == final["currentFrame"]["time"]


def test_different_sessions_progress_independently(tmp_path):
    app = create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "x")
    client = TestClient(app)
    states = [create(client) for _ in range(8)]
    results = race(app, [(lambda c, s=s: c.post(f"/v1/sessions/{s['id']}/advance", json={"mode": "frames", "count": 5, "expectedVersion": 1})) for s in states])
    assert all(r.status_code == 200 for r in results)
    assert {get_state(client, s["id"])["cursor"] for s in states} == {states[0]["cursor"] + 5}
