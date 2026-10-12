"""Candle retrieval: receipts, cancellation, real HTTP on loopback (default transport), timeouts, proxies.

No test touches the network: injected transports, or a throwaway HTTP server bound to 127.0.0.1.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest

from paper_trail import candles
from paper_trail.candles import (CandleError, CandleFetcher, Cancelled, FetchResult, NetworkFailure, TransportError,
                                 TransportTimeout, default_transport, stamp)
from paper_trail.engine import iso
from paper_trail.replay import range_dataset

MINUTE = 60000
START = 1_709_985_600_000  # 2024-03-09T12:00:00Z
END = START + 10 * MINUTE


def price_at(bucket_ms: int) -> float:
    return 100.0 + (bucket_ms // MINUTE) % 37 * 0.25


def rows_for(start_ms: int, end_ms: int, scale: float = 1.0) -> list:
    out = []
    for bucket in range(start_ms - start_ms % MINUTE + (MINUTE if start_ms % MINUTE else 0), end_ms + 1, MINUTE):
        p = price_at(bucket) * scale
        out.append([bucket // 1000, p - 1, p + 1, p, p, 1])
    return out[::-1]


def parse_iso(text: str) -> int:
    from datetime import datetime, timezone
    return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp() * 1000)


def candle_transport(calls: list | None = None, scale: dict | None = None):
    def transport(url, timeout):
        if calls is not None:
            calls.append(url)
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        asset = "LINK" if "LINK-USD" in parts.path else "BTC"
        rows = rows_for(parse_iso(query["start"][0]), parse_iso(query["end"][0]), (scale or {}).get(asset, 1.0))
        return 200, {"Date": "Sat, 09 Mar 2024 12:11:00 GMT"}, json.dumps(rows).encode()
    return transport


def fetcher(**kwargs) -> CandleFetcher:
    kwargs.setdefault("transport", candle_transport())
    kwargs.setdefault("sleep", lambda seconds: None)
    return CandleFetcher(**kwargs)


FETCH = dict(half_spread_bps=2, warmup_minutes=10, history_limit=8, required_history=8)


# ------------------------------------------------------------------ receipts and shape

def test_fetch_returns_series_coverage_and_receipts_per_request():
    calls: list[str] = []
    result = fetcher(transport=candle_transport(calls)).fetch_range(START, END, **FETCH)
    assert isinstance(result, FetchResult)
    assert [r["asset"] for r in result.receipts] == ["BTC", "LINK"]
    for receipt, url in zip(result.receipts, calls):
        assert receipt["url"] == url and receipt["attempts"] == 1
        assert receipt["httpDate"] == "Sat, 09 Mar 2024 12:11:00 GMT"
        assert receipt["rowCount"] == 22 and isinstance(receipt["receivedAt"], int)
        assert len(receipt["sha256"]) == 64
    body = candle_transport()(calls[0], 1)[2]
    assert result.receipts[0]["sha256"] == hashlib.sha256(body).hexdigest()
    series = result.candles()
    assert [r["time"] for r in series["BTC"]] == list(range(START - 10 * MINUTE, END + 1, MINUTE))
    assert series["BTC"][0] == {"time": START - 10 * MINUTE, "price": price_at(START - 11 * MINUTE)}
    assert result.coverage["BTC"]["missingCount"] == 0 and result.coverage["LINK"]["startPresent"]
    assert "rowCount" not in result.provenance[0] and result.raw_responses[0]["rows"][0][0] > 0


def test_url_shape_and_chunking():
    calls: list[str] = []
    fetcher(transport=candle_transport(calls)).fetch_range(START, START + 700 * MINUTE, warmup_minutes=60)
    assert len(calls) == 6  # three 299-minute chunks per asset
    first = START - 60 * MINUTE - MINUTE
    assert calls[0] == ("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60"
                        f"&start={iso(first).replace(':', '%3A')}&end={iso(first + 299 * MINUTE).replace(':', '%3A')}")
    assert "LINK-USD" in calls[3]
    assert calls[2].endswith("end=" + iso(START + 700 * MINUTE).replace(":", "%3A"))


def test_receipts_use_the_injected_clock_and_header_lookup_is_case_insensitive():
    ticks = iter(range(1000, 2000, 7))
    transport = lambda url, timeout: (200, [("DATE", "x")], b"[]")
    with pytest.raises(CandleError, match="Exact start/end close missing"):
        fetcher(transport=transport, clock=lambda: next(ticks) + 2_000_000_000_000).fetch_range(START, END, **FETCH)
    transport_ok = candle_transport()
    wrapped = lambda url, timeout: (lambda r: (r[0], [("dAtE", "later")], r[2]))(transport_ok(url, timeout))
    result = fetcher(transport=wrapped, clock=lambda: 2_000_000_000_000).fetch_range(START, END, **FETCH)
    assert result.receipts[0]["httpDate"] == "later" and result.receipts[0]["receivedAt"] == 2_000_000_000_000
    assert result.retrieval_elapsed_ms == 0 and result.captured_at_ms == 2_000_000_000_000


def test_progress_events_and_unknown_transport_exceptions_are_retried():
    events, attempts = [], []

    def flaky(url, timeout):
        attempts.append(url)
        if len(attempts) == 1:
            raise RuntimeError("boom")
        return candle_transport()(url, timeout)

    result = fetcher(transport=flaky).fetch_range(START, END, progress=lambda *e: events.append(e), **FETCH)
    assert result.receipts[0]["attempts"] == 2
    assert events[0] == ("fetch", 0, 2, None, "Fetching completed UTC minutes")
    assert events[1] == ("fetch", 1, 2, "BTC", "BTC: 1/2 batches")
    assert events[-1] == ("complete", 2, 2, None, "11 shared scored minutes")
    with pytest.raises(NetworkFailure, match="Coinbase request failed: boom"):
        fetcher(transport=lambda u, t: (_ for _ in ()).throw(RuntimeError("boom"))).fetch_range(START, END, **FETCH)
    with pytest.raises(NetworkFailure, match="timed out"):
        fetcher(transport=lambda u, t: (_ for _ in ()).throw(TransportTimeout("x"))).fetch_range(START, END, **FETCH)


def test_retry_schedule_is_500_then_1000_ms_and_spacing_is_350_ms():
    waits: list[float] = []
    state = {"n": 0}

    def transport(url, timeout):
        state["n"] += 1
        return (429 if state["n"] <= 2 else 200), {}, candle_transport()(url, timeout)[2]

    result = fetcher(transport=transport, sleep=waits.append).fetch_range(START, END, **FETCH)
    assert waits == [0.5, 1.0, 0.35] and result.receipts[0]["attempts"] == 3


def test_start_and_end_stamps():
    assert stamp(START) == START and stamp(float(START)) == START
    assert stamp("2024-03-09T12:00:00Z") == START and stamp("2024-03-09T12:00Z") == START
    assert stamp("2024-03-09T12:00:00.000+00:00") == START
    for bad, message in [("2024-03-09T12:00:00", "Use explicit UTC date/time"), (True, "UTC minute-close"),
                         (START + 1, "UTC minute-close"), ("2024-02-31T00:00:00Z", "UTC minute-close"),
                         (float("nan"), "UTC minute-close"), (None, "UTC minute-close")]:
        with pytest.raises(CandleError, match=message):
            stamp(bad)


def test_future_end_uses_the_injected_clock():
    now = END + 5 * MINUTE + 30_000
    assert fetcher(clock=lambda: now).fetch_range(START, END, **FETCH).end == END
    with pytest.raises(CandleError, match="End must be a completed UTC minute"):
        fetcher(clock=lambda: END - 1).fetch_range(START, END, **FETCH)


def test_frames_and_checks_match_replay_range_dataset():
    lookback = 7
    kwargs = dict(half_spread_bps=3.5, warmup_minutes=max(60, 2 * lookback + 10), history_limit=lookback + 1,
                  required_history=lookback + 1)
    result = fetcher(transport=candle_transport(scale={"LINK": 0.2})).fetch_range(START, START + 90 * MINUTE, **kwargs)
    reference = range_dataset(result.candles(), START, START + 90 * MINUTE, 3.5, lookback)
    assert result.frames() == reference["frames"]
    assert {a: {k: v for k, v in c.items() if k in reference["coverage"][a]} for a, c in result.coverage.items()} \
        == {a: {k: v for k, v in c.items() if k != "missingFraction"} | {"missingFraction": c["missingFraction"]}
            for a, c in reference["coverage"].items()}
    # the same two failure messages as replay.range_dataset (which this module intentionally does not call)
    def dropping(asset, keep_from):
        def transport(url, timeout):
            status, headers, body = candle_transport()(url, timeout)
            if asset in url:
                body = json.dumps([r for r in json.loads(body) if r[0] * 1000 + MINUTE >= keep_from]).encode()
            return status, headers, body
        return transport

    with pytest.raises(CandleError) as short:
        fetcher(transport=dropping("LINK", START - 3 * MINUTE)).fetch_range(START, START + 30 * MINUTE, **kwargs)
    trimmed = {a: [r for r in result.candles()[a] if START - 3 * MINUTE <= r["time"] <= START + 30 * MINUTE]
               for a in result.candles()}
    with pytest.raises(ValueError) as expected:
        range_dataset(trimmed, START, START + 30 * MINUTE, 3.5, lookback)
    assert str(short.value) == str(expected.value).replace("BTC:", "LINK:")  # range_dataset reports BTC first (both trimmed)
    assert str(short.value) == ("LINK: only 4 causal observations at scored start; 8 required. Choose a smaller "
                                "lookback or another range. No run was created.")
    boundary = pytest.raises(CandleError, match="Exact start/end close missing for one or both assets")
    with boundary:
        fetcher(transport=dropping("BTC", START + MINUTE)).fetch_range(START, START + 30 * MINUTE, **kwargs)


# ------------------------------------------------------------------ cancellation

def test_cancel_before_start_makes_no_request():
    calls: list[str] = []
    event = threading.Event()
    event.set()
    with pytest.raises(Cancelled, match="Request cancelled"):
        fetcher(transport=candle_transport(calls)).fetch_range(START, END, cancel=event, **FETCH)
    assert calls == []


def test_validation_errors_win_over_cancel_like_the_browser():
    event = threading.Event()
    event.set()
    with pytest.raises(CandleError, match="Choose a positive range"):
        fetcher().fetch_range(END, START, cancel=event, **FETCH)


def test_cancel_after_a_response_stops_before_the_next_request():
    calls: list[str] = []
    event = threading.Event()
    inner = candle_transport(calls)

    def transport(url, timeout):
        result = inner(url, timeout)
        event.set()  # cancelled while the response was in flight
        return result

    with pytest.raises(Cancelled):
        fetcher(transport=transport).fetch_range(START, END, cancel=event, **FETCH)
    assert len(calls) == 1


def test_cancel_during_an_injected_sleep():
    event = threading.Event()
    calls: list[str] = []

    def sleep(seconds):
        event.set()

    with pytest.raises(Cancelled):
        fetcher(transport=candle_transport(calls), sleep=sleep).fetch_range(START, END, cancel=event, **FETCH)
    assert len(calls) == 1


def timed_cancel(delay: float) -> threading.Event:
    event = threading.Event()
    threading.Timer(delay, event.set).start()
    return event


def test_default_wait_wakes_immediately_on_cancel_during_retry_backoff():
    transport = lambda url, timeout: (429, {}, b"{}")  # first back-off would be 500 ms
    started = time.monotonic()
    with pytest.raises(Cancelled):
        CandleFetcher(transport=transport).fetch_range(START, END, cancel=timed_cancel(0.05), **FETCH)
    assert time.monotonic() - started < 0.3


def test_default_wait_wakes_immediately_on_cancel_during_request_spacing():
    started = time.monotonic()
    with pytest.raises(Cancelled):
        CandleFetcher(transport=candle_transport(), min_interval=5).fetch_range(START, END, cancel=timed_cancel(0.05), **FETCH)
    assert time.monotonic() - started < 0.5


# ------------------------------------------------------------------ real HTTP on loopback

class Server:
    """Throwaway loopback candle server. `script(index, asset, start, end)` -> (status, body, delay_seconds)."""

    def __init__(self, script=None, scale=None):
        self.requests: list[dict] = []
        self.release = threading.Event()
        self.script = script
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                parts = urlsplit(self.path)
                query = parse_qs(parts.query)
                asset = "LINK" if "LINK-USD" in parts.path else "BTC"
                start, end = parse_iso(query["start"][0]), parse_iso(query["end"][0])
                index = len(outer.requests)
                outer.requests.append({"path": self.path, "asset": asset, "headers": dict(self.headers)})
                status, body, delay = (outer.script(index, asset, start, end) if outer.script
                                       else (200, json.dumps(rows_for(start, end)), 0))
                if delay:
                    outer.release.wait(delay)
                data = body.encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.release.set()
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def serve():
    servers = []

    def make(script=None):
        servers.append(Server(script))
        return servers[-1]

    yield make
    for server in servers:
        server.close()


def test_default_transport_fetches_over_real_http(serve):
    server = serve()
    result = CandleFetcher(base_url=server.base, min_interval=0).fetch_range(START, END, **FETCH)
    assert [r["asset"] for r in result.receipts] == ["BTC", "LINK"] and len(server.requests) == 2
    assert result.receipts[0]["url"].startswith(server.base + "/products/BTC-USD/candles?granularity=60&start=")
    assert result.receipts[0]["httpDate"] is not None and server.requests[0]["headers"]["Accept"] == "application/json"
    assert result.coverage["BTC"]["missingCount"] == 0
    assert result.receipts[0]["rowCount"] == len(rows_for(START - 11 * MINUTE, END))


def test_default_transport_retries_429_then_succeeds(serve):
    def script(index, asset, start, end):
        return (429, '{"message":"rate limited"}', 0) if index == 0 else (200, json.dumps(rows_for(start, end)), 0)

    server = serve(script)
    waits: list[float] = []
    result = CandleFetcher(base_url=server.base, min_interval=0, sleep=waits.append).fetch_range(START, END, **FETCH)
    assert result.receipts[0]["attempts"] == 2 and waits == [0.5, 0.0]
    assert len(server.requests) == 3


def test_default_transport_reports_http_errors_and_invalid_json(serve):
    not_found = serve(lambda i, a, s, e: (404, "{}", 0))
    with pytest.raises(CandleError, match="Coinbase HTTP 404") as error:
        CandleFetcher(base_url=not_found.base).fetch_range(START, END, **FETCH)
    assert error.value.retryable is False and len(not_found.requests) == 1
    junk = serve(lambda i, a, s, e: (200, "<html>", 0))
    with pytest.raises(candles.InvalidJSONResponse):
        CandleFetcher(base_url=junk.base).fetch_range(START, END, **FETCH)
    assert len(junk.requests) == 1


def test_default_transport_times_out_and_retries(serve):
    server = serve(lambda i, a, s, e: (200, "[]", 5))
    started = time.monotonic()
    with pytest.raises(NetworkFailure, match="timed out"):
        CandleFetcher(base_url=server.base, timeout=0.2, attempts=2, sleep=lambda s: None).fetch_range(START, END, **FETCH)
    assert time.monotonic() - started < 2 and len(server.requests) == 2


def test_default_transport_refused_connection_is_a_network_failure():
    free = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = free.server_address[1]
    free.server_close()  # nothing listens here any more
    with pytest.raises(NetworkFailure, match="Coinbase request failed"):
        CandleFetcher(base_url=f"http://127.0.0.1:{port}", attempts=2, sleep=lambda s: None).fetch_range(START, END, **FETCH)


def test_cancelling_a_slow_response_mid_flight_returns_within_a_second(serve):
    server = serve(lambda i, a, s, e: (200, "[]", 10))
    event = threading.Event()
    threading.Timer(0.2, event.set).start()
    started = time.monotonic()
    with pytest.raises(Cancelled):
        CandleFetcher(base_url=server.base).fetch_range(START, END, cancel=event, **FETCH)
    assert time.monotonic() - started < 1.0
    assert len(server.requests) == 1  # no retry after cancellation


def test_default_transport_directly_supports_cancel_and_timeout(serve):
    server = serve(lambda i, a, s, e: (200, "[]", 10))
    url = f"{server.base}/products/BTC-USD/candles?granularity=60&start={iso(START)}&end={iso(END)}"
    event = threading.Event()
    threading.Timer(0.1, event.set).start()
    with pytest.raises(Cancelled):
        default_transport(url, 15, cancel=event)
    with pytest.raises(TransportTimeout):
        default_transport(url, 0.2)


def test_loopback_bypasses_environment_proxies(serve, monkeypatch):
    for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")  # a dead proxy: any proxied request would fail
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    server = serve()
    result = CandleFetcher(base_url=server.base, min_interval=0, attempts=1).fetch_range(START, END, **FETCH)
    assert len(result.series["BTC"]) == 21 and len(server.requests) == 2


def test_base_url_comes_from_the_environment(monkeypatch):
    monkeypatch.delenv(candles.BASE_URL_ENV, raising=False)
    assert CandleFetcher().base_url == "https://api.exchange.coinbase.com"
    monkeypatch.setenv(candles.BASE_URL_ENV, "http://127.0.0.1:1234/")
    fetcher_ = CandleFetcher()
    assert fetcher_.base_url == "http://127.0.0.1:1234"
    assert fetcher_.url_for("BTC", START, END).startswith("http://127.0.0.1:1234/products/BTC-USD/candles?granularity=60")
    assert CandleFetcher(base_url="http://example.invalid/").base_url == "http://example.invalid"
