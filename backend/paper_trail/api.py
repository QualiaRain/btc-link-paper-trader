"""FastAPI application for the versioned `/v1` paper-trader API."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import API_VERSION
from .canonical import js_copy
from .errors import ApiProblem
from .configuration import HORIZONS, normalize_settings
from .candles_api import build_router as build_candles_router
from .sessions_api import build_router as build_sessions_router
from .records import (RunExists, RunOwned, RunStore, make_run_record, market_for, now_iso, run_metadata,
                      verify_imported_record)
from .replay import run_replay
from .schemas import (ApiError, HistoryExport, Defaults, Health, JsonObject, ReplayRequest, ReplayResult, RunList,
                      RunMetadata, RunRecord, Settings, SettingsInput)

REPO_ROOT = Path(__file__).resolve().parents[2]
ERRORS = {400: {"model": ApiError}, 404: {"model": ApiError}, 422: {"model": ApiError}}


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(exclude_none=True) if model is not None else {}


def create_app(store: RunStore | None = None, web_dir: str | os.PathLike | None = None) -> FastAPI:
    app = FastAPI(
        title="BTC/LINK Paper Trail API", version=API_VERSION,
        summary="Replay, forecast and paper-accounting service. Simulated cash only; no orders, keys or wallets.",
        description="Python owns replay, forecasting and accounting. Minute candles cannot validate "
                    "millisecond predictions, and a profitable replay does not establish a reliable edge.")
    runs = store or RunStore(os.environ.get("PAPER_TRAIL_DATA_DIR"))
    origins = [o for o in os.environ.get("PAPER_TRAIL_CORS_ORIGINS", "").split(",") if o]
    if origins:  # off by default: the bundled UI is served same-origin
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                           allow_headers=["content-type"])

    @app.exception_handler(ApiProblem)
    async def problem(_: Request, error: ApiProblem) -> JSONResponse:
        return JSONResponse({"error": {"code": error.code, "message": error.message, **error.extra}},
                            status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, error: RequestValidationError) -> JSONResponse:
        first = error.errors()[0]
        # Union members (`int`, `float`) are validation internals, not part of the field path.
        loc = [str(p) for p in first["loc"] if p != "body" and p not in ("int", "float")]
        if first["type"] == "extra_forbidden" and "config" in loc:
            message = f"Unknown configuration field: {loc[-1]}"
        elif first["type"] in ("int_type", "float_type", "int_parsing", "float_parsing"):
            message = f"{'.'.join(loc)}: must be a finite number"
        else:
            message = f"{'.'.join(loc) or 'request'}: {first['msg']}"
        return JSONResponse({"error": {"code": "invalid_request", "message": message}}, status_code=422)

    @app.get("/v1/health", response_model=Health, operation_id="getHealth", tags=["service"])
    def health() -> dict[str, Any]:
        return {"status": "ok", "apiVersion": API_VERSION, "engine": "paper-trail-python", "realTrading": False}

    @app.get("/v1/defaults", response_model=Defaults, operation_id="getDefaults", tags=["settings"])
    def defaults() -> dict[str, Any]:
        return {"settings": normalize_settings({"config": {}}), "horizonsMs": HORIZONS}

    @app.post("/v1/settings/normalize", response_model=Settings, responses=ERRORS,
              operation_id="normalizeSettings", tags=["settings"])
    def normalize(body: SettingsInput) -> dict[str, Any]:
        try:
            return normalize_settings(_dump(body))
        except ValueError as error:
            raise ApiProblem(422, "invalid_settings", str(error)) from None

    @app.post("/v1/replays", response_model=ReplayResult, response_model_exclude_unset=True, responses=ERRORS,
              operation_id="createReplay", tags=["replay"],
              summary="Run a complete replay and save it to run history")
    def create_replay(body: ReplayRequest) -> dict[str, Any]:
        if body.candleJobId is not None:  # replaced by the candle-job wiring (milestone 2)
            raise ApiProblem(501, "not_implemented", "candleJobId is not supported yet; supply candles")
        try:
            settings = normalize_settings(_dump(body.settings))
            candles = None
            if body.candles is not None:
                candles = {a: [c.model_dump() for c in getattr(body.candles, a)] for a in ("BTC", "LINK")}
            account, dataset = run_replay(settings, candles)
        except ValueError as error:
            raise ApiProblem(422, "replay_rejected", str(error)) from None
        market = market_for(settings, dataset)
        record = runs.save(make_run_record(account, market, name=body.name))
        return {"run": run_metadata(record), "summary": record["summary"], "account": record["account"]}

    @app.get("/v1/runs", response_model=RunList, operation_id="listRuns", tags=["history"])
    def list_runs() -> dict[str, Any]:
        return {"runs": runs.list()}

    @app.get("/v1/runs/export", response_model=HistoryExport, response_model_exclude_unset=True,
             operation_id="exportAllRuns", tags=["export"], summary="Export every saved run (paper-trail-history-v2)")
    def export_all() -> JSONResponse:
        return JSONResponse(js_copy({
            "format": "paper-trail-history-v2", "exportedAt": now_iso(),
            "notice": "Paper runs held by this service; partial and manually modified runs are labeled. "
                      "Not a tamper-proof record.",
            "runs": runs.all()}), headers={"content-disposition": 'attachment; filename="paper-trail-all-runs.json"'})

    def _record(run_id: str) -> dict[str, Any]:
        record = runs.get(run_id)
        if record is None:
            raise ApiProblem(404, "run_not_found", "Saved run not found")
        return record

    @app.get("/v1/runs/{run_id}", response_model=RunRecord, response_model_exclude_unset=True, responses=ERRORS,
             operation_id="getRun", tags=["history"])
    def get_run(run_id: str) -> dict[str, Any]:
        return _record(run_id)

    @app.get("/v1/runs/{run_id}/export", response_model=RunRecord, response_model_exclude_unset=True,
             responses=ERRORS, operation_id="exportRun", tags=["export"],
             summary="Results export: the full run record with evidence and hashes")
    def export_run(run_id: str) -> JSONResponse:
        return JSONResponse(js_copy(_record(run_id)), headers={
            "content-disposition": f'attachment; filename="paper-trail-{run_id}-run.json"'})

    @app.get("/v1/runs/{run_id}/settings", response_model=Settings, responses=ERRORS,
             operation_id="exportRunSettings", tags=["export"],
             summary="Settings export: frozen rules and replay boundaries, importable before a new run")
    def export_settings(run_id: str) -> dict[str, Any]:
        record = _record(run_id)
        replay = ((record.get("market") or {}).get("settings") or {}).get("replay")
        try:  # past runs are exported as they were run; the "completed minute" rule applies to new runs
            return normalize_settings({"config": record["config"], "replay": replay}, check_range_end=False)
        except ValueError as error:
            raise ApiProblem(422, "settings_not_exportable", str(error)) from None

    @app.post("/v1/runs/import", response_model=RunMetadata, responses={**ERRORS, 409: {"model": ApiError}},
              operation_id="importRun", tags=["history"],
              summary="Import a saved run exported by the browser app",
              description="Checks structure, evidence hashes and summary consistency (corruption checks, not "
                          "tamper-proofing). An existing run with the same id is never overwritten unless "
                          "`replace=true`; importing the identical record again is a no-op.")
    def import_run(body: JsonObject, replace: bool = Query(False)) -> dict[str, Any]:
        try:
            record = verify_imported_record(body)
        except ValueError as error:
            raise ApiProblem(422, "invalid_run_record", str(error)) from None
        try:  # conflict check and write happen atomically inside the store
            return run_metadata(runs.save_imported(record, replace=replace))
        except RunExists as error:
            raise ApiProblem(409, "run_exists", f"A different run with id {error.run_id} is already saved; "
                                                "pass replace=true to overwrite it") from None
        except RunOwned as error:
            raise ApiProblem(409, "run_owned", f"Run {error.run_id} belongs to an open replay session; "
                                               "close the session before importing over it") from None

    app.include_router(build_sessions_router(runs))
    app.include_router(build_candles_router())

    root = Path(web_dir) if web_dir else Path(os.environ.get("PAPER_TRAIL_WEB_DIR", REPO_ROOT / "web" / "public"))
    if root.is_dir():
        app.mount("/", StaticFiles(directory=root, html=True), name="web")
    return app
