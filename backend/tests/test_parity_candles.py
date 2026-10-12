"""Parity between replay.js `fetchHistoricalRange` and the Python `CandleFetcher`.

`parity/candles/expected/*.json` is produced by running the EXISTING replay.js over a stubbed fetch that
serves canned HTTP responses (`parity/candles/inputs/*.json`); `parity/candles/golden.test.mjs` fails if the
goldens stop matching the JavaScript. Here the same canned responses are served through an injected Python
transport and everything must match exactly: series, coverage, receipt fields (except timestamps), request
URLs including retries, wait delays, progress events and error messages. Invalid JSON and network failures
carry engine-specific messages in JavaScript, so they are compared by kind only.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from paper_trail.candles import (CandleError, CandleFetcher, InvalidJSONResponse, NetworkFailure, TransportError)
from paper_trail.canonical import canonical_json

PARITY = Path(__file__).resolve().parents[2] / "parity" / "candles"
MINUTE = 60000
DEFAULT_DATE = "Tue, 02 Jan 2024 03:04:05 GMT"
CASES = sorted(p.stem for p in (PARITY / "inputs").glob("*.json"))
PARAM_NAMES = {"halfSpreadBps": "half_spread_bps", "warmupMinutes": "warmup_minutes",
               "historyLimit": "history_limit", "requiredHistory": "required_history"}


class CannedServer:
    """Python twin of `makeResponder` in parity/candles/harness.mjs."""

    def __init__(self, scenario: dict) -> None:
        self.scenario = scenario
        self.urls: list[str] = []
        self.chunk_starts: dict[str, list[str]] = {"BTC": [], "LINK": []}
        self.attempts: dict[str, int] = {}

    def _normal(self, asset: str, start_ms: int, end_ms: int, extra: list) -> str:
        rows = [[(c["time"] - MINUTE) / 1000, c["price"] - 1, c["price"] + 1, c["price"], c["price"], 1]
                for c in self.scenario["data"][asset] if start_ms <= c["time"] - MINUTE <= end_ms]
        return canonical_json(rows[::-1] + extra)  # ECMAScript number formatting, like JSON.stringify

    def __call__(self, url: str, timeout: float):
        from urllib.parse import parse_qs, urlsplit
        self.urls.append(url)
        parts = urlsplit(url)
        asset = "LINK" if "LINK-USD" in parts.path else "BTC"
        query = parse_qs(parts.query)
        start, end = query["start"][0], query["end"][0]
        if start not in self.chunk_starts[asset]:
            self.chunk_starts[asset].append(start)
        key = f"{asset}:{self.chunk_starts[asset].index(start)}"
        n = self.attempts[key] = self.attempts.get(key, -1) + 1
        steps = (self.scenario.get("scripts") or {}).get(key) or [{"ok": True}]
        step = steps[min(n, len(steps) - 1)]
        if step.get("throw"):
            raise TransportError("connection refused")
        headers = step["headers"] if "headers" in step else {"date": DEFAULT_DATE}
        if "body" in step:
            body = step["body"]
        elif "rows" in step:
            body = canonical_json(step["rows"])
        else:
            parse = lambda s: _parse_ms(s)
            body = self._normal(asset, parse(start), parse(end), step.get("extraRows", []))
        return step.get("status", 200), headers, body.encode()


def _parse_ms(text: str) -> int:
    from datetime import datetime, timezone
    return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp() * 1000)


def run_scenario(scenario: dict) -> dict:
    server = CannedServer(scenario)
    delays: list[int] = []
    progress: list[list] = []
    fetcher = CandleFetcher(transport=server, sleep=lambda seconds: delays.append(round(seconds * 1000)))
    params = scenario["params"]
    kwargs = {PARAM_NAMES[k]: v for k, v in params.items() if k in PARAM_NAMES and v is not None}
    try:
        result = fetcher.fetch_range(params.get("start"), params.get("end"),
                                     progress=lambda *event: progress.append(list(event)), **kwargs)
    except CandleError as error:
        if isinstance(error, InvalidJSONResponse):
            described = {"kind": "syntax"}
        elif isinstance(error, NetworkFailure):
            described = {"kind": "network"}
        else:
            described = {"kind": "error", "message": str(error), "retryable": error.retryable}
            if error.coverage is not None:
                described["coverage"] = error.coverage
        return {"error": described, "requests": server.urls, "delays": delays}
    return {"series": result.series, "coverage": result.coverage,
            "provenance": [{k: r[k] for k in ("asset", "url", "httpDate", "sha256", "attempts", "rowCount")}
                           for r in result.receipts],
            "sharedCount": len(result.frames()), "requests": server.urls, "delays": delays, "progress": progress}


@pytest.mark.parametrize("name", CASES)
def test_python_matches_replay_js_golden(name):
    case = json.loads((PARITY / "inputs" / f"{name}.json").read_text())
    golden = json.loads((PARITY / "expected" / f"{name}.json").read_text())
    assert golden["name"] == case["name"] and golden["kind"] == case["kind"] == "candles-fetch"
    assert golden["scenarios"].keys() == {s["name"] for s in case["scenarios"]}
    failures = []
    for scenario in case["scenarios"]:
        # The JSON round trip is what the golden went through (ints, floats and key types).
        actual = json.loads(json.dumps(run_scenario(scenario)))
        expected = golden["scenarios"][scenario["name"]]
        if actual != expected:
            keys = [k for k in expected if expected[k] != actual.get(k)]
            failures.append(f"{scenario['name']}: differs in {keys}: expected {str(expected.get(keys[0]))[:200]!r} "
                            f"got {str(actual.get(keys[0]))[:200]!r}" if keys else scenario["name"])
    assert not failures, "\n".join(failures)


def test_the_goldens_are_not_vacuous():
    golden = json.loads((PARITY / "expected" / "retrieval.json").read_text())["scenarios"]
    errors = {k: v for k, v in golden.items() if "error" in v}
    successes = {k: v for k, v in golden.items() if "series" in v}
    assert len(golden) >= 70 and len(errors) >= 40 and len(successes) >= 12
    assert any(p["attempts"] == 3 for v in successes.values() for p in v["provenance"])
    assert {v["error"]["kind"] for v in errors.values()} == {"error", "syntax", "network"}
    assert any(v["delays"] == [500, 1000] for v in errors.values())
    assert any(v["coverage"]["BTC"]["missingCount"] for v in successes.values())
    assert any(v["coverage"]["LINK"]["duplicateRows"] for v in successes.values())
    assert any(v["error"].get("coverage") for v in errors.values())
