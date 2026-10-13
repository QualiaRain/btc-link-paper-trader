"""Candle job routes (server-side retrieval of completed one-minute closes with receipts and cancellation).
Paths, models and error codes are fixed by the contract; behaviour lives in `candle_jobs.CandleJobService`."""
from __future__ import annotations

from fastapi import APIRouter

from .candle_jobs import CandleJobService
from .schemas import ApiError, CandleJob, CandleJobCreate

ERRORS = {code: {"model": ApiError} for code in (404, 409, 422, 429)}


def build_router(service: CandleJobService | None = None) -> APIRouter:
    """The `/v1/candle-jobs` routes backed by `service` (a new one when omitted; also at `router.candle_jobs`)."""
    jobs = service or CandleJobService()
    router = APIRouter(prefix="/v1/candle-jobs", tags=["candles"])
    router.candle_jobs = jobs  # type: ignore[attr-defined]

    @router.post("", response_model=CandleJob, status_code=202, responses=ERRORS, operation_id="createCandleJob",
                 summary="Start retrieving completed one-minute closes for BTC and LINK (public data, no keys)")
    def create_job(body: CandleJobCreate) -> dict:
        return jobs.create(body.start, body.end, body.lookbackIntervals, body.model)

    @router.get("/{job_id}", response_model=CandleJob, responses=ERRORS, operation_id="getCandleJob",
                summary="Progress, receipts and coverage")
    def get_job(job_id: str) -> dict:
        return jobs.get(job_id)

    @router.post("/{job_id}/cancel", response_model=CandleJob, responses=ERRORS, operation_id="cancelCandleJob",
                 summary="Cancel a running job; no run is created from it")
    def cancel_job(job_id: str) -> dict:
        return jobs.cancel(job_id)

    return router
