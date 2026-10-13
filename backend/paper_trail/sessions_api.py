"""Stepwise replay session routes. CONTRACT STUB: paths, models and error codes are fixed by the lead;
bodies are implemented by the backend owner (see docs/BACKEND_MIGRATION.md)."""
from __future__ import annotations

from fastapi import APIRouter, Request

from .candle_jobs import CandleJobService, candle_source
from .errors import ApiProblem
from .configuration import normalize_settings
from .records import RunStore
from .sessions import SessionService
from .schemas import (AdvanceRequest, ApiError, CloseRequest, OrderRequest, SaveRequest, SessionAccount,
                      SessionCreate, SessionSave, SessionState, SessionStep, TickRequest)

ERRORS = {code: {"model": ApiError} for code in (404, 409, 422, 429)}


def build_router(runs: RunStore, jobs: CandleJobService | None = None) -> APIRouter:
    """`jobs` defaults to the app's `app.state.candle_jobs` (read per request)."""
    router = APIRouter(prefix="/v1/sessions", tags=["sessions"])
    service = SessionService(runs)

    @router.post("", response_model=SessionState, response_model_exclude_unset=True, status_code=201, responses=ERRORS,
                 operation_id="createSession", summary="Start a stepwise replay session (first frame ingested)")
    def create_session(body: SessionCreate, request: Request) -> SessionState:
        if body.settings.config.mode == "live" and (body.candles is not None or body.candleJobId is not None):
            raise ApiProblem(422, "replay_rejected", "Live sessions fetch their own quotes; candles are not accepted")
        try:
            settings = normalize_settings(body.settings.model_dump(exclude_none=True))
            candles, fetched = candle_source(jobs or request.app.state.candle_jobs, body.candles, body.candleJobId, settings)
            return service.create(settings, candles, body.name, fetched)
        except ValueError as error:
            raise ApiProblem(422, "replay_rejected", str(error)) from None

    @router.get("/{session_id}", response_model=SessionState, responses=ERRORS, operation_id="getSession")
    def get_session(session_id: str) -> SessionState:
        return service.get(session_id)

    @router.get("/{session_id}/account", response_model=SessionAccount, response_model_exclude_unset=True,
                responses=ERRORS, operation_id="getSessionAccount", summary="Full account: ledger, forecasts, equity")
    def get_session_account(session_id: str) -> SessionAccount:
        return service.get_account(session_id)

    @router.post("/{session_id}/advance", response_model=SessionStep, response_model_exclude_unset=True,
                 responses=ERRORS, operation_id="advanceSession", summary="Ingest the next frame(s), causally")
    def advance(session_id: str, body: AdvanceRequest) -> SessionStep:
        return service.advance(session_id, body.expectedVersion, body.mode, body.count)

    @router.post("/{session_id}/orders", response_model=SessionStep, response_model_exclude_unset=True,
                 responses=ERRORS, operation_id="placeOrder", summary="Manual paper order at the current frame")
    def place_order(session_id: str, body: OrderRequest) -> SessionStep:
        return service.order(session_id, body.expectedVersion, body.asset, body.side, body.dollars)

    @router.post("/{session_id}/save", response_model=SessionSave, response_model_exclude_unset=True,
                 responses=ERRORS, operation_id="saveSession", summary="Snapshot the session into run history (same run id)")
    def save(session_id: str, body: SaveRequest) -> SessionSave:
        return service.save(session_id, body.expectedVersion, body.name)

    @router.delete("/{session_id}", response_model=SessionState, responses=ERRORS, operation_id="closeSession",
                   summary="Close the session and release its run id (saved snapshots remain)")
    def close(session_id: str, body: CloseRequest | None = None) -> SessionState:
        return service.close(session_id, body.expectedVersion if body else None)

    @router.post("/{session_id}/tick", response_model=SessionStep, response_model_exclude_unset=True,
                 responses={**ERRORS, 502: {"model": ApiError}}, operation_id="tickSession",
                 summary="Live paper session: fetch fresh public quotes server-side and ingest them")
    def tick(session_id: str, body: TickRequest) -> SessionStep:
        return service.tick(session_id, body.expectedVersion)

    return router
