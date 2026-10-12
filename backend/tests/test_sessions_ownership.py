"""A session owns its run id while open: only it writes snapshots, imports cannot overwrite it, close releases it."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from paper_trail.api import create_app
from paper_trail.errors import ApiProblem
from paper_trail.records import RunOwned, RunStore, make_run_record
from paper_trail.engine import create_account, ingest
from paper_trail.sessions import SessionService
from test_sessions import SAMPLE, account_of, advance, client, close, create, order, save, store  # noqa: F401  (fixtures share one store)


def test_resaving_updates_the_same_run_and_keeps_its_creation_time(client, store):
    state = create(client)
    first = save(client, advance(client, state, count=3)["state"])
    run_id = first["run"]["id"]
    assert run_id == state["runId"]
    second = save(client, advance(client, first["state"], count=3)["state"])
    third = save(client, second["state"], name="third")
    assert {first["run"]["id"], second["run"]["id"], third["run"]["id"]} == {run_id}
    assert first["run"]["createdAt"] == second["run"]["createdAt"] == third["run"]["createdAt"]
    assert second["run"]["updatedAt"] >= first["run"]["updatedAt"]
    runs = client.get("/v1/runs").json()["runs"]
    assert [r["id"] for r in runs] == [run_id] and runs[0]["name"] == "third"
    assert client.get(f"/v1/runs/{run_id}").json()["account"]["lastFrameAt"] == third["state"]["currentFrame"]["time"]


def test_a_session_that_keeps_running_never_alters_its_stored_snapshot(client):
    state = create(client)
    saved = save(client, advance(client, state, count=4)["state"])
    stored = client.get(f"/v1/runs/{saved['run']['id']}/export").json()
    state = saved["state"]
    state = order(client, state)["state"]
    state = advance(client, state, "decision")["state"]
    state = advance(client, state, "finish")["state"]
    assert account_of(client, state["id"])["ledger"] != stored["account"]["ledger"]
    assert client.get(f"/v1/runs/{saved['run']['id']}/export").json() == stored
    assert state["savedVersion"] < state["version"]


def test_import_over_an_open_sessions_run_id_is_refused_even_with_replace(client, store, browser_completed):
    state = create(client)
    record = {**browser_completed, "id": state["runId"]}
    for query in ("", "?replace=true"):  # before any snapshot exists
        response = client.post(f"/v1/runs/import{query}", json=record)
        assert response.status_code == 409 and response.json()["error"]["code"] == "run_owned"
    assert client.get("/v1/runs").json() == {"runs": []}
    state = save(client, state)["state"]
    stored = client.get(f"/v1/runs/{state['runId']}/export").json()
    for query in ("", "?replace=true"):  # with a snapshot
        response = client.post(f"/v1/runs/import{query}", json=record)
        assert response.status_code == 409 and response.json()["error"]["code"] == "run_owned"
    assert client.get(f"/v1/runs/{state['runId']}/export").json() == stored
    # Unrelated ids still import.
    assert client.post("/v1/runs/import", json=browser_completed).status_code == 200


def test_after_close_the_run_id_is_released_and_snapshots_remain(client, store, browser_completed):
    state = save(client, advance(client, create(client), count=2)["state"])["state"]
    stored = client.get(f"/v1/runs/{state['runId']}/export").json()
    closed = close(client, state)
    assert store.owner_of(state["runId"]) is None
    assert client.get(f"/v1/runs/{state['runId']}/export").json() == stored  # snapshot remains
    record = {**browser_completed, "id": state["runId"]}
    conflict = client.post("/v1/runs/import", json=record)  # now an ordinary run: the usual conflict rule applies
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "run_exists"
    assert client.post("/v1/runs/import?replace=true", json=record).status_code == 200
    assert client.get(f"/v1/runs/{state['runId']}").json()["hashes"] == browser_completed["hashes"]
    assert save(client, closed, status=409)["error"]["code"] == "session_closed"  # the closed session cannot write again
    assert client.get(f"/v1/runs/{state['runId']}").json()["hashes"] == browser_completed["hashes"]


def test_a_closed_session_without_a_snapshot_frees_its_id_for_import(client, browser_completed):
    state = create(client)
    close(client, state)
    assert client.post("/v1/runs/import", json={**browser_completed, "id": state["runId"]}).status_code == 200


def test_two_sessions_never_share_a_run_id_and_do_not_write_each_other(client):
    states = [create(client) for _ in range(12)]
    assert len({s["runId"] for s in states}) == 12 and len({s["id"] for s in states}) == 12
    a, b = states[0], states[1]
    save(client, advance(client, a, count=2)["state"])
    saved_b = save(client, advance(client, b, count=5)["state"])
    assert {r["id"] for r in client.get("/v1/runs").json()["runs"]} == {a["runId"], b["runId"]}
    assert client.get(f"/v1/runs/{a['runId']}").json()["account"]["lastFrameAt"] != saved_b["state"]["currentFrame"]["time"]


def test_run_store_only_lets_the_owner_write_a_claimed_id(store):
    owner_id = store.claim("session-a")
    other_id = store.claim("session-b")
    assert owner_id != other_id and store.owner_of(owner_id) == "session-a"
    account = create_account({"horizonMs": 60000})
    ingest(account, {"time": 1, "quotes": {}})  # invalid frame is recorded; the account is still saveable
    record = make_run_record(account, {"kind": "x"}, run_id=owner_id)
    with pytest.raises(RunOwned):
        store.save(record)  # not the owner
    with pytest.raises(RunOwned):
        store.save(record, owner="session-b")
    with pytest.raises(RunOwned):
        store.save_imported(record, replace=True)
    assert store.get(owner_id) is None
    store.save(record, owner="session-a")
    assert store.get(owner_id)["id"] == owner_id
    store.release(owner_id, "session-b")  # only the owner can release
    assert store.owner_of(owner_id) == "session-a"
    store.release(owner_id, "session-a")
    with pytest.raises(RunOwned):
        store.save(record, owner="session-a")  # a released claim confers no right
    store.save(record)  # unowned ids behave as before
    assert store.save_imported(record) == store.get(owner_id)


# ---- capacity ------------------------------------------------------------------------------------------------
def test_open_session_cap_returns_429_and_closing_makes_room(client):
    states = [create(client) for _ in range(64)]
    refused = client.post("/v1/sessions", json=SAMPLE)
    assert refused.status_code == 429 and refused.json()["error"]["code"] == "too_many_sessions"
    close(client, states[10])
    assert create(client)["status"] == "active"
    assert client.post("/v1/sessions", json=SAMPLE).status_code == 429


def test_closed_sessions_are_evicted_oldest_first_when_room_is_needed(store):
    service = SessionService(store, max_sessions=3)
    a, b, c = (service.create({**_settings()}, None, None) for _ in range(3))
    with pytest.raises(ApiProblem) as full:
        service.create(_settings(), None, None)
    assert full.value.status == 429 and full.value.code == "too_many_sessions"
    service.close(b["id"], None)
    service.close(a["id"], None)  # a closed after b: b is the oldest closed
    d = service.create(_settings(), None, None)
    assert service.get(a["id"])["status"] == "closed"
    with pytest.raises(ApiProblem) as gone:
        service.get(b["id"])
    assert gone.value.status == 404 and gone.value.code == "session_not_found"
    e = service.create(_settings(), None, None)  # evicts a
    with pytest.raises(ApiProblem):
        service.get(a["id"])
    assert {service.get(s["id"])["status"] for s in (c, d, e)} == {"active"}
    with pytest.raises(ApiProblem) as final:
        service.create(_settings(), None, None)
    assert final.value.code == "too_many_sessions"
    assert store.owner_of(a["runId"]) is None and store.owner_of(c["runId"]) == c["id"]


def _settings():
    from paper_trail.configuration import normalize_settings
    return normalize_settings({"config": {}})


def test_failed_creation_claims_no_run_id(client, store):
    create(client, {"settings": {"config": {"horizonMs": 1234}}}, status=422)
    assert store._owners == {}
