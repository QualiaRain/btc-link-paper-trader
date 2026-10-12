"""Malformed and hostile imports must be refused with 422 (never a 500) and must never be stored."""
from __future__ import annotations

import copy
import threading

import pytest

from paper_trail.canonical import sha256_canonical
from paper_trail.records import RunStore, make_run_record


def rehash(record):
    """Make hashes consistent with edited content, as someone crafting a record would."""
    record["hashes"]["configSha256"] = sha256_canonical(record["config"])
    record["hashes"]["marketSha256"] = sha256_canonical(record["market"])
    return record


def refused(client, record, fragment=None):
    response = client.post("/v1/runs/import", json=record)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "invalid_run_record"
    if fragment:
        assert fragment in response.json()["error"]["message"], response.json()
    assert client.get("/v1/runs").json() == {"runs": []}  # nothing stored, listing still works


def test_missing_or_non_text_timestamps_are_refused(client, browser_completed):
    for key in ("updatedAt", "createdAt", "name", "status"):
        broken = copy.deepcopy(browser_completed)
        del broken[key]
        refused(client, broken, key)
    null = copy.deepcopy(browser_completed)
    null["updatedAt"] = None
    refused(client, null, "updatedAt")


@pytest.mark.parametrize("bad_id", ["abc\n", "a b", "../x", "", "a" * 129, "é"])
def test_run_ids_follow_the_browsers_pattern_exactly(client, browser_completed, bad_id):
    refused(client, {**browser_completed, "id": bad_id})


def test_malformed_accounts_are_422_not_500(client, browser_completed):
    ledger = copy.deepcopy(browser_completed)
    ledger["account"]["ledger"] = [{"x": 1}]
    refused(client, ledger)
    zero_cash = copy.deepcopy(browser_completed)
    zero_cash["account"]["config"]["initialCash"] = 0
    zero_cash["config"]["initialCash"] = 0
    refused(client, rehash(zero_cash), "initialCash")
    no_value = copy.deepcopy(browser_completed)
    del no_value["account"]["equity"][0]["value"]
    refused(client, no_value)
    no_forecasts = copy.deepcopy(browser_completed)
    del no_forecasts["account"]["forecasts"]
    refused(client, no_forecasts, "forecasts")
    no_baseline = copy.deepcopy(browser_completed)
    del no_baseline["account"]["baseline"]
    refused(client, no_baseline, "baseline")
    junk = copy.deepcopy(browser_completed)
    junk["summary"] = {"equity": "much"}
    refused(client, junk)


def test_a_consistently_edited_record_passes_so_imports_are_not_tamper_proof(client, browser_completed):
    """Documented limit: integrity checks catch corruption, not a careful forger."""
    from paper_trail.engine import get_summary

    forged = copy.deepcopy(browser_completed)
    forged["account"]["cash"] += 50
    forged["summary"] = get_summary(forged["account"])
    assert client.post("/v1/runs/import", json=forged).status_code == 200


def test_listing_survives_records_that_cannot_be_listed(tmp_path):
    """A stored file that cannot be turned into run metadata is skipped, not fatal."""
    import json

    store = RunStore(tmp_path)
    (tmp_path / "x.json").write_text(json.dumps({"format": "paper-trail-run-v2", "id": "x", "account": {"config": {}, "ledger": [], "equity": []},
                                                "summary": {"y": 1}, "hashes": {"configSha256": "a", "marketSha256": "b"}}))
    assert RunStore(tmp_path).list() == []
    assert store.list() == []


def test_store_is_safe_under_concurrent_saves_and_listings(tmp_path, browser_completed):
    account = browser_completed["account"]
    store = RunStore(tmp_path)
    errors: list[Exception] = []

    def writer(n):
        try:
            for i in range(15):
                store.save(make_run_record(account, {"kind": "sample"}, run_id=f"run-{n % 3}-{i % 5}"))
        except Exception as error:  # pragma: no cover - failure path
            errors.append(error)

    def reader():
        try:
            for _ in range(60):
                store.list()
        except Exception as error:  # pragma: no cover - failure path
            errors.append(error)

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(6)] + [threading.Thread(target=reader) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    assert len(store.list()) == 15
    assert not list(tmp_path.glob("*.tmp"))  # no stray temp files
    assert len(RunStore(tmp_path).list()) == 15
