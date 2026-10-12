"""Stepwise replay session routes. CONTRACT STUB: paths, models and error codes are fixed by the lead;
bodies are implemented by the backend owner (see docs/BACKEND_MIGRATION.md)."""
from __future__ import annotations

from fastapi import APIRouter

from .errors import ApiProblem
from .records import RunStore
from .schemas import (AdvanceRequest, ApiError, CloseRequest, OrderRequest, SaveRequest, SessionAccount,
                      SessionCreate, SessionSave, SessionState, SessionStep)

ERRORS = {code: {"model": ApiError} for code in (404, 409, 422, 429)}


def build_router(runs: RunStore) -> APIRouter:
    router = APIRouter(prefix="/v1/sessions", tags=["sessions"])

    def not_implemented() -> ApiProblem:
        return ApiProblem(501, "not_implemented", "Not implemented yet")

    @router.post("", response_model=SessionState, response_model_exclude_unset=True, status_code=201, responses=ERRORS,
                 operation_id="createSession", summary="Start a stepwise replay session (first frame ingested)")
    def create_session(body: SessionCreate) -> SessionState:
        raise not_implemented()

    @router.get("/{session_id}", response_model=SessionState, responses=ERRORS, operation_id="getSession")
    def get_session(session_id: str) -> SessionState:
        raise not_implemented()

    @router.get("/{session_id}/account", response_model=SessionAccount, response_model_exclude_unset=True,
                responses=ERRORS, operation_id="getSessionAccount", summary="Full account: ledger, forecasts, equity")
    def get_session_account(session_id: str) -> SessionAccount:
        raise not_implemented()

    @router.post("/{session_id}/advance", response_model=SessionStep, response_model_exclude_unset=True,
                 responses=ERRORS, operation_id="advanceSession", summary="Ingest the next frame(s), causally")
    def advance(session_id: str, body: AdvanceRequest) -> SessionStep:
        raise not_implemented()

    @router.post("/{session_id}/orders", response_model=SessionStep, response_model_exclude_unset=True,
                 responses=ERRORS, operation_id="placeOrder", summary="Manual paper order at the current frame")
    def place_order(session_id: str, body: OrderRequest) -> SessionStep:
        raise not_implemented()

    @router.post("/{session_id}/save", response_model=SessionSave, response_model_exclude_unset=True,
                 responses=ERRORS, operation_id="saveSession", summary="Snapshot the session into run history (same run id)")
    def save(session_id: str, body: SaveRequest) -> SessionSave:
        raise not_implemented()

    @router.delete("/{session_id}", response_model=SessionState, responses=ERRORS, operation_id="closeSession",
                   summary="Close the session and release its run id (saved snapshots remain)")
    def close(session_id: str, body: CloseRequest | None = None) -> SessionState:
        raise not_implemented()

    return router
