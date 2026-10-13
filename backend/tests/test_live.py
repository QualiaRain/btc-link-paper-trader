"""Live market reads: JavaScript-compatible primitives, the default urllib transport against a loopback fake exchange,
and its failure handling. No real network: the only server is bound to 127.0.0.1 inside the test."""
from __future__ import annotations

import json
import math
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from paper_trail import live
from paper_trail.api import create_app
from paper_trail.records import RunStore

MINUTE = 60000


def iso_micro(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


class FakeMarket:
    """A deterministic public-exchange stand-in: candles and ticker that move with `now` (epoch ms)."""

    def __init__(self, now: float | None = None) -> None:
        self.now = now
        self.fail: dict[str, dict] = {}  # path -> {"status": 500} / {"text": "..."} / {"sleep": seconds}
        self.requests: list[str] = []
        self.headers: list[dict] = []
        self.ticker_age_ms = 800.0

    def clock(self) -> float:
        return float(self.now if self.now is not None else int(time.time() * 1000))

    @staticmethod
    def close(asset: str, bucket_minute: int) -> float:
        base, vol = (61000.0, 40.0) if asset == "BTC" else (19.2, 0.05)
        return round(base + vol * math.sin(bucket_minute / 9.0), 4)

    def respond(self, path: str) -> dict:
        self.requests.append(path)
        if path in self.fail:
            return self.fail[path]
        now = self.clock()
        for asset in ("BTC", "LINK"):
            if path == f"/products/{asset}-USD/candles?granularity=60":
                last = int(now // MINUTE)
                rows = []
                for minute in range(last, last - 100, -1):  # newest first, the in-progress minute included
                    close, opened = self.close(asset, minute), self.close(asset, minute - 1)
                    rows.append([minute * 60, min(close, opened) - 0.01, max(close, opened) + 0.01, opened, close, 2.5])
                return {"status": 200, "json": rows}
            if path == f"/products/{asset}-USD/ticker":
                mid = self.close(asset, int(now // MINUTE) - 1)
                return {"status": 200, "json": {
                    "trade_id": 7, "price": str(mid), "size": "0.01", "time": iso_micro(now - self.ticker_age_ms),
                    "bid": str(round(mid * 0.9999, 6)), "ask": str(round(mid * 1.0001, 6)), "volume": "10"}}
        return {"status": 404, "json": {"message": "NotFound"}}

    def transport(self, url: str, timeout: float):
        r = self.respond(url[len(live.base_url()):])
        body = r["text"].encode() if "text" in r else json.dumps(r["json"]).encode()
        return r.get("status", 200), body


@pytest.fixture
def market(monkeypatch):
    """A fake market that replaces the default transport and clock (no sockets involved)."""
    fake = FakeMarket(now=1_709_985_600_000 + 17 * MINUTE + 4321)
    monkeypatch.setattr(live, "default_transport", fake.transport)
    monkeypatch.setattr(live, "default_clock", fake.clock)
    monkeypatch.delenv("PAPER_TRAIL_LIVE_BASE_URL", raising=False)
    return fake


# ---- JavaScript-compatible primitives (expected values were produced by V8) --------------------------------
@pytest.mark.parametrize("text,expected", [
    ("2024-03-09T12:00:00.123456Z", 1709985600123), ("2024-03-09T12:00:00.1Z", 1709985600100),
    ("2024-03-09T12:00:00Z", 1709985600000), ("2024-03-09T12:00Z", 1709985600000),
    ("2024-02-30T00:00:00Z", 1709251200000), ("2024-03-09T24:00:00Z", 1710028800000),
    ("2024-03-09T12:00:00+01:00", 1709982000000), ("2024-03-09", 1709942400000), ("2024-03", 1709251200000),
    ("2024", 1704067200000), ("2024-03-09T12:00:00.123456789012Z", 1709985600123),
    ("2024-03-09 12:00:00Z", 1709985600000), ("2024-03-09T12:00:00z", 1709985600000),
    ("2024-03-09T12:00:00+0100", 1709982000000), ("2024-03-09T12:00:00.9999Z", 1709985600999),
    ("", None), ("x", None), ("2024-03-09T25:00:00Z", None), ("2024-13-09T00:00:00Z", None),
    ("2024-03-09T12:00:60Z", None), ("2024-03-09T12:00:00.Z", None), ("2024-03-09T12:00:00,5Z", None), (None, None), (12, None)])
def test_date_parse_matches_v8_for_iso_timestamps(text, expected):
    result = live.date_parse(text)
    assert (math.isnan(result) if expected is None else result == expected), (text, result)


@pytest.mark.parametrize("value,expected", [
    ("61000.5", 61000.5), (" 7 ", 7.0), ("1e3", 1000.0), (".5", 0.5), ("5.", 5.0), ("0x10", 16.0), ("", 0.0), (None, 0.0),
    (True, 1.0), (12, 12.0), ("Infinity", math.inf), ("-Infinity", -math.inf)])
def test_js_number_matches_number_conversion(value, expected):
    assert live.js_number(value) == expected


@pytest.mark.parametrize("value", ["abc", "1_000", "nan", "inf", "1,5", "--1", "0x", {"a": 1}])
def test_js_number_is_nan_where_javascript_is(value):
    assert math.isnan(live.js_number(value))


def test_price_rejects_non_positive_and_non_finite():
    for bad in (0, -1, "0", "abc", None, "Infinity", float("nan")):
        with pytest.raises(live.LiveMarketError, match="^Invalid market price$"):
            live.price(bad)
    assert live.price("0.0001") == 0.0001


def test_trim_live_keeps_lookback_plus_one_observations():
    frame = {"history": {"BTC": list(range(20)), "LINK": list(range(3))}}
    trimmed = live.trim_live(frame, 7)
    assert trimmed["history"]["BTC"] == list(range(12, 20)) and trimmed["history"]["LINK"] == [0, 1, 2]


def test_base_url_comes_from_the_environment_at_call_time(monkeypatch):
    monkeypatch.delenv("PAPER_TRAIL_LIVE_BASE_URL", raising=False)
    assert live.base_url() == "https://api.exchange.coinbase.com"
    monkeypatch.setenv("PAPER_TRAIL_LIVE_BASE_URL", "http://127.0.0.1:9/")
    assert live.base_url() == "http://127.0.0.1:9"


def test_fetch_uses_only_public_read_only_get_paths(market):
    frame = live.fetch_live_market(420000)
    assert sorted(market.requests) == sorted(f"/products/{a}-USD/{p}" for a in ("BTC", "LINK") for p in ("candles?granularity=60", "ticker"))
    assert frame["time"] == market.now and frame["quotes"]["BTC"]["simulatedQuote"] is False
    assert frame["quotes"]["BTC"]["observedAt"] == market.now and frame["source"] == "Coinbase Exchange public REST"
    assert len(frame["history"]["BTC"]) == 99 and frame["history"]["BTC"][-1]["time"] % MINUTE == 0


# ---- the default urllib transport against a loopback fake exchange ------------------------------------------
@pytest.fixture
def exchange(monkeypatch):
    fake = FakeMarket()  # real clock: the server answers for "now"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            fake.headers.append({k.lower(): v for k, v in self.headers.items()})
            r = fake.respond(self.path)
            if "sleep" in r:
                time.sleep(r["sleep"])
            if r.get("status") in (301, 302):
                self.send_response(r["status"])
                self.send_header("Location", "http://127.0.0.1:1/elsewhere")
                self.end_headers()
                return
            body = (r["text"] if "text" in r else json.dumps(r["json"])).encode()
            self.send_response(r.get("status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("PAPER_TRAIL_LIVE_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")  # loopback must bypass any configured proxy
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    try:
        yield fake
    finally:
        server.shutdown()
        server.server_close()


def test_default_transport_reads_a_loopback_exchange_without_credentials(exchange):
    frame = live.fetch_live_market(60000)
    assert abs(frame["time"] - time.time() * 1000) < 5000 and set(frame["quotes"]) == {"BTC", "LINK"}
    assert len(exchange.requests) == 4
    for headers in exchange.headers:
        assert not {"authorization", "cookie", "cb-access-key", "cb-access-sign", "cb-access-passphrase"} & set(headers)
        assert headers["accept"] == "application/json"


def test_default_transport_failures_are_reported_with_the_url(exchange, monkeypatch):
    base = live.base_url()
    exchange.fail["/products/LINK-USD/ticker"] = {"status": 500, "json": {"message": "boom"}}
    with pytest.raises(live.LiveMarketError) as error:
        live.fetch_live_market(60000)
    assert str(error.value) == f"Market data unavailable ({base}/products/LINK-USD/ticker): Market source HTTP 500"
    exchange.fail["/products/LINK-USD/ticker"] = {"status": 302}  # redirects are not followed
    with pytest.raises(live.LiveMarketError, match="Market source HTTP 302"):
        live.fetch_live_market(60000)
    exchange.fail["/products/LINK-USD/ticker"] = {"text": "<html>"}
    with pytest.raises(live.LiveMarketError, match=r"ticker\): Invalid JSON response$"):
        live.fetch_live_market(60000)
    exchange.fail["/products/LINK-USD/ticker"] = {"sleep": 1.5, "json": {}}
    monkeypatch.setattr(live, "TIMEOUT_SECONDS", 0.3)
    with pytest.raises(live.LiveMarketError, match="Market data unavailable") as slow:
        live.fetch_live_market(60000)
    assert "timed out" in str(slow.value)
    exchange.fail.clear()
    monkeypatch.setenv("PAPER_TRAIL_LIVE_BASE_URL", "http://127.0.0.1:1")  # connection refused
    with pytest.raises(live.LiveMarketError, match="Market data unavailable"):
        live.fetch_live_market(60000)


def test_a_live_session_runs_against_the_loopback_exchange_and_http_500_is_a_502(exchange, tmp_path):
    store = RunStore(tmp_path / "runs")
    client = TestClient(create_app(store=store, web_dir=tmp_path / "no-web"))
    body = {"settings": {"config": {"mode": "live", "horizonMs": 60000, "durationMs": 3600000}}}
    exchange.fail["/products/BTC-USD/candles?granularity=60"] = {"status": 500, "json": {"message": "down"}}
    refused = client.post("/v1/sessions", json=body)
    assert refused.status_code == 502 and refused.json()["error"]["code"] == "live_unavailable"
    assert "Market source HTTP 500" in refused.json()["error"]["message"] and store._owners == {}  # nothing was claimed
    exchange.fail.clear()
    created = client.post("/v1/sessions", json=body)
    assert created.status_code == 201
    state = created.json()
    assert state["kind"] == "live" and state["frameCount"] == 1 and state["cursor"] == 0 and state["status"] == "active"
    time.sleep(0.01)
    ticked = client.post(f"/v1/sessions/{state['id']}/tick", json={"expectedVersion": 1})
    assert ticked.status_code == 200 and ticked.json()["state"]["version"] == 2 and ticked.json()["framesIngested"] == 1
    after = ticked.json()["state"]
    assert after["frameCount"] == 2 and after["currentFrame"]["time"] > state["currentFrame"]["time"]
    exchange.fail["/products/LINK-USD/ticker"] = {"status": 500, "json": {"message": "down"}}
    failed = client.post(f"/v1/sessions/{state['id']}/tick", json={"expectedVersion": 2})
    assert failed.status_code == 502 and failed.json()["error"]["code"] == "live_unavailable"
    failed_order = client.post(f"/v1/sessions/{state['id']}/orders", json={"asset": "BTC", "side": "buy", "dollars": 50, "expectedVersion": 2})
    assert failed_order.status_code == 502
    assert client.get(f"/v1/sessions/{state['id']}").json() == after  # state and version unchanged
    exchange.fail.clear()
    time.sleep(0.01)
    traded = client.post(f"/v1/sessions/{state['id']}/orders", json={"asset": "BTC", "side": "buy", "dollars": 50, "expectedVersion": 2})
    assert traded.status_code == 200 and traded.json()["state"]["manualTradeCount"] == 1 and traded.json()["state"]["version"] == 3
