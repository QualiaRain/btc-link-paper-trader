"""Parity between the existing JavaScript implementation and the Python backend.

`parity/expected/*.json` is produced by running the JavaScript modules at the repository root
(`node parity/generate-expected.mjs`) over the identical `parity/inputs/*.json`. A JS test
(`parity/golden.test.mjs`) fails if the goldens stop matching the JavaScript, so a green run of
both suites means JavaScript and Python agree on these inputs.

Exact equality is required for integers, strings, booleans, null and structure. Floating point
values may differ by at most 1e-12 relative, which covers last-bit differences in `Math.exp` and
`Math.log` between V8 and the C library.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from parity_runner import run_case

PARITY = Path(__file__).resolve().parents[2] / "parity"
REL = 1e-12
CASES = sorted(p.stem for p in (PARITY / "inputs").glob("*.json"))


def diff(expected, actual, path="$"):
    """Return the first difference between two JSON values, or None."""
    if isinstance(expected, bool) or isinstance(actual, bool) or expected is None or actual is None:
        return None if expected is actual or expected == actual and type(expected) is type(actual) else f"{path}: {expected!r} != {actual!r}"
    if isinstance(expected, dict) and isinstance(actual, dict):
        if expected.keys() != actual.keys():
            return f"{path}: keys differ: only JS {sorted(expected.keys() - actual.keys())}, only Python {sorted(actual.keys() - expected.keys())}"
        return next((d for k in expected if (d := diff(expected[k], actual[k], f"{path}.{k}"))), None)
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return f"{path}: length {len(expected)} != {len(actual)}"
        return next((d for i, (x, y) in enumerate(zip(expected, actual)) if (d := diff(x, y, f"{path}[{i}]"))), None)
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        if expected == actual:
            return None
        if isinstance(expected, int) and isinstance(actual, int):
            return f"{path}: {expected} != {actual}"
        scale = max(abs(expected), abs(actual), 1e-300)
        return None if math.isfinite(scale) and abs(expected - actual) <= REL * scale else f"{path}: {expected!r} != {actual!r}"
    return None if expected == actual else f"{path}: {expected!r} != {actual!r}"


def test_inputs_and_goldens_are_present():
    assert CASES == ["canonical", "cash-yield", "chronology", "fees-slippage", "missing-quotes", "positions",
                     "range-replay", "risk-limits", "sample-replay", "settings", "warmup"]


@pytest.mark.parametrize("name", CASES)
def test_python_matches_javascript_golden(name):
    case = json.loads((PARITY / "inputs" / f"{name}.json").read_text())
    golden = json.loads((PARITY / "expected" / f"{name}.json").read_text())
    assert golden["name"] == case["name"] and golden["kind"] == case["kind"]
    actual = json.loads(json.dumps(run_case(case)))  # same JSON round trip the goldens went through
    assert actual.keys() == golden["scenarios"].keys()
    problems = [f"{scenario}: {found}" for scenario in actual
                if (found := diff(golden["scenarios"][scenario], actual[scenario]))]
    assert not problems, "\n".join(problems)


def test_goldens_exercise_the_cases_they_claim():
    """Guard against vacuous parity: key behaviours must actually occur in the JavaScript goldens."""
    def scenarios(name):
        return json.loads((PARITY / "expected" / f"{name}.json").read_text())["scenarios"]

    def types(scenario):
        return {e["type"] for e in scenario["account"]["ledger"]}

    chron = scenarios("chronology")
    assert "gap" in types(chron["live-gap-event"])
    missing = scenarios("missing-quotes")
    assert "invalid_frame" in types(missing["damaged-frames-recorded-as-invalid"])
    assert missing["outcomes-observed-late-expire"]["summary"]["expiredForecasts"] > 0
    assert missing["outcomes-observed-late-expire"]["summary"]["settledForecasts"] > 0
    assert len(missing["invalid-frame-time-throws"]["errors"]) == 3
    assert "stop_loss" in types(scenarios("positions")["stop-loss-breach-and-no-reentry"])
    assert any(s["summary"]["tradeCount"] for s in scenarios("fees-slippage").values() if "summary" in s)
    assert any(s["summary"]["tradeCount"] == 0 for s in scenarios("warmup").values())
    assert sum("error" in x for x in scenarios("settings")["normalize"]) > 20
    range_cases = scenarios("range-replay")
    assert sum("error" in v for v in range_cases.values()) >= 4 and sum("summary" in v for v in range_cases.values()) >= 5

    risk = scenarios("risk-limits")
    halted = risk["drawdown-halts-for-the-session"]
    assert halted["summary"]["tradingHalted"] == "max_drawdown" and halted["summary"]["riskHalts"] == 1
    assert any(e.get("blockedBy") == "max_drawdown" and e["wouldBuy"] for e in halted["account"]["ledger"])
    daily = risk["daily-loss-resumes-next-utc-day"]
    assert {"risk_halt", "risk_resume"} <= types(daily) and daily["summary"]["tradingHalted"] is None
    assert [e["limit"] for e in risk["daily-loss-then-drawdown-later"]["account"]["ledger"]
            if e["type"] == "risk_halt"] == ["daily_loss", "max_drawdown"]
    assert any(e["message"].startswith("Daily loss limit reached") for e in risk["manual-buys-refused-while-halted"]["errors"])
    assert any(e["message"].startswith("Drawdown limit reached") for e in risk["manual-buy-refused-after-drawdown"]["errors"])
    assert "risk" not in risk["no-limits-configured-no-risk-state"]["account"]
    assert "risk" not in risk["saved-before-limits-runs-without-them"]["account"]
    assert not any("blockedBy" in e for e in risk["no-limits-configured-no-risk-state"]["account"]["ledger"])
    yields = scenarios("cash-yield")
    assert yields["max-yield-hourly-with-completion"]["summary"]["interestEarned"] > 0
    assert yields["max-yield-hourly-with-completion"]["summary"]["cashBenchmark"] > 1000
    assert "interest" not in yields["zero-yield-default"]["account"]
    assert yields["saved-before-yield"]["summary"]["cashBenchmark"] == 1000
    assert scenarios("sample-replay")["risk-limits-and-cash-yield"]["summary"]["riskHalts"] > 0
    assert range_cases["risk-limits-and-cash-yield"]["summary"]["riskHalts"] > 0
