"""Candle jobs through the HTTP API against a loopback fake Coinbase server (no real network)."""
from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from paper_trail.candle_jobs import CandleJobService
from paper_trail.candles import BASE_URL_ENV, CandleFetcher
from paper_trail.candles_api import build_router
from paper_trail.configuration import normalize_settings
from paper_trail.errors import ApiProblem

from test_candles import Server, rows_for

START, END = "2024-03-09T12:00", "2024-03-09T12:10"
BODY = {"start": START, "end": END, "lookbackIntervals": 7, "model": "trend"}


def app_for(service: CandleJobService) -> TestClient:
    app = FastAPI()

    @app.exception_handler(ApiProblem)
    async def problem(_, error: ApiProblem):
        return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)

    app.include_router(build_router(service))
    return TestClient(app)


def quick() -> CandleFetcher:
    return CandleFetcher(sleep=lambda seconds: None)  # real HTTP, no waiting between requests or retries


@pytest.fixture
def servers():
    made = []

    def make(script=None):
        made.append(Server(script))
        return made[-1]

    yield make
    for server in made:
        server.close()


@pytest.fixture
def service():
    made = []

    def make(**kwargs):
        kwargs.setdefault("fetcher_factory", quick)
        made.append(CandleJobService(**kwargs))
        return made[-1]

    yield make
    for item in made:
        item.close()


def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition not reached")


def finished(client, job_id):
    return wait_for(lambda: (j := client.get(f"/v1/candle-jobs/{job_id}").json())["status"] != "running" and j)


def settings(end=END, lookback=7, model="trend", half=2, source="range"):
    return normalize_settings({"config": {"lookbackIntervals": lookback, "horizonMs": 300000, "model": model},
                               "replay": {"source": source, "start": START, "end": end, "halfSpreadBps": half}})


# ---------------------------------------------------------------------------------- lifecycle

def test_job_completes_with_receipts_matching_requests_and_coverage(servers, service, monkeypatch):
    server = servers()
    monkeypatch.setenv(BASE_URL_ENV, server.base)
    jobs = service(fetcher_factory=None, )  # default factory: fetcher built from the environment, real spacing
    client = app_for(jobs)
    created = client.post("/v1/candle-jobs", json=BODY)
    assert created.status_code == 202
    job = created.json()
    assert job["status"] == "running" and job["start"] == START and job["end"] == END and job["receipts"] == []
    done = finished(client, job["id"])
    assert done["status"] == "completed" and done["error"] is None
    assert len(done["receipts"]) == len(server.requests) == 2
    assert [r["asset"] for r in done["receipts"]] == ["BTC", "LINK"]
    for receipt in done["receipts"]:
        assert len(receipt["sha256"]) == 64 and receipt["attempts"] == 1 and receipt["rowCount"] > 0
        assert receipt["url"].startswith(server.base + "/products/") and receipt["httpDate"]
    assert done["progress"]["phase"] == "complete" and done["progress"]["completed"] == done["progress"]["total"] == 2
    coverage = done["coverage"]["BTC"]
    assert coverage["expectedCount"] == 11 and coverage["missingCount"] == 0 and coverage["startPresent"]
    assert "rows" not in json.dumps(done)  # raw responses are not returned


def test_missing_times_in_coverage_are_capped_with_a_marker(service):
    from paper_trail import candle_jobs
    view = candle_jobs._view_coverage({"BTC": {"missingTimes": list(range(candle_jobs.MISSING_TIMES_CAP + 5)),
                                               "missingCount": candle_jobs.MISSING_TIMES_CAP + 5}})
    assert len(view["BTC"]["missingTimes"]) == candle_jobs.MISSING_TIMES_CAP and view["BTC"]["missingTimesTruncated"]
    assert view["BTC"]["missingCount"] == candle_jobs.MISSING_TIMES_CAP + 5


def test_http_failure_marks_the_job_failed_with_the_message(servers, service):
    server = servers(lambda i, a, s, e: (500, "{}", 0))
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base, sleep=lambda s: None))
    client = app_for(jobs)
    job = finished(client, client.post("/v1/candle-jobs", json=BODY).json()["id"])
    assert job["status"] == "failed" and job["error"] == "Coinbase HTTP 500" and job["receipts"] == []
    assert len(server.requests) == 3  # three attempts, then give up
    with pytest.raises(ApiProblem) as error:
        jobs.resolve(job["id"], settings())
    assert (error.value.status, error.value.code) == (409, "job_failed") and "Coinbase HTTP 500" in error.value.message


def test_missing_boundary_is_reported_as_a_failed_job(servers, service):
    def script(index, asset, start, end):
        rows = [r for r in rows_for(start, end) if r[0] * 1000 + 60000 != 1_709_985_600_000]  # drop the start minute
        return 200, json.dumps(rows), 0

    server = servers(script)
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base, sleep=lambda s: None))
    client = app_for(jobs)
    job = finished(client, client.post("/v1/candle-jobs", json=BODY).json()["id"])
    assert job["status"] == "failed" and job["error"].startswith("Exact start/end close missing")


def test_cancel_mid_flight_abandons_the_slow_request_quickly(servers, service):
    server = servers(lambda i, a, s, e: (200, "[]", 10))
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base))
    client = app_for(jobs)
    job_id = client.post("/v1/candle-jobs", json=BODY).json()["id"]
    wait_for(lambda: server.requests)  # the request is in flight and the server is stalling
    started = time.monotonic()
    cancelled = client.post(f"/v1/candle-jobs/{job_id}/cancel")
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    thread = jobs._jobs[job_id].thread
    thread.join(1.5)
    assert not thread.is_alive() and time.monotonic() - started < 1.5
    state = client.get(f"/v1/candle-jobs/{job_id}").json()
    assert state["status"] == "cancelled" and state["receipts"] == [] and state["coverage"] is None
    assert jobs._jobs[job_id].result is None and len(server.requests) == 1  # no retry after cancel
    with pytest.raises(ApiProblem) as error:
        jobs.resolve(job_id, settings())
    assert (error.value.status, error.value.code) == (409, "job_cancelled")
    again = client.post(f"/v1/candle-jobs/{job_id}/cancel")
    assert again.status_code == 200 and again.json()["status"] == "cancelled"  # idempotent


def test_cancelling_a_finished_job_is_a_no_op(servers, service):
    server = servers()
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base, sleep=lambda s: None))
    client = app_for(jobs)
    done = finished(client, client.post("/v1/candle-jobs", json=BODY).json()["id"])
    after = client.post(f"/v1/candle-jobs/{done['id']}/cancel").json()
    assert after == done and after["status"] == "completed"
    assert jobs._jobs[done["id"]].result is not None


def test_unknown_job_ids_are_404(service):
    client = app_for(service())
    for response in (client.get("/v1/candle-jobs/nope"), client.post("/v1/candle-jobs/nope/cancel")):
        assert response.status_code == 404 and response.json()["error"]["code"] == "job_not_found"
    with pytest.raises(ApiProblem) as error:
        service().resolve("nope", settings())
    assert (error.value.status, error.value.code) == (404, "job_not_found")


# ---------------------------------------------------------------------------------- validation

@pytest.mark.parametrize("override, message", [
    ({"start": "2024-03-09 12:00"}, "Choose a valid UTC date and minute."),
    ({"end": "2024-03-09T12:00:00Z"}, "Choose a valid UTC date and minute."),
    ({"end": "2024-02-30T12:00"}, "Choose a valid UTC date and minute."),
    ({"end": START}, "Choose an increasing UTC range of at most 31 days."),
    ({"end": "2024-03-09T11:00"}, "Choose an increasing UTC range of at most 31 days."),
    ({"end": "2024-04-09T12:01"}, "Choose an increasing UTC range of at most 31 days."),
    ({"start": "2999-01-01T00:00", "end": "2999-01-02T00:00"}, "Historical end must be a completed minute."),
])
def test_invalid_ranges_are_422_invalid_request(service, servers, override, message):
    jobs = service()
    client = app_for(jobs)
    response = client.post("/v1/candle-jobs", json={**BODY, **override})
    assert response.status_code == 422 and response.json()["error"] == {"code": "invalid_request", "message": message}
    assert jobs._jobs == {}  # nothing started


def test_schema_violations_are_rejected_before_a_job_starts(service):
    jobs = service()
    client = app_for(jobs)
    for body in ({**BODY, "lookbackIntervals": 0}, {**BODY, "lookbackIntervals": 241}, {**BODY, "model": "x"},
                 {**BODY, "extra": 1}, {"start": START}):
        assert client.post("/v1/candle-jobs", json=body).status_code == 422
    assert jobs._jobs == {}


# ---------------------------------------------------------------------------------- bounds

def test_running_job_cap_is_429_and_frees_on_cancel(servers, service):
    server = servers(lambda i, a, s, e: (200, "[]", 30))
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base), max_running=2)
    client = app_for(jobs)
    first, second = (client.post("/v1/candle-jobs", json=BODY).json()["id"] for _ in range(2))
    blocked = client.post("/v1/candle-jobs", json=BODY)
    assert blocked.status_code == 429 and blocked.json()["error"]["code"] == "too_many_jobs"
    client.post(f"/v1/candle-jobs/{first}/cancel")
    assert client.post("/v1/candle-jobs", json=BODY).status_code == 202
    assert client.get(f"/v1/candle-jobs/{second}").json()["status"] == "running"


def test_default_caps_are_eight_running_and_sixteen_retained():
    from paper_trail import candle_jobs
    assert (candle_jobs.MAX_RUNNING, candle_jobs.MAX_JOBS, candle_jobs.MAX_RESULTS) == (8, 16, 4)


def test_retained_jobs_evict_the_oldest_finished_and_few_results_stay_in_memory(servers, service):
    server = servers()
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base, sleep=lambda s: None),
                   max_jobs=3, max_results=2)
    client = app_for(jobs)
    ids = []
    for _ in range(5):
        ids.append(finished(client, client.post("/v1/candle-jobs", json=BODY).json()["id"])["id"])
    assert client.get(f"/v1/candle-jobs/{ids[0]}").status_code == 404 and client.get(f"/v1/candle-jobs/{ids[1]}").status_code == 404
    assert [client.get(f"/v1/candle-jobs/{i}").status_code for i in ids[2:]] == [200, 200, 200]
    held = [i for i in ids[2:] if jobs._jobs[i].result is not None]
    assert held == ids[3:]  # only the newest two completed results are retained
    with pytest.raises(ApiProblem) as error:
        jobs.resolve(ids[2], settings())
    assert (error.value.status, error.value.code) == (409, "job_expired")
    assert client.get(f"/v1/candle-jobs/{ids[2]}").json()["receipts"]  # metadata survives the release
    assert jobs.resolve(ids[4], settings()).series["BTC"]


def test_concurrent_creates_and_cancels_are_safe(servers, service):
    server = servers(lambda i, a, s, e: (200, "[]", 30))
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base))
    client = app_for(jobs)
    outcomes, ids, lock = [], [], threading.Lock()

    def worker(n):
        for _ in range(4):
            response = client.post("/v1/candle-jobs", json=BODY)
            outcomes.append(response.status_code)
            if response.status_code == 202:
                with lock:
                    ids.append(response.json()["id"])
                if n % 2:
                    client.post(f"/v1/candle-jobs/{response.json()['id']}/cancel")
            client.get(f"/v1/candle-jobs/{ids[0]}") if ids else None

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(6)]
    [t.start() for t in threads]
    [t.join(10) for t in threads]
    assert set(outcomes) <= {202, 429} and outcomes.count(202) >= 8
    states = [jobs.get(i)["status"] for i in ids if i in jobs._jobs]
    assert set(states) <= {"running", "cancelled"} and states.count("running") <= 8
    jobs.close()
    assert all(jobs.get(i)["status"] == "cancelled" for i in ids if i in jobs._jobs)
    assert all(not j.thread.is_alive() for j in jobs._jobs.values())


# ---------------------------------------------------------------------------------- resolve

def completed(servers, service, **kwargs):
    server = servers()
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base, sleep=lambda s: None))
    client = app_for(jobs)
    job = finished(client, client.post("/v1/candle-jobs", json={**BODY, **kwargs}).json()["id"])
    assert job["status"] == "completed"
    return jobs, job["id"]


def test_resolve_rebuilds_frames_with_the_settings_half_spread(servers, service):
    jobs, job_id = completed(servers, service)
    narrow, wide = jobs.resolve(job_id, settings(half=2)), jobs.resolve(job_id, settings(half=25))
    assert narrow.half_spread_bps == 2 and wide.half_spread_bps == 25
    a, b = narrow.frames()[0]["quotes"]["BTC"], wide.frames()[0]["quotes"]["BTC"]
    assert a["mid"] == b["mid"] and a["bid"] > b["bid"] and a["ask"] < b["ask"]
    assert a["bid"] == a["mid"] * (1 - 2 / 10000) and b["ask"] == b["mid"] * (1 + 25 / 10000)
    assert "ASSUMED 25 bps" in b["source"]
    assert narrow.series is wide.series and narrow.candles()["BTC"][0]["time"] < narrow.start  # warmup retained
    assert wide.dataset()["assumptions"]["halfSpreadBps"] == 25
    assert jobs.resolve(job_id, settings(half=2)).frames() == narrow.frames()  # the job's own result is untouched


@pytest.mark.parametrize("changes, mentions", [
    ({"end": "2024-03-09T12:09"}, "2024-03-09T12:09"), ({"lookback": 8}, "lookback 8"), ({"model": "same-price"}, None),
    ({"source": "sample"}, "bundled sample")])
def test_resolve_rejects_settings_the_job_was_not_created_for(servers, service, changes, mentions):
    jobs, job_id = completed(servers, service)
    try:
        wanted = settings(**changes)
    except ValueError:
        pytest.skip("model not available")
    with pytest.raises(ApiProblem) as error:
        jobs.resolve(job_id, wanted)
    assert (error.value.status, error.value.code) == (422, "job_mismatch")
    assert f"created for {START} to {END} with lookback 7 and model trend" in error.value.message
    if mentions:
        assert mentions in error.value.message


def test_resolve_of_a_running_job_is_409_not_ready(servers, service):
    server = servers(lambda i, a, s, e: (200, "[]", 30))
    jobs = service(fetcher_factory=lambda: CandleFetcher(base_url=server.base))
    job_id = jobs.create(START, END, 7, "trend")["id"]
    with pytest.raises(ApiProblem) as error:
        jobs.resolve(job_id, settings())
    assert (error.value.status, error.value.code) == (409, "job_not_ready")


def test_the_fetch_parameters_match_the_browser(servers, service):
    from paper_trail.candle_jobs import fetch_parameters
    assert fetch_parameters(7, "trend") == {"warmup_minutes": 60, "history_limit": 8, "required_history": 8}
    assert fetch_parameters(240, "trend") == {"warmup_minutes": 490, "history_limit": 241, "required_history": 241}
    assert fetch_parameters(20, "same-price") == {"warmup_minutes": 60, "history_limit": 21, "required_history": 0}


# ---------------------------------------------------------------------------------- app wiring

def test_the_real_app_exposes_the_routes_and_reads_the_base_url_from_the_environment(servers, monkeypatch, tmp_path):
    from paper_trail.api import create_app
    from paper_trail.records import RunStore
    server = servers()
    monkeypatch.setenv(BASE_URL_ENV, server.base)
    client = TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "none"))
    assert client.post("/v1/candle-jobs", json={**BODY, "end": "2024-03-09T12:00"}).status_code == 422
    created = client.post("/v1/candle-jobs", json=BODY)
    assert created.status_code == 202, created.text
    done = wait_for(lambda: (j := client.get(f"/v1/candle-jobs/{created.json()['id']}").json())["status"] != "running" and j)
    assert done["status"] == "completed" and len(server.requests) == 2
    assert client.get("/v1/candle-jobs/nope").json()["error"]["code"] == "job_not_found"
