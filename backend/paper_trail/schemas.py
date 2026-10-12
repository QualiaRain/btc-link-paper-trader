"""Typed API contract (v1). FastAPI turns these models into `contract/openapi.json`,
from which the TypeScript client types are generated."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, StrictStr

Number = StrictInt | StrictFloat
Asset = Literal["BTC", "LINK"]
Model = Literal["trend", "same-price"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ConfigInput(Strict):
    """Frozen account rules. Omitted fields take the documented defaults ($1,000 cash, 7-minute horizon, ...)."""
    mode: Literal["replay", "live"] | None = Field(None, description="This service only runs replays; `live` is accepted in settings files but refused by /v1/replays.")
    initialCash: Number | None = Field(None, description="Starting simulated cash in USD.")
    horizonMs: Number | None = Field(None, description="Forecast horizon; one of 1, 5, 7, 15, 60, 420 or 1440 minutes.")
    model: Model | None = None
    lookbackIntervals: Number | None = Field(None, description="Earlier completed observations used by the trend rule (1-240).")
    bufferBps: Number | None = None
    allocationFraction: Number | None = Field(None, description="Fraction of available cash per asset, 0 to 0.5.")
    stopLossBps: Number | None = Field(None, description="0 disables the stop loss.")
    feeBps: Number | None = None
    slippageBps: Number | None = None
    durationMs: Number | None = Field(None, description="Live-session duration; replay uses the scored range instead.")
    maxQuoteAgeMs: Number | None = None
    maxOutcomeLatenessMs: Number | None = None


class Config(BaseModel):
    """Normalized, frozen rules."""
    mode: Literal["replay", "live"]
    initialCash: float
    horizonMs: float
    model: Model
    lookbackIntervals: int
    bufferBps: float
    allocationFraction: float
    stopLossBps: float
    feeBps: float
    slippageBps: float
    durationMs: float
    maxQuoteAgeMs: float
    maxOutcomeLatenessMs: float


class ReplaySettingsInput(Strict):
    source: Literal["sample", "range"] | None = None
    start: StrictStr | None = Field(None, description="UTC minute `YYYY-MM-DDTHH:MM` (range source).")
    end: StrictStr | None = Field(None, description="UTC minute `YYYY-MM-DDTHH:MM` (range source).")
    halfSpreadBps: Number | None = Field(None, description="Assumed half-spread each side of the close, 0-1000 bps.")


class ReplaySettings(BaseModel):
    source: Literal["sample", "range"]
    start: str
    end: str
    halfSpreadBps: float


class SettingsInput(Strict):
    format: Literal["paper-trail-settings-v2"] | None = None
    config: ConfigInput
    replay: ReplaySettingsInput | None = None


class Settings(BaseModel):
    format: Literal["paper-trail-settings-v2"]
    config: Config
    replay: ReplaySettings


class Candle(Strict):
    time: StrictInt = Field(description="UTC close of the completed minute, in epoch milliseconds.")
    price: Number = Field(description="Close price.")


class CandleSeries(Strict):
    BTC: list[Candle]
    LINK: list[Candle]


class ReplayRequest(Strict):
    settings: SettingsInput
    name: StrictStr | None = Field(None, max_length=100)
    candles: CandleSeries | None = Field(
        None, description="Required for the range source: completed one-minute closes, warmup included.")


class Position(BaseModel):
    model_config = ConfigDict(extra="allow")
    qty: float
    costBasis: float


class LedgerEvent(BaseModel):
    """Ledger entry; fields beyond the common ones depend on `type`."""
    model_config = ConfigDict(extra="allow")
    id: int
    type: str
    time: float
    at: str


class Forecast(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    asset: Asset
    model: Model
    issuedAt: float
    targetAt: float
    anchor: float
    prediction: float
    historyEnd: float | None
    status: Literal["pending", "settled", "expired"]
    observedAt: float | None
    actual: float | None
    latenessMs: float | None


class EquityPoint(BaseModel):
    time: float
    at: str
    value: float
    buyHoldValue: float
    cashValue: float


class Positions(BaseModel):
    BTC: Position
    LINK: Position


class Baseline(BaseModel):
    cash: float
    positions: Positions


class Account(BaseModel):
    config: Config
    cash: float
    positions: Positions
    ledger: list[LedgerEvent]
    forecasts: list[Forecast]
    equity: list[EquityPoint]
    startedAt: float | None
    endsAt: float | None
    lastDecisionAt: float | None
    lastFrameAt: float | None
    lastValidFrameAt: float | None
    status: Literal["ready", "running", "completed"]
    baseline: Baseline
    sequence: int


class AssetSummary(BaseModel):
    count: int
    mae: float | None
    samePriceMae: float | None
    qty: float


class PerAsset(BaseModel):
    BTC: AssetSummary
    LINK: AssetSummary


class Summary(BaseModel):
    status: str
    equity: float
    cash: float
    returnPct: float
    buyHoldEquity: float
    buyHoldReturnPct: float
    cashBenchmark: float
    drawdownPct: float
    maxDrawdownPct: float
    fees: float
    tradeCount: int
    forecastCount: int
    settledForecasts: int
    pendingForecasts: int
    expiredForecasts: int
    mae: float | None
    samePriceMae: float | None
    perAsset: PerAsset
    valuationAt: float | None
    valuationIsNetLiquidation: bool


class Hashes(BaseModel):
    algorithm: str
    configSha256: str
    marketSha256: str


class RunMetadata(BaseModel):
    id: str
    name: str | None
    createdAt: str | None
    updatedAt: str | None
    status: str | None
    config: dict[str, Any]
    summary: Summary
    hashes: Hashes
    manualTradeCount: int
    source: str
    scoreStart: float | None
    scoreEnd: float | None


class RunRecord(BaseModel):
    """Full `paper-trail-run-v2` record: frozen config, account, ledger, summary, evidence and hashes."""
    model_config = ConfigDict(extra="allow")
    format: Literal["paper-trail-run-v2"]
    id: str
    name: str
    createdAt: str
    updatedAt: str
    status: str
    config: dict[str, Any]
    summary: Summary
    account: Account
    market: dict[str, Any] | None
    hashes: Hashes
    manualTradeCount: int


class ReplayResult(BaseModel):
    run: RunMetadata
    summary: Summary
    account: Account


class RunList(BaseModel):
    runs: list[RunMetadata]


class Health(BaseModel):
    status: Literal["ok"]
    apiVersion: str
    engine: str
    realTrading: Literal[False] = False


class Defaults(BaseModel):
    settings: Settings
    horizonsMs: list[int]


class ErrorBody(BaseModel):
    code: str
    message: str
    currentVersion: int | None = Field(None, description="Set on `stale_session`: the session's current version.")


class ApiError(BaseModel):
    error: ErrorBody


JsonObject = Annotated[dict[str, Any], Field(description="A `paper-trail-run-v2` record exported by this service or by the browser app.")]


# ---- Stepwise replay sessions (API v1) ---------------------------------------------------------
# A session holds one replay on the server and reveals it causally: only frames already ingested are
# ever visible. Every state-changing call carries `expectedVersion`; a mismatch is a 409 `stale_session`
# and changes nothing. A session owns exactly one run id; only that session can write snapshots to it.


class Quote(BaseModel):
    bid: float
    ask: float
    mid: float
    observedAt: float
    source: str | None = None


class Quotes(BaseModel):
    BTC: Quote
    LINK: Quote


class FrameView(BaseModel):
    """The latest ingested market frame. Later frames are never exposed."""
    time: float
    quotes: Quotes


class SessionCreate(Strict):
    settings: SettingsInput
    name: StrictStr | None = Field(None, max_length=100)
    candles: CandleSeries | None = Field(None, description="Required for the range source (as for /v1/replays).")


class SessionState(BaseModel):
    id: str
    runId: str = Field(description="Stable id of the run this session saves to; owned by this session while it is open.")
    status: Literal["active", "completed", "closed"]
    version: int = Field(description="Increments on every state change; send it back as `expectedVersion`.")
    kind: Literal["sample", "historical"]
    cursor: int = Field(description="Index of the latest ingested frame in the dataset.")
    frameCount: int
    warmupFrameCount: int
    scoreStart: float
    scoreEnd: float
    currentFrame: FrameView
    nextDecisionAt: float | None = Field(description="When the next automatic decision is due (null once completed).")
    config: Config
    summary: Summary
    savedVersion: int | None = Field(description="Session version captured by the latest snapshot, null if never saved.")
    manualTradeCount: int


class AdvanceRequest(Strict):
    mode: Literal["frames", "decision", "finish"] = Field(
        description="`frames`: ingest `count` frames; `decision`: until the next automatic decision is due; `finish`: to the end.")
    count: StrictInt = Field(1, ge=1, le=1000, description="Only used by mode `frames`.")
    expectedVersion: StrictInt


class OrderRequest(Strict):
    asset: Asset
    side: Literal["buy", "sell"]
    dollars: Number | None = Field(None, description="Buy: dollars to spend (required, > 0). Sell: net proceeds wanted; omit to sell the whole position.")
    expectedVersion: StrictInt


class SaveRequest(Strict):
    expectedVersion: StrictInt
    name: StrictStr | None = Field(None, max_length=100)


class CloseRequest(Strict):
    expectedVersion: StrictInt | None = None


class SessionStep(BaseModel):
    state: SessionState
    events: list[LedgerEvent] = Field(description="Ledger events produced by this call, in order.")
    framesIngested: int


class SessionAccount(BaseModel):
    state: SessionState
    account: Account


class SessionSave(BaseModel):
    run: RunMetadata
    state: SessionState
