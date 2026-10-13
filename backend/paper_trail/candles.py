"""Historical candle retrieval, ported from replay.js `fetchHistoricalRange`.

The browser fetches Coinbase Exchange public one-minute candles in 299-minute chunks, retries
transient failures, keeps a receipt (URL, receive time, HTTP date, body SHA-256, attempts) for every
request and refuses a run when an exact boundary or the required per-asset warmup is missing. This
module does the same on the server and adds cooperative cancellation.

Behaviour deliberately identical to replay.js (and covered by golden parity tests):

* chunking (`first - 1 minute` .. +299 minutes, clipped to `end`), URL shape and parameter order;
* HTTP 429 and 5xx are retried (3 attempts, 500 ms * 2**attempt back-off), other 4xx are not, invalid
  JSON is not retried, a flat 350 ms pause separates consecutive requests;
* candle-row validation, conflicting-duplicate detection, boundary and per-asset warmup checks and
  every error message.

Deliberate differences: the transport is injectable (tests never touch the network), a
`threading.Event` cancels a fetch (also while a request is in flight or a wait is pending), receipts
carry a `rowCount`, and the receipt hash covers the raw response bytes.

Public API: `CandleFetcher.fetch_range(...) -> FetchResult`; `FetchResult.candles()` returns the
`{asset: [{time, price}]}` mapping `replay.range_dataset` consumes, and `FetchResult.dataset()` returns
the browser's `fetchHistoricalRange` dataset (so its run evidence matches the browser's).
"""
from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping
from urllib.parse import urlsplit

from .engine import ASSETS, iso

MINUTE = 60000
MAX_DAYS = 31
CHUNK_MINUTES = 299
DEFAULT_BASE_URL = "https://api.exchange.coinbase.com"
BASE_URL_ENV = "PAPER_TRAIL_CANDLE_BASE_URL"
DOC = "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles"
MAX_SAFE_INTEGER = 2 ** 53 - 1

Transport = Callable[..., "tuple[int, Any, bytes]"]
ProgressCallback = Callable[[str, int, int, "str | None", str], None]


class CandleError(ValueError):
    """A retrieval or validation failure. `retryable` mirrors replay.js (`None` = unknown/network)."""

    retryable: bool | None = None
    coverage: dict | None = None


class InvalidJSONResponse(CandleError):
    """The response body was not JSON (replay.js: a `SyntaxError`, never retried)."""

    retryable = False


class NetworkFailure(CandleError):
    """The request failed below HTTP (connection refused, reset, timeout). Retried; final failure is raised."""


class Cancelled(Exception):
    """The caller's cancel event was set (replay.js: an `AbortError`)."""

    def __init__(self, message: str = "Request cancelled") -> None:
        super().__init__(message)


class TransportError(Exception):
    """A network-level failure raised by a transport. Retried like any other transient error."""


class TransportTimeout(TransportError):
    """The request exceeded its timeout. Retried (replay.js: a timed-out fetch is retried)."""


def _is_integer(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and value.is_integer()


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _finite(value: Any) -> bool:
    if not _is_number(value):
        return False
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


_ISO_UTC = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(?:Z|\+00:00)$")


def stamp(value: Any) -> int:
    """`stamp()` of replay.js: an epoch-ms integer or an explicit-UTC ISO string on a minute boundary."""
    if isinstance(value, str):
        if not re.search(r"(Z|\+00:00)$", value):
            raise CandleError("Use explicit UTC date/time")
        match = _ISO_UTC.match(value)
        moment = None
        if match:
            year, month, day, hour, minute, second, fraction = match.groups()
            try:
                moment = datetime(int(year), int(month), int(day), int(hour or 0), int(minute or 0),
                                  int(second or 0), tzinfo=timezone.utc)
            except ValueError:
                moment = None
            if moment is not None:
                millis = int((fraction or "0").ljust(3, "0")[:3])
                number: Any = int(moment.timestamp()) * 1000 + millis
            else:
                number = None
        else:
            number = None
    else:
        number = value
    if not _is_integer(number) or abs(int(number)) > MAX_SAFE_INTEGER or int(number) % MINUTE:
        raise CandleError("Range endpoints must be UTC minute-close timestamps")
    return int(number)


def _header(headers: Any, name: str) -> str | None:
    if headers is None:
        return None
    items: Iterable[Any] = headers.items() if isinstance(headers, Mapping) else headers
    for key, value in items:
        if str(key).lower() == name:
            return None if value is None else str(value)
    return None


def _reject_constant(name: str) -> Any:
    raise ValueError(f"Unexpected token {name}")


def _parse_json(body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8-sig", errors="replace"), parse_constant=_reject_constant)
    except (ValueError, RecursionError) as error:
        raise InvalidJSONResponse(f"Coinbase returned invalid JSON ({error})") from None


# --------------------------------------------------------------------------- default transport

def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


class _Tracker:
    """Remembers the live connection so another thread can close it to abort a blocked request."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._conn: http.client.HTTPConnection | None = None
        self.aborted = False

    def set(self, conn: http.client.HTTPConnection) -> None:
        with self._lock:
            self._conn = conn
            aborted = self.aborted
        if aborted:
            self._close(conn)

    def abort(self) -> None:
        with self._lock:
            self.aborted = True
            conn = self._conn
        if conn is not None:
            self._close(conn)

    @staticmethod
    def _close(conn: http.client.HTTPConnection) -> None:
        sock = conn.sock
        try:
            if sock is not None:
                sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            conn.close()
        except OSError:
            pass


def _opener(tracker: _Tracker, loopback: bool) -> urllib.request.OpenerDirector:
    class Plain(http.client.HTTPConnection):
        def connect(self) -> None:
            super().connect()
            tracker.set(self)

    class Secure(http.client.HTTPSConnection):
        def connect(self) -> None:
            super().connect()
            tracker.set(self)

    class PlainHandler(urllib.request.HTTPHandler):
        def http_open(self, req: Any) -> Any:
            return self.do_open(Plain, req)

    class SecureHandler(urllib.request.HTTPSHandler):
        def https_open(self, req: Any) -> Any:
            return self.do_open(Secure, req, context=getattr(self, "_context", None))

    handlers: list[Any] = [PlainHandler(), SecureHandler()]
    # Loopback (tests, local fixtures) never goes through an environment proxy; real hosts honour
    # HTTP(S)_PROXY / NO_PROXY exactly as urllib does.
    if loopback:
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


def default_transport(url: str, timeout: float, cancel: threading.Event | None = None) -> tuple[int, dict, bytes]:
    """GET `url`; returns (status, lower-cased headers, body bytes).

    `timeout` bounds the whole request including the body. The request runs on a worker thread so a
    set `cancel` event (polled every 20 ms) or an expired timeout closes the socket immediately.
    """
    tracker = _Tracker()
    outcome: dict[str, Any] = {}
    finished = threading.Event()
    host = urlsplit(url).hostname or ""

    def work() -> None:
        try:
            request = urllib.request.Request(url, headers={"Accept": "application/json",
                                                           "User-Agent": "paper-trail-candles/1"})
            try:
                response = _opener(tracker, _is_loopback(host)).open(request, timeout=timeout)
            except urllib.error.HTTPError as error:  # a non-2xx status is still a response
                response = error
            with response:
                body = response.read()
                outcome["ok"] = (int(response.status), {k.lower(): v for k, v in response.headers.items()}, body)
        except BaseException as error:  # noqa: BLE001 - re-raised on the calling thread
            outcome["error"] = error
        finally:
            finished.set()

    threading.Thread(target=work, name="candle-request", daemon=True).start()
    deadline = time.monotonic() + timeout
    while not finished.wait(0.02):
        if cancel is not None and cancel.is_set():
            tracker.abort()
            raise Cancelled()
        if time.monotonic() >= deadline:
            tracker.abort()
            raise TransportTimeout(f"timed out after {timeout:g} seconds")
    if cancel is not None and cancel.is_set():
        raise Cancelled()
    if "ok" in outcome:
        return outcome["ok"]
    error = outcome["error"]
    reason = getattr(error, "reason", error)
    if isinstance(error, (TimeoutError, socket.timeout)) or isinstance(reason, (TimeoutError, socket.timeout)):
        raise TransportTimeout("timed out") from None
    raise TransportError(str(reason) or error.__class__.__name__) from None


default_transport.cancellable = True  # type: ignore[attr-defined]  # accepts the `cancel=` keyword


# --------------------------------------------------------------------------- results

@dataclass
class FetchResult:
    """What `fetch_range` retrieved. `series` is `{asset: [{time, price}]}` in time order."""

    start: int
    end: int
    half_spread_bps: float
    warmup_minutes: int
    history_limit: int
    required_history: int
    series: dict[str, list[dict[str, Any]]]
    coverage: dict[str, dict[str, Any]]
    receipts: list[dict[str, Any]]
    raw_responses: list[dict[str, Any]]
    captured_at_ms: int
    retrieval_elapsed_ms: int
    shared_count: int
    _frames: list[dict[str, Any]] | None = field(default=None, repr=False, compare=False)

    @property
    def provenance(self) -> list[dict[str, Any]]:
        """Per-request receipts in the browser's shape (no `rowCount`)."""
        return [{k: v for k, v in receipt.items() if k != "rowCount"} for receipt in self.receipts]

    def candles(self) -> dict[str, list[dict[str, Any]]]:
        """The mapping `replay.range_dataset` consumes."""
        return self.series

    def frames(self) -> list[dict[str, Any]]:
        """Scored frames: shared minutes inside [start, end], each with up to `history_limit` rows per asset.

        History lists share row objects with `series` (like the browser's lazy views); do not mutate them.
        """
        if self._frames is None:
            self._frames = build_frames(self.series, self.start, self.end, self.half_spread_bps, self.history_limit)
        return self._frames

    def dataset(self) -> dict[str, Any]:
        """The dataset `fetchHistoricalRange` returns, key for key."""
        frames = self.frames()
        return {
            "source": "Coinbase Exchange public historical one-minute candles",
            "capturedAt": iso(self.captured_at_ms),
            "periodStart": self.start, "periodEnd": self.end, "scoreStart": self.start, "scoreEnd": self.end,
            "frames": frames, "coverage": self.coverage, "provenance": self.provenance,
            "assumptions": {
                "halfSpreadBps": self.half_spread_bps,
                "spread": "Assumed historical bid/ask; not observed executable quotes",
                "missingMinutes": "Only shared observed close timestamps are scored; per-asset histories retain "
                                  "separate observed minutes, never filled.",
                "timestamps": "Candle bucket start +60 seconds; actual publication latency not modeled.",
                "warmup": "Only frame.history includes pre-start observations; eight observations needed for "
                          "default trend, 241 for maximum lookback.",
                "execution": "Hypothetical fills omit latency, market impact, liquidity and queue position."},
            "documentation": {"candles": DOC},
            "evidence": {
                "requestedStart": self.start, "requestedEnd": self.end, "warmupMinutes": self.warmup_minutes,
                "historyLimit": self.history_limit, "requiredHistory": self.required_history,
                "retrievalElapsedMs": self.retrieval_elapsed_ms, "sharedCount": len(frames),
                "prices": self.series, "rawResponses": self.raw_responses,
                "storage": "Compact prices and raw responses preserve source evidence. Frames expose lazy history "
                           "views; export evidence instead of JSON-stringifying all frames."}}


def build_frames(series: Mapping[str, list[dict[str, Any]]], start: int, end: int, half_spread_bps: float,
                 history_limit: int) -> list[dict[str, Any]]:
    """Frames exactly as `fetchHistoricalRange` builds them (shared BTC/LINK minutes inside the range)."""
    from .canonical import js_number

    index = {a: {row["time"]: i for i, row in enumerate(series[a])} for a in ASSETS}
    half = half_spread_bps / 10000
    label = f"Historical Coinbase close with ASSUMED {js_number(half_spread_bps)} bps half-spread"
    frames = []
    for row in series["BTC"]:
        time_ = row["time"]
        if time_ < start or time_ > end or time_ not in index["LINK"]:
            continue
        quotes, history = {}, {}
        for asset in ASSETS:
            i = index[asset][time_]
            mid = series[asset][i]["price"]
            quotes[asset] = {"bid": mid * (1 - half), "ask": mid * (1 + half), "mid": mid, "observedAt": time_,
                             "source": label, "simulatedQuote": True}
            history[asset] = series[asset][max(0, i - history_limit + 1):i + 1]
        frames.append({"time": time_, "quotes": quotes, "history": history})
    return frames


# --------------------------------------------------------------------------- fetcher

class CandleFetcher:
    """Retrieves one-minute candles for BTC and LINK. Thread-safe per call (no shared mutable state)."""

    def __init__(self, base_url: str | None = None, transport: Transport | None = None,
                 sleep: Callable[[float], None] | None = None, clock: Callable[[], int] | None = None,
                 min_interval: float = 0.35, attempts: int = 3, timeout: float = 15.0) -> None:
        """`transport(url, timeout) -> (status, headers, body_bytes)`; `sleep(seconds)`; `clock() -> epoch ms`.

        With the default transport/sleep, waits wake immediately on cancel and in-flight requests are
        aborted. An injected `sleep` is called as `sleep(seconds)` and cancellation is checked after it.
        """
        base = base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL
        self.base_url = base.rstrip("/")
        self._transport = transport or default_transport
        self._sleep = sleep
        self._clock = clock or (lambda: time.time_ns() // 1_000_000)
        self.min_interval = min_interval
        self.attempts = attempts
        self.timeout = timeout

    # ---- helpers
    @staticmethod
    def _check(cancel: threading.Event | None) -> None:
        if cancel is not None and cancel.is_set():
            raise Cancelled()

    def _wait(self, seconds: float, cancel: threading.Event | None) -> None:
        self._check(cancel)
        if self._sleep is not None:
            self._sleep(seconds)
        elif cancel is not None:
            if cancel.wait(seconds):
                raise Cancelled()
        else:
            time.sleep(seconds)
        self._check(cancel)

    def _call(self, url: str, cancel: threading.Event | None) -> tuple[int, Any, bytes]:
        if getattr(self._transport, "cancellable", False):
            return self._transport(url, self.timeout, cancel=cancel)
        return self._transport(url, self.timeout)

    def url_for(self, asset: str, start: int, end: int) -> str:
        query = urllib.parse.urlencode({"granularity": "60", "start": iso(start), "end": iso(end)})
        return f"{self.base_url}/products/{asset}-USD/candles?{query}"

    def _request(self, url: str, cancel: threading.Event | None) -> tuple[Any, dict[str, Any]]:
        """One logical request with retries; returns (parsed JSON, receipt without asset)."""
        for attempt in range(self.attempts):
            self._check(cancel)
            try:
                status, headers, body = self._call(url, cancel)
                self._check(cancel)
                if not 200 <= status < 300:
                    error = CandleError(f"Coinbase HTTP {status}")
                    error.retryable = status == 429 or status >= 500
                    raise error
                rows = _parse_json(body)
                received_at = self._clock()
                receipt = {"url": url, "receivedAt": received_at, "httpDate": _header(headers, "date"),
                           "sha256": hashlib.sha256(body).hexdigest(), "attempts": attempt + 1,
                           "rowCount": len(rows) if isinstance(rows, list) else 0}
                return rows, receipt
            except Cancelled:
                raise
            except Exception as error:  # noqa: BLE001
                self._check(cancel)
                if not isinstance(error, CandleError):
                    error = NetworkFailure("Coinbase request timed out" if isinstance(error, TransportTimeout)
                                           else f"Coinbase request failed: {error}")
                if attempt == self.attempts - 1 or error.retryable is False:
                    raise error from None
            self._wait(500 * 2 ** attempt / 1000, cancel)
        raise AssertionError("unreachable")  # pragma: no cover

    # ---- the port
    def fetch_range(self, start: Any, end: Any, *, half_spread_bps: float = 2, warmup_minutes: int = 60,
                    history_limit: int = 8, required_history: int = 0, cancel: threading.Event | None = None,
                    progress: ProgressCallback | None = None) -> FetchResult:
        """Port of `fetchHistoricalRange`. Raises `CandleError` (a `ValueError`) with replay.js's messages,
        or `Cancelled` when `cancel` is set. `progress(phase, completed, total, asset, message)`."""
        notify = progress or (lambda *args: None)
        s, e = stamp(start), stamp(end)
        now = self._clock()
        if e <= s or e - s > MAX_DAYS * 86400000:
            raise CandleError("Choose a positive range of at most 31 days")
        if e > now // MINUTE * MINUTE:
            raise CandleError("End must be a completed UTC minute")
        if not _is_integer(warmup_minutes) or warmup_minutes < 1 or warmup_minutes > 1440:
            raise CandleError("warmupMinutes must be 1 to 1440")
        if not _is_integer(history_limit) or history_limit < 2 or history_limit > 241:
            raise CandleError("historyLimit must be 2 to 241")
        if not _is_integer(required_history) or required_history < 0 or required_history > history_limit:
            raise CandleError("requiredHistory must be 0 to historyLimit")
        warmup_minutes, history_limit, required_history = int(warmup_minutes), int(history_limit), int(required_history)
        if warmup_minutes < history_limit - 1:
            raise CandleError("Warmup must span at least historyLimit minus one minutes")
        if not _is_number(half_spread_bps) or not math.isfinite(half_spread_bps) \
                or half_spread_bps < 0 or half_spread_bps > 1000:
            raise CandleError("Invalid assumed half-spread")
        self._check(cancel)
        began = self._clock()
        first = s - warmup_minutes * MINUTE
        chunks = []
        t = first - MINUTE
        while t < e:
            chunks.append((t, min(t + CHUNK_MINUTES * MINUTE, e)))
            t += CHUNK_MINUTES * MINUTE
        total = len(chunks) * 2
        series: dict[str, list[dict[str, Any]]] = {}
        coverage: dict[str, dict[str, Any]] = {}
        receipts: list[dict[str, Any]] = []
        raw_responses: list[dict[str, Any]] = []
        completed = 0
        notify("fetch", completed, total, None, "Fetching completed UTC minutes")
        for asset in ASSETS:
            seen: dict[int, tuple[float, list]] = {}
            duplicates = 0
            for chunk_start, chunk_end in chunks:
                if completed:
                    self._wait(self.min_interval, cancel)
                rows, receipt = self._request(self.url_for(asset, chunk_start, chunk_end), cancel)
                self._check(cancel)
                if not isinstance(rows, list):
                    raise CandleError(f"{asset}: invalid candle response")
                for row in rows:
                    if not isinstance(row, list) or len(row) != 6:
                        raise CandleError(f"{asset}: invalid candle row")
                    bucket, low, high, open_, close, volume = row
                    if not (_is_integer(bucket) and abs(int(bucket)) <= MAX_SAFE_INTEGER and int(bucket) % 60 == 0) \
                            or not all(_finite(v) for v in (low, high, open_, close, volume)) \
                            or min(low, high, open_, close) <= 0 or volume < 0 \
                            or low > min(open_, close) or high < max(open_, close):
                        raise CandleError(f"{asset}: invalid candle values")
                    time_ = int(bucket) * 1000 + MINUTE
                    if time_ < first or time_ > e:
                        continue
                    if time_ in seen:
                        duplicates += 1
                        if seen[time_][1] != row:
                            raise CandleError(f"{asset}: conflicting duplicate candle")
                    else:
                        seen[time_] = (float(close), row)
                receipts.append({"asset": asset, **receipt})
                raw_responses.append({"asset": asset, **{k: v for k, v in receipt.items() if k != "rowCount"},
                                      "rows": rows})
                completed += 1
                notify("fetch", completed, total, asset, f"{asset}: {completed}/{total} batches")
            values = sorted(seen)
            series[asset] = [{"time": t, "price": seen[t][0]} for t in values]
            expected = (e - s) // MINUTE + 1
            missing = [t for t in range(s, e + 1, MINUTE) if t not in seen]
            coverage[asset] = {
                "expectedCount": expected, "observedCount": expected - len(missing), "missingCount": len(missing),
                "missingTimes": missing, "missingFraction": len(missing) / expected,
                "startPresent": s in seen, "endPresent": e in seen,
                "warmupObservedCount": sum(1 for t in values if t < s), "duplicateRows": duplicates}
        self._check(cancel)
        if any(not coverage[a]["startPresent"] or not coverage[a]["endPresent"] for a in ASSETS):
            error = CandleError("Exact start/end close missing for one or both assets; boundaries were not changed")
            error.coverage = coverage
            raise error
        for asset in ASSETS:
            available = sum(1 for row in series[asset] if row["time"] <= s)
            if available < required_history:
                raise CandleError(f"{asset}: only {available} causal observations at scored start; "
                                  f"{required_history} required. Choose a smaller lookback or another range. "
                                  "No run was created.")
        btc_times = {row["time"] for row in series["BTC"]}
        link_times = {row["time"] for row in series["LINK"]}
        shared = sum(1 for t in btc_times if s <= t <= e and t in link_times)
        notify("complete", completed, total, None, f"{shared} shared scored minutes")
        captured = self._clock()
        elapsed = self._clock() - began
        return FetchResult(start=s, end=e, half_spread_bps=half_spread_bps, warmup_minutes=warmup_minutes,
                           history_limit=history_limit, required_history=required_history, series=series,
                           coverage=coverage, receipts=receipts, raw_responses=raw_responses,
                           captured_at_ms=captured, retrieval_elapsed_ms=elapsed, shared_count=shared)
