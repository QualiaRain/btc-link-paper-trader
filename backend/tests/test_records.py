"""Canonical JSON, evidence hashing and run records."""
from __future__ import annotations

import hashlib
import json

import pytest

from paper_trail.canonical import canonical_json, js_number
from paper_trail.configuration import normalize_settings
from paper_trail.records import RunStore, make_run_record, verify_imported_record
from paper_trail.replay import run_replay


@pytest.mark.parametrize("value,text", [
    (0, "0"), (-0.0, "0"), (1, "1"), (100.0, "100"), (1.5, "1.5"), (1e21, "1e+21"), (1e20, "100000000000000000000"),
    (1e-7, "1e-7"), (1e-6, "0.000001"), (123456789012345680000, "123456789012345680000"), (0.1 + 0.2, "0.30000000000000004"),
    (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (-2.5e-9, "-2.5e-9"),
])
def test_number_formatting_matches_javascript(value, text):
    assert js_number(value) == text


def test_non_finite_and_non_json_values_are_rejected():
    for bad in (float("nan"), float("inf")):
        with pytest.raises(ValueError):
            canonical_json({"x": bad})
    with pytest.raises(TypeError):
        canonical_json({"x": object()})


def test_keys_sort_by_utf16_code_unit_like_javascript():
    assert canonical_json({"ｚ": 1, "𝒳": 2, "a": 3}) == '{"a":3,"𝒳":2,"ｚ":1}'


def test_python_record_hashes_verify_like_imports():
    account, dataset = run_replay(normalize_settings({"config": {"horizonMs": 300000}}))
    record = make_run_record(account, {"kind": "sample", "scoreStart": dataset["scoreStart"]}, name="x", run_id="r1")
    assert record["hashes"]["configSha256"] == hashlib.sha256(canonical_json(record["config"]).encode()).hexdigest()
    assert verify_imported_record(json.loads(json.dumps(record))) is not None


def test_store_ignores_corrupt_files_and_keeps_listing_order(tmp_path):
    store = RunStore(tmp_path)
    account, dataset = run_replay(normalize_settings({"config": {}}))
    for run_id in ("a", "b"):
        store.save(make_run_record(account, {"kind": "sample"}, run_id=run_id))
    (tmp_path / "junk.json").write_text("{not json")
    (tmp_path / "bad.json").write_text(json.dumps({"format": "other"}))
    reopened = RunStore(tmp_path)
    assert {r["id"] for r in reopened.list()} == {"a", "b"}


def test_records_with_risk_halts_and_cash_yield_round_trip_through_import():
    settings = normalize_settings({"config": {"maxDrawdownBps": 40, "dailyLossBps": 25, "cashYieldBps": 2000,
                                              "bufferBps": 0, "horizonMs": 300000}})
    account, dataset = run_replay(settings)
    record = json.loads(json.dumps(make_run_record(account, {"kind": "sample"}, name="risk", run_id="risk")))
    summary = record["summary"]
    assert summary["riskHalts"] > 0 and summary["interestEarned"] > 0 and summary["cashBenchmark"] > 1000
    assert "risk" in record["account"] and record["account"]["interest"] == summary["interestEarned"]
    assert verify_imported_record(record) is record


def test_records_saved_before_risk_limits_and_cash_yield_still_import(browser_completed):
    """Old browser records have no limit/yield config fields and no matching summary fields."""
    assert "cashYieldBps" not in browser_completed["config"] and "riskHalts" not in browser_completed["summary"]
    assert verify_imported_record(browser_completed) is browser_completed


def test_missing_summary_fields_are_accepted_only_when_the_feature_was_unused():
    settings = normalize_settings({"config": {"cashYieldBps": 2000, "horizonMs": 300000}})
    account, _ = run_replay(settings)
    record = json.loads(json.dumps(make_run_record(account, {"kind": "sample"}, run_id="y")))
    del record["summary"]["interestEarned"]  # interest was earned, so its absence is a mismatch
    with pytest.raises(ValueError, match="summary does not match"):
        verify_imported_record(record)


def test_legacy_omissions_cannot_hide_new_account_state(browser_completed):
    import copy
    for state in ({"interest": 1}, {"risk": {"peakValue": 1000, "dayStart": None, "dayOpenValue": None,
                                           "killedAt": None, "haltedUntil": None}}):
        altered = copy.deepcopy(browser_completed)
        altered["account"].update(state)
        with pytest.raises(ValueError, match="Legacy rules cannot contain risk or interest state"):
            verify_imported_record(altered)


def test_new_config_cannot_omit_new_summary_fields():
    import copy
    account, _ = run_replay(normalize_settings({"config": {}}))
    record = make_run_record(account, {"kind": "sample"}, run_id="new-summary")
    for key in ("interestEarned", "riskHalts", "tradingHalted"):
        altered = copy.deepcopy(record)
        altered["summary"].pop(key)
        with pytest.raises(ValueError, match="summary does not match"):
            verify_imported_record(altered)
