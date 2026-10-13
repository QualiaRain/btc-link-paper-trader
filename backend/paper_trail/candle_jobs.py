"""Background candle-retrieval jobs: start, observe, cancel and hand the result to a replay.

A job runs `CandleFetcher.fetch_range` on its own daemon thread with a `threading.Event`, so cancelling a job
abandons even a request that is waiting on a slow server within a fraction of a second. At most a handful of jobs
run at once, finished jobs are kept in a bounded table, and only a few completed `FetchResult`s stay in memory.
Nothing here uses credentials: the default source is Coinbase's public candle endpoint
(override with PAPER_TRAIL_CANDLE_BASE_URL; the fetcher is built from the environment when a job is created).
"""
from __future__ import annotations

import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import replace
from typing import Any, Callable

from .candles import CandleError, CandleFetcher, Cancelled, FetchResult
from .configuration import normalize_settings, utc_minute
from .errors import ApiProblem

MAX_RUNNING = 8
MAX_JOBS = 16
MAX_RESULTS = 4
MISSING_TIMES_CAP = 500  # per asset in a job view; the full list stays in the FetchResult


def fetch_parameters(lookback: int, model: str) -> dict[str, int]:
    """The warmup/history parameters `app.js start()` uses for a range replay."""
    history_limit = lookback + 1
    return {"warmup_minutes": max(60, 2 * lookback + 10), "history_limit": history_limit,
            "required_history": history_limit if model == "trend" else 0}


class _Job:
    def __init__(self, job_id: str, start: str, end: str, start_ms: int, end_ms: int, lookback: int, model: str,
                 cancel: threading.Event) -> None:
        self.id, self.start, self.end = job_id, start, end
        self.start_ms, self.end_ms, self.lookback, self.model = start_ms, end_ms, lookback, model
        self.cancel = cancel
        self.status = "running"
        self.progress: dict[str, Any] = {"phase": "starting", "completed": 0, "total": 0, "asset": None,
                                         "message": "Starting retrieval"}
        self.error: str | None = None
        self.receipts: list[dict[str, Any]] = []
        self.coverage: dict[str, Any] | None = None
        self.result: FetchResult | None = None
        self.result_released = False
        self.thread: threading.Thread | None = None


def _view_coverage(coverage: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for asset, values in coverage.items():
        item = dict(values)
        times = item.get("missingTimes", [])
        if len(times) > MISSING_TIMES_CAP:
            item["missingTimes"] = times[:MISSING_TIMES_CAP]
            item["missingTimesTruncated"] = True
        out[asset] = item
    return out


class CandleJobService:
    def __init__(self, fetcher_factory: Callable[[], CandleFetcher] | None = None, max_running: int = MAX_RUNNING,
                 max_jobs: int = MAX_JOBS, max_results: int = MAX_RESULTS) -> None:
        self._factory = fetcher_factory or CandleFetcher  # reads PAPER_TRAIL_CANDLE_BASE_URL when called
        self._max_running, self._max_jobs, self._max_results = max_running, max_jobs, max_results
        self._jobs: OrderedDict[str, _Job] = OrderedDict()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ public API (all return plain dicts)
    def create(self, start: str, end: str, lookback_intervals: int = 7, model: str = "trend") -> dict[str, Any]:
        try:
            normalize_settings({"config": {}, "replay": {"source": "range", "start": start, "end": end}})
            start_ms, end_ms = utc_minute(start), utc_minute(end)
        except ValueError as error:
            raise ApiProblem(422, "invalid_request", str(error)) from None
        fetcher = self._factory()
        job = _Job(uuid.uuid4().hex, start, end, start_ms, end_ms, lookback_intervals, model, threading.Event())
        with self._lock:
            if sum(1 for j in self._jobs.values() if j.status == "running") >= self._max_running:
                raise ApiProblem(429, "too_many_jobs",
                                 f"At most {self._max_running} candle jobs can run at once; wait or cancel one.")
            if len(self._jobs) >= self._max_jobs:
                oldest = next((j.id for j in self._jobs.values() if j.status != "running"), None)
                if oldest is None:
                    raise ApiProblem(429, "too_many_jobs", "Too many candle jobs; wait or cancel one.")
                del self._jobs[oldest]
            self._jobs[job.id] = job
            job.thread = threading.Thread(target=self._run, args=(job, fetcher), name=f"candle-job-{job.id[:8]}",
                                          daemon=True)
            job.thread.start()
            return self._view(job)

    def get(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            return self._view(self._find(job_id))

    def cancel(self, job_id: str) -> dict[str, Any]:
        """Cancel a running job (it reads `cancelled` immediately); a finished job is returned unchanged."""
        with self._lock:
            job = self._find(job_id)
            if job.status == "running":
                job.status = "cancelled"
                job.error = None
                job.progress = {**job.progress, "phase": "cancelled", "message": "Cancelled; no result is kept"}
                job.cancel.set()
            return self._view(job)

    def resolve(self, job_id: str, settings: dict[str, Any]) -> FetchResult:
        """The completed job's candles for a replay with `settings` (normalized): a copy whose quotes use
        `settings.replay.halfSpreadBps`. Raises ApiProblem for unknown, unfinished, failed or mismatching jobs."""
        with self._lock:
            job = self._find(job_id)
            if job.status == "running":
                raise ApiProblem(409, "job_not_ready", "The candle job is still running; wait for it to complete.")
            if job.status == "failed":
                raise ApiProblem(409, "job_failed", f"The candle job failed: {job.error}")
            if job.status == "cancelled":
                raise ApiProblem(409, "job_cancelled", "The candle job was cancelled; start a new one.")
            if job.result is None:
                raise ApiProblem(409, "job_expired", "The candles of this job were released from memory; "
                                                     "start a new candle job.")
            replay, config = settings.get("replay") or {}, settings.get("config") or {}
            wanted: tuple[Any, ...] = (None, None, config.get("lookbackIntervals"), config.get("model"))
            if replay.get("source") == "range":
                try:
                    wanted = (utc_minute(replay.get("start")), utc_minute(replay.get("end")),
                              config.get("lookbackIntervals"), config.get("model"))
                except ValueError:
                    pass
            if wanted != (job.start_ms, job.end_ms, job.lookback, job.model):
                asked = ("a date-range replay of " + f"{replay.get('start')} to {replay.get('end')}"
                         if replay.get("source") == "range" else "the bundled sample")
                raise ApiProblem(422, "job_mismatch",
                                 f"This candle job was created for {job.start} to {job.end} with lookback "
                                 f"{job.lookback} and model {job.model}; the settings ask for {asked} with lookback "
                                 f"{config.get('lookbackIntervals')} and model {config.get('model')}.")
            result = job.result
        return replace(result, half_spread_bps=replay["halfSpreadBps"], _frames=None)

    def close(self) -> None:
        """Cancel everything still running (tests and shutdown)."""
        with self._lock:
            jobs = list(self._jobs.values())
            for job in jobs:
                if job.status == "running":
                    job.status = "cancelled"
                    job.cancel.set()
        for job in jobs:
            if job.thread is not None:
                job.thread.join(timeout=2)

    # ------------------------------------------------------------------ internals
    def _find(self, job_id: str) -> _Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise ApiProblem(404, "job_not_found", "No candle job with this id")
        return job

    def _view(self, job: _Job) -> dict[str, Any]:
        return {"id": job.id, "status": job.status, "start": job.start, "end": job.end,
                "progress": dict(job.progress), "error": job.error, "receipts": [dict(r) for r in job.receipts],
                "coverage": job.coverage}

    def _progress(self, job: _Job, phase: str, completed: int, total: int, asset: str | None, message: str) -> None:
        with self._lock:
            if job.status == "running":
                job.progress = {"phase": phase, "completed": completed, "total": total, "asset": asset,
                                "message": message}

    def _run(self, job: _Job, fetcher: CandleFetcher) -> None:
        try:
            result = fetcher.fetch_range(job.start_ms, job.end_ms, cancel=job.cancel,
                                         progress=lambda *event: self._progress(job, *event),
                                         **fetch_parameters(job.lookback, job.model))
        except Cancelled:
            return  # `cancel()` already recorded the state
        except CandleError as error:
            self._finish(job, "failed", error=str(error))
        except Exception as error:  # noqa: BLE001 - a job thread must never die silently
            self._finish(job, "failed", error=f"Unexpected error while retrieving candles: {error}")
        else:
            self._finish(job, "completed", result=result)

    def _finish(self, job: _Job, status: str, error: str | None = None, result: FetchResult | None = None) -> None:
        with self._lock:
            if job.status != "running":  # cancelled meanwhile: discard whatever arrived
                return
            job.status = status
            if status == "failed":
                job.error = error
                job.progress = {**job.progress, "phase": "failed", "message": error}
                return
            assert result is not None
            job.result = result
            job.receipts = [dict(r) for r in result.receipts]
            job.coverage = _view_coverage(result.coverage)
            job.progress = {**job.progress, "phase": "complete", "completed": job.progress["total"],
                            "message": f"{result.shared_count} shared scored minutes"}
            held = [j for j in self._jobs.values() if j.result is not None]
            for old in held[:max(0, len(held) - self._max_results)]:
                old.result, old.result_released = None, True


def candle_source(jobs: "CandleJobService", candles: Any, job_id: str | None, settings: dict[str, Any]):
    """Resolve where a range replay gets its candles: supplied inline, or a completed candle job.

    Returns `(candles dict | None, FetchResult | None)`. A job brings retrieval receipts, so the run's
    evidence is the browser's fetched-run format; inline candles keep the compact evidence block.
    """
    if candles is not None and job_id is not None:
        raise ApiProblem(422, "invalid_request", "Supply candles or candleJobId, not both")
    if job_id is None:
        return (None if candles is None else {a: [c.model_dump() for c in getattr(candles, a)] for a in ("BTC", "LINK")}), None
    if settings["replay"]["source"] != "range":
        raise ApiProblem(422, "invalid_request", "candleJobId is only used with the range source")
    fetched = jobs.resolve(job_id, settings)
    return fetched.candles(), fetched
