"""Live public market data for paper-mode sessions: a port of market.js `fetchLiveMarket`.

Only public, read-only, unauthenticated Coinbase Exchange endpoints are used (candles and ticker per asset). No
credentials, cookies or keys are sent, redirects are not followed, and nothing here can place an order. The base
URL comes from `PAPER_TRAIL_LIVE_BASE_URL` (default `https://api.exchange.coinbase.com`) and is read at call time.

The transport (`url, timeout -> (status, body bytes)`) and the clock (`-> epoch ms`) are injectable so that tests
never touch the network. Validations and messages match market.js. Known differences:

* `Date.parse` is reimplemented for ISO-8601 timestamps (T or space separator, optional seconds/fraction, `Z` or an
  offset); a timestamp without an offset is read as UTC. Other legacy formats V8 accepts are rejected here.
* A body that is not JSON reports `Invalid JSON response` instead of the V8 `SyntaxError` text.
* The four reads run concurrently like `Promise.all`; when several fail, the first in BTC, LINK order (candles
  before ticker) is reported.
"""
from __future__ import annotations

import json
import math
import os
import re
import time as _time
import urllib.error
import urllib.parse
import urllib.request
from calendar import timegm
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any, Callable

from .engine import ASSETS

MINUTE = 60000
DEFAULT_BASE_URL = "https://api.exchange.coinbase.com"
TIMEOUT_SECONDS = 15
MAX_BODY_BYTES = 8_000_000
HORIZONS = frozenset(m * MINUTE for m in (1, 5, 7, 15, 60, 420, 1440))
DOCUMENTATION = {
    "ticker": "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker",
    "candles": "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles"}
ASSUMPTIONS = {
    "warmup": "Up to300 completed one-minute observations for every horizon; missing minutes are not filled.",
    "trend": "The core uses seven prior observations and actual elapsed time. Scaling a short recent trend to long "
             "horizons is an assumption, not calibrated predictive evidence.",
    "timestamps": "observedAt is local HTTP receipt time. exchangeTime is last-trade event time, not a separately "
                  "timestamped order-book update.",
    "execution": "Public snapshots are not executable orders. Paper fills omit latency, market impact and queue position."}

Transport = Callable[[str, float], "tuple[int, bytes]"]
Clock = Callable[[], float]


class LiveMarketError(Exception):
    """A live market read failed validation or could not be fetched; the message is shown to the caller."""


# ---- JavaScript-compatible primitives ---------------------------------------------------------------------
_DECIMAL = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_RADIX = re.compile(r"^0([xX][0-9a-fA-F]+|[bB][01]+|[oO][0-7]+)$")


def js_number(value: Any) -> float:
    """`Number(value)` for JSON values (NaN when not numeric)."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except OverflowError:
            return math.inf
    if value is None:
        return 0.0
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0.0
        radix = _RADIX.match(text)
        if radix:
            return float(int(text, {"x": 16, "b": 2, "o": 8}[text[1].lower()]))
        if text in ("Infinity", "+Infinity"):
            return math.inf
        if text == "-Infinity":
            return -math.inf
        return float(text) if _DECIMAL.match(text) else math.nan
    return math.nan


def price(value: Any) -> float:
    number = js_number(value)
    if not math.isfinite(number) or number <= 0:
        raise LiveMarketError("Invalid market price")
    return number


_ISO = re.compile(r"^(?P<y>\d{4})(?:-(?P<mo>\d{2})(?:-(?P<d>\d{2}))?)?"
                  r"(?:[T ](?P<h>\d{2}):(?P<mi>\d{2})(?::(?P<s>\d{2})(?:\.(?P<f>\d+))?)?"
                  r"(?P<z>[zZ]|[+-]\d{2}:?\d{2})?)?$")


def date_parse(text: Any) -> float:
    """`Date.parse` for ISO-8601 strings, as epoch milliseconds (NaN if unparseable)."""
    match = _ISO.match(text) if isinstance(text, str) else None
    if not match:
        return math.nan
    g = match.groupdict()
    year, month, day = int(g["y"]), int(g["mo"] or 1), int(g["d"] or 1)
    hour, minute, second = int(g["h"] or 0), int(g["mi"] or 0), int(g["s"] or 0)
    millis = int((g["f"] or "0")[:3].ljust(3, "0"))
    if not (1 <= month <= 12 and 1 <= day <= 31 and minute < 60 and second < 60 and hour <= 24
            and (hour < 24 or (minute == 0 and second == 0 and millis == 0))):
        return math.nan
    days = (date(year, month, 1) + timedelta(days=day - 1) - date(1970, 1, 1)).days  # day overflow rolls over, as in V8
    offset = 0
    if g["z"] and g["z"] not in ("z", "Z"):
        sign = -1 if g["z"][0] == "-" else 1
        digits = g["z"][1:].replace(":", "")
        offset = sign * (int(digits[:2]) * 60 + int(digits[2:]))
    return float(((days * 24 + hour) * 60 + minute - offset) * 60000 + second * 1000 + millis)


# ---- transport and clock -----------------------------------------------------------------------------------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def default_transport(url: str, timeout: float = TIMEOUT_SECONDS) -> tuple[int, bytes]:
    """GET `url` with no credentials or cookies and no redirects. HTTP errors return their status and body."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise OSError("Unsupported URL scheme")
    handlers: list[Any] = [_NoRedirect()]
    if parsed.hostname in ("127.0.0.1", "localhost", "::1"):
        handlers.append(urllib.request.ProxyHandler({}))  # loopback never goes through a proxy
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "paper-trail/1"})
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(MAX_BODY_BYTES)
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.read(MAX_BODY_BYTES)
        finally:
            error.close()


def default_clock() -> float:
    return float(int(_time.time() * 1000))


def base_url() -> str:
    return (os.environ.get("PAPER_TRAIL_LIVE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


# ---- port of market.js -------------------------------------------------------------------------------------
def _read_json(url: str, transport: Transport, clock: Clock) -> dict[str, Any]:
    try:
        status, body = transport(url, TIMEOUT_SECONDS)
        if not 200 <= status < 300:
            raise LiveMarketError(f"Market source HTTP {status}")
        try:
            data = json.loads(body, parse_constant=_reject_constant)
        except ValueError:
            raise LiveMarketError("Invalid JSON response") from None
        return {"data": data, "receivedAt": clock(), "url": url}
    except LiveMarketError as error:
        raise LiveMarketError(f"Market data unavailable ({url}): {error}") from None
    except (OSError, TimeoutError) as error:
        raise LiveMarketError(f"Market data unavailable ({url}): {error}") from None


def _reject_constant(name: str) -> None:
    raise ValueError(name)


def completed_history(rows: Any, received_at: float) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise LiveMarketError("Invalid Coinbase candle response")
    cutoff = math.floor(received_at / MINUTE) * MINUTE
    seen: dict[int, float] = {}
    for row in rows:
        if not isinstance(row, list) or len(row) != 6:
            raise LiveMarketError("Invalid candle row")
        bucket = js_number(row[0]) * 1000
        if not math.isfinite(bucket) or bucket != math.floor(bucket) or abs(bucket) > 2 ** 53 - 1 or bucket % MINUTE:
            raise LiveMarketError("Invalid minute bucket")
        close_time = int(bucket) + MINUTE
        if close_time > cutoff:
            continue
        low, high, opened, close = price(row[1]), price(row[2]), price(row[3]), price(row[4])
        if low > min(opened, close) or high < max(opened, close):
            raise LiveMarketError("Invalid candle OHLC bounds")
        if close_time in seen and seen[close_time] != close:
            raise LiveMarketError("Conflicting duplicate minute")
        seen[close_time] = close
    history = [{"time": t, "price": p} for t, p in sorted(seen.items())[-300:]]
    if len(history) < 7:
        raise LiveMarketError("Fewer than seven completed candle observations")
    if received_at - history[-1]["time"] > 5 * MINUTE:
        raise LiveMarketError("Minute history is stale")
    return history


def _asset_read(asset: str, candles: dict, ticker: dict) -> dict[str, Any]:
    data = ticker["data"]
    if not isinstance(data, dict):
        raise LiveMarketError(f"{asset}: invalid ticker response")
    exchange_time = date_parse(data.get("time"))
    if not math.isfinite(exchange_time):
        raise LiveMarketError(f"{asset}: invalid exchange timestamp")
    age = ticker["receivedAt"] - exchange_time
    if age < -5000 or age > 120_000:
        raise LiveMarketError(f"{asset}: stale or future exchange trade timestamp")
    bid, ask = price(data.get("bid")), price(data.get("ask"))
    if bid > ask:
        raise LiveMarketError(f"{asset}: crossed bid/ask quote")
    history = completed_history(candles["data"], candles["receivedAt"])
    return {"asset": asset, "history": history,
            "quote": {"bid": bid, "ask": ask, "mid": (bid + ask) / 2, "observedAt": ticker["receivedAt"],
                      "receivedAt": ticker["receivedAt"], "exchangeTime": exchange_time,
                      "exchangeTimestamp": data.get("time"), "lastTradePrice": price(data.get("price")),
                      "source": "Coinbase Exchange public ticker bid/ask", "url": ticker["url"],
                      "simulatedQuote": False},
            "provenance": {"candlesURL": candles["url"], "candlesReceivedAt": candles["receivedAt"],
                           "tickerURL": ticker["url"], "tickerReceivedAt": ticker["receivedAt"],
                           "lastTradeAgeMs": age, "candleCount": len(candles["data"])}}


def fetch_live_market(horizon_ms: Any, transport: Transport | None = None, clock: Clock | None = None,
                      base: str | None = None) -> dict[str, Any]:
    """One live frame: per-asset completed-minute history plus a public ticker bid/ask. Raises LiveMarketError."""
    if horizon_ms not in HORIZONS:
        raise LiveMarketError("Unsupported forecast horizon")
    transport = transport or default_transport  # looked up per call so tests can substitute it
    clock = clock or default_clock
    root = (base or base_url()).rstrip("/")
    urls = [(f"{root}/products/{a}-USD/candles?granularity=60", f"{root}/products/{a}-USD/ticker") for a in ASSETS]
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [(pool.submit(_read_json, c, transport, clock), pool.submit(_read_json, t, transport, clock))
                       for c, t in urls]
            reads = [(f[0].result(), f[1].result()) for f in futures]
    except LiveMarketError:
        raise
    reads_by_asset = []
    for asset, (candles, ticker) in zip(ASSETS, reads):
        try:
            reads_by_asset.append(_asset_read(asset, candles, ticker))
        except (KeyError, TypeError, AttributeError):
            raise LiveMarketError(f"{asset}: invalid market response") from None
    now = clock()
    quotes, history, provenance = {}, {}, {}
    for item in reads_by_asset:
        quotes[item["asset"]] = item["quote"]
        history[item["asset"]] = [p for p in item["history"] if p["time"] <= now]
        provenance[item["asset"]] = item["provenance"]
    return {"time": now, "quotes": quotes, "history": history, "provenance": provenance, "horizonMs": horizon_ms,
            "source": "Coinbase Exchange public REST", "receivedAt": now, "documentation": dict(DOCUMENTATION),
            "assumptions": dict(ASSUMPTIONS)}


# ---- session helpers (app.js trimLive / start('live') / marketSnapshot) ---------------------------------------
def trim_live(frame: dict[str, Any], lookback: int) -> dict[str, Any]:
    """Keep the `lookback + 1` most recent observations per asset, as app.js `trimLive` does."""
    for asset in ASSETS:
        frame["history"][asset] = frame["history"][asset][-(lookback + 1):]
    return frame


def live_dataset(frame: dict[str, Any]) -> dict[str, Any]:
    """The dataset of a new live session (app.js `start('live')`): one frame, extended by every tick."""
    return {"kind": "live", "source": frame["source"], "documentation": frame["documentation"],
            "assumptions": frame["assumptions"], "frames": [frame], "cursor": 0, "warmupFrameCount": 0,
            "scoreStart": None, "scoreEnd": None}


def market_snapshot(settings: dict[str, Any], dataset: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
    """The `market` evidence app.js `marketSnapshot()` stores for a live run.

    `cursor` is 0 exactly as in the browser, where a live run never advances its cursor."""
    frames = dataset["frames"]
    return {"kind": "live",
            "dataset": {"source": dataset["source"], "documentation": dataset["documentation"],
                        "assumptions": dataset["assumptions"], "frames": frames},
            "cursor": 0, "lastObservedFrame": frames[-1],
            "scoreStart": account["startedAt"], "scoreEnd": account["endsAt"], "settings": settings}
