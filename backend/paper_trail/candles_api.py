"""Candle job routes (server-side retrieval of completed one-minute closes with receipts and cancellation).
CONTRACT STUB: paths, models and error codes are fixed by the lead; bodies are implemented by the backend owner."""
from __future__ import annotations

from fastapi import APIRouter

from .errors import ApiProblem
from .schemas import ApiError, CandleJob, CandleJobCreate

ERRORS = {code: {"model": ApiError} for code in (404, 409, 422, 429)}


def build_router() -> APIRouter:
    router = APIRouter(prefix="/v1/candle-jobs", tags=["candles"])

    def not_implemented() -> ApiProblem:
        return ApiProblem(501, "not_implemented", "Not implemented yet")

    @router.post("", response_model=CandleJob, status_code=202, responses=ERRORS, operation_id="createCandleJob",
                 summary="Start retrieving completed one-minute closes for BTC and LINK (public data, no keys)")
    def create_job(body: CandleJobCreate) -> CandleJob:
        raise not_implemented()

    @router.get("/{job_id}", response_model=CandleJob, responses=ERRORS, operation_id="getCandleJob",
                summary="Progress, receipts and coverage")
    def get_job(job_id: str) -> CandleJob:
        raise not_implemented()

    @router.post("/{job_id}/cancel", response_model=CandleJob, responses=ERRORS, operation_id="cancelCandleJob",
                 summary="Cancel a running job; no run is created from it")
    def cancel_job(job_id: str) -> CandleJob:
        raise not_implemented()

    return router
