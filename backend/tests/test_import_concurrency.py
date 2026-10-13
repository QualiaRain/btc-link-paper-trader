"""Concurrent imports of the same id must not both succeed when replace is false."""
from __future__ import annotations

import copy
import os
import threading
import time

import pytest
from fastapi.testclient import TestClient

from paper_trail.api import create_app
from paper_trail.records import RunStore


def variant(record, n):
    """A different, internally consistent record with the same id (the summary is unchanged)."""
    other = copy.deepcopy(record)
    other["name"] = f"{record['name']} variant {n}"
    other["updatedAt"] = f"2031-01-0{n}T00:00:00.000Z"
    return other


def post_concurrently(app, records, query=""):
    """POST all records at the same time, each from its own thread and client."""
    start = threading.Barrier(len(records))
    out = [None] * len(records)

    def go(i):
        client = TestClient(app)
        start.wait(timeout=10)
        out[i] = client.post(f"/v1/runs/import{query}", json=records[i])

    threads = [threading.Thread(target=go, args=(i,)) for i in range(len(records))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert all(r is not None for r in out), "a request did not finish"
    return out


class CheckThenActGate(RunStore):
    """Forces the interleaving behind the reported race: every reader of an absent id is held
    until two readers have seen it absent, so both observe 'no existing record' before either writes.
    An atomic store never needs a separate read, so this gate is never reached by the fixed code."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._gate = threading.Barrier(2, timeout=1.0)

    def get(self, run_id):
        found = super().get(run_id)
        if found is None:
            try:
                self._gate.wait()
            except threading.BrokenBarrierError:
                pass  # only one reader arrived: nothing to force
        return found


def test_two_different_imports_of_a_new_id_cannot_both_succeed(tmp_path, browser_completed):
    app = create_app(store=CheckThenActGate(tmp_path / "runs"), web_dir=tmp_path / "no-web")
    a, b = variant(browser_completed, 1), variant(browser_completed, 2)
    responses = post_concurrently(app, [a, b])
    assert sorted(r.status_code for r in responses) == [200, 409], [r.text[:200] for r in responses]
    loser = next(r for r in responses if r.status_code == 409)
    assert loser.json()["error"]["code"] == "run_exists"
    winner = responses[[r.status_code for r in responses].index(200)]
    stored = TestClient(app).get(f"/v1/runs/{browser_completed['id']}").json()
    assert stored["name"] == winner.json()["name"]  # the stored run is the one that returned 200


def test_identical_concurrent_imports_stay_idempotent(tmp_path, browser_completed):
    app = create_app(store=CheckThenActGate(tmp_path / "runs"), web_dir=tmp_path / "no-web")
    responses = post_concurrently(app, [browser_completed, copy.deepcopy(browser_completed)])
    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    assert len(TestClient(app).get("/v1/runs").json()["runs"]) == 1


def test_replace_true_still_overwrites(tmp_path, browser_completed):
    app = create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "no-web")
    first = TestClient(app).post("/v1/runs/import", json=variant(browser_completed, 1))
    second = post_concurrently(app, [variant(browser_completed, 2), variant(browser_completed, 3)], "?replace=true")
    assert first.status_code == 200 and [r.status_code for r in second] == [200, 200]
    assert TestClient(app).get(f"/v1/runs/{browser_completed['id']}").json()["name"] in {r.json()["name"] for r in second}


def test_stress_many_ids_exactly_one_winner_each(tmp_path, browser_completed, monkeypatch):
    """Widens the window with a slow disk write; every id must still have exactly one 200 and one 409."""
    real_replace = os.replace

    def slow_replace(src, dst):
        time.sleep(0.01)
        real_replace(src, dst)

    monkeypatch.setattr("paper_trail.records.os.replace", slow_replace)
    app = create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "no-web")
    ids = [f"race-{i}" for i in range(12)]
    records = [variant({**browser_completed, "id": run_id}, n) for run_id in ids for n in (1, 2)]
    responses = post_concurrently(app, records)
    by_id: dict[str, list[int]] = {}
    for record, response in zip(records, responses):
        by_id.setdefault(record["id"], []).append(response.status_code)
    assert all(sorted(codes) == [200, 409] for codes in by_id.values()), by_id
    assert len(RunStore(tmp_path / "runs").list()) == len(ids)
