# Python backend and TypeScript frontend (migration status)

The app is moving from a browser-only JavaScript program to a **Python backend that owns replay, forecasting and
accounting behind a versioned HTTP API**, with a **TypeScript frontend that only calls that API**. **The existing GitHub
Pages app (`index.html`, `app.js`, `engine.js`, …) is unchanged and keeps working**; nothing here is deployed or linked
from it, and the JavaScript modules remain the reference the Python port is tested against.

Simulated cash only. No real orders, exchange credentials, wallets, telemetry or paid services. Minute candles cannot
validate millisecond predictions, and a profitable replay does not establish a reliable edge.

## Status

| Area | State |
| --- | --- |
| Python engine, settings, replay (sample + UTC range), run records, run history, exports | Done, JS-parity tested |
| Stepwise sessions (advance by frames / next decision / finish), manual paper orders, stale-action and run-ownership protection | Done, JS-parity + real API/browser tests |
| Server-side candle retrieval (retries, receipts, cancellation, progress) and candle jobs | Done, tested against the existing JS and a loopback server |
| Browser-format run evidence (packed history catalog, last observed frame, matching `marketSha256`) | Done for sample and fetched runs; verified with the real `history.js` |
| Live paper sessions (server-side public quotes, ticks, live orders) | Done, 24 fetch + 6 session parity scenarios against the existing JS |
| Frontend: config/run/history views, chart, forecasts and positions, ledger, read-only snapshots, exports, reattach, range source, live sessions | Done, real-Chromium tests |
| CI (`.github/workflows/ci.yml` runs `scripts/verify.sh`, read-only token, no deploy) | Done |
| Switching the root app to the TypeScript build and retiring the JS engine | Not done (see below) |
| Hardening for remote hosting, hosting decision | Not done; no host, account or paid service provisioned |

## Layout

| Path | Role |
| --- | --- |
| `backend/paper_trail/` | `engine.py` (ledger/forecasts/accounting, from `engine.js`), `configuration.py` (settings rules), `replay.py` (dataset construction and warmup), `sessions.py` + `sessions_api.py` (stepwise and live sessions), `candles.py` + `candle_jobs.py` + `candles_api.py` (retrieval and jobs), `live.py` (live quotes, from `market.js`), `evidence.py` (browser-format market packing, from `history.js`), `records.py` (run records, hash verification, run store and ownership), `canonical.py` (canonical JSON identical to `history.js`), `api.py` + `schemas.py` (FastAPI app and typed models), `contract.py` |
| `contract/openapi.json` | Committed API contract generated from the Python models; a test fails on drift. Response descriptions are fixed text so it is identical on every supported Python |
| `web/` | TypeScript: generated `src/api-types.ts`, typed `src/client.ts`, UI modules under `src/`, static page in `public/`, tests in `test/` (API-level, real Chromium, oracle built on the root `engine.js`/`replay.js`, fake exchange) |
| `parity/` | Deterministic inputs, goldens produced by the **existing JavaScript**, and harnesses, one self-contained area per feature (`sessions/`, `candles/`, `evidence/`, `live/`, plus the base cases) |
| `scripts/verify.sh`, `.github/workflows/ci.yml` | Every check, locally and in CI |

One Python process (FastAPI + uvicorn, no database; runs are JSON files only if `PAPER_TRAIL_DATA_DIR` is set) and plain
`tsc` for the frontend. The API process also serves the built UI from `web/public`, so one origin runs everything and CORS
is off by default (`PAPER_TRAIL_CORS_ORIGINS` enables it).

## Run it

```sh
pip install -e "backend[dev]"
npm ci --prefix web && npm run build --prefix web
cd backend && python -m uvicorn --factory paper_trail.api:create_app --host 127.0.0.1 --port 8000
# open http://127.0.0.1:8000/   (interactive API docs: /docs)
```

All checks: `scripts/verify.sh` (Node 22+, Python 3.11+, a Chromium for the browser tests: `$CHROMIUM_PATH`,
`/opt/pw-browsers/chromium`, or `npx playwright-core install chromium`; without one those tests skip, and `verify.sh` makes
that a failure). Environment variables: `PAPER_TRAIL_DATA_DIR`, `PAPER_TRAIL_CORS_ORIGINS`, `PAPER_TRAIL_CANDLE_BASE_URL`
and `PAPER_TRAIL_LIVE_BASE_URL` (the last two default to Coinbase's public, keyless endpoints and exist so tests use a
loopback fake; tests never reach the real exchange).

## API v1

Errors are always `{"error": {"code", "message"}}` (plus `currentVersion` on `stale_session`). Codes include
`invalid_request`, `invalid_settings`, `replay_rejected`, `invalid_run_record`, `run_not_found`, `run_exists`, `run_owned`,
`settings_not_exportable`, `session_not_found`, `stale_session`, `session_completed`, `session_closed`, `order_rejected`,
`wrong_session_kind`, `too_many_sessions`, `job_not_found`, `job_not_ready`, `job_failed`, `job_cancelled`, `job_expired`,
`job_mismatch`, `too_many_jobs`, `live_unavailable`.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/health`, `GET /v1/defaults` | Version check (`realTrading` is always `false`); documented defaults ($1,000, 7-minute horizon, 7 lookback, 10 bps buffer, 50% per asset, no stop, 10 bps fee, 2 bps slippage, 2 bps assumed half-spread) and horizons |
| `POST /v1/settings/normalize` | Validate settings (same rules and messages as `configuration.js`) |
| `POST /v1/replays` | Run a whole replay (sample, or a UTC range from inline `candles` or a completed `candleJobId`) and save it |
| `POST /v1/candle-jobs`, `GET /v1/candle-jobs/{id}`, `POST /v1/candle-jobs/{id}/cancel` | Server-side retrieval of completed one-minute closes: progress, receipts (URL, arrival time, SHA-256 of the raw body, attempts), coverage, cancellation |
| `POST /v1/sessions`, `GET /v1/sessions/{id}`, `GET /v1/sessions/{id}/account` | Start a session (replay or live), read its state or full account |
| `POST /v1/sessions/{id}/advance` | Replay sessions: ingest `count` frames, run to the next decision, or finish |
| `POST /v1/sessions/{id}/tick` | Live sessions: fetch fresh public quotes server-side and ingest them |
| `POST /v1/sessions/{id}/orders` | Manual **paper** order at the current frame (live sessions fetch a fresh frame first) |
| `POST /v1/sessions/{id}/save`, `DELETE /v1/sessions/{id}` | Snapshot into run history under the session's run id; close and release the id |
| `GET /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/export` | Run history, a saved run, and every run as `paper-trail-history-v2` |
| `GET /v1/runs/{id}/export`, `GET /v1/runs/{id}/settings` | **Results export** (full `paper-trail-run-v2` record) and **settings export** |
| `POST /v1/runs/import` | Import a run exported by the browser app. Never overwrites a different run with the same id unless `?replace=true`, and never an id owned by an open session |

Regenerate after changing the API: `python -m paper_trail.contract` (in `backend/`) then `npm run types` (in `web/`).

### Sessions

* **Causal reveal.** Only the latest ingested frame is ever visible: states, step events and snapshots never contain a later
  frame, and a mid-session snapshot omits later frames and raw candle rows (the browser keeps them; an export of a causal
  session must not carry the future).
* **Optimistic concurrency.** Every mutating call sends `expectedVersion`; a mismatch is `409 stale_session` and changes
  nothing. Work is done on a copy that replaces the live account only on success, so a rejected call (bad order, no position,
  failed live fetch) leaves state and version untouched. Concurrent callers are serialized per session.
* **Ownership.** A session owns one run id while open; only it writes snapshots there, the stored snapshot never changes
  until the next save, and imports cannot overwrite it. Closing releases the id; snapshots remain.
* **Manual orders** mirror `app.js`: a buy spends the given dollars, a sell without dollars sells the whole position; an order
  that produces no trade is rejected.
* **Live sessions** (`mode: "live"`) take no candles; `advance` is `409 wrong_session_kind` and ticks drive them. The client
  owns cadence (the UI ticks every 10 s only while the page is visible). Failed fetches are `502 live_unavailable`.
  Sessions live in memory only: reattach works while the server runs; saved snapshots persist.

## How parity with the JavaScript is established

Seeded, clock-free inputs are run through the **existing** JS modules to produce goldens, and Python must reproduce them
(exact for integers/strings/structure; floats within 1e-12 relative, though Python currently matches bit for bit).
Areas: base accounting and settings (chronology, missing/stale/crossed quotes, outcome expiry, warmup, fees/slippage,
positions, stop loss, canonical hashing, sample and range replays), `sessions/` (11 scenarios), `candles/` (retrieval with
stubbed `fetch`: retries, errors, gaps, boundaries), `evidence/` (packing and hashes), `live/` (24 fetch + 6 session
scenarios with stubbed `fetch` and `Date.now`). A JS freshness test per area fails if a golden stops matching the JS, and
exact-boundary cases make off-by-one regressions fail. Frontend tests compare the UI and API with an independent oracle
that replays the same actions through the root `engine.js`/`replay.js`.

## Saved runs and exports

`canonical.py` reproduces `history.js` number formatting and key ordering. For **sample** runs and runs from a **candle
job**, Python now stores the browser's saved-run market format (`evidence.py`): a complete run's `marketSha256` equals the
browser's for the same inputs, and the record validates and unpacks with the existing `history.js`. Runs from
**caller-supplied candles** have no retrieval receipts to reproduce and keep a compact evidence block. Partial session
snapshots are deliberately not byte-comparable to the browser's (they omit the future, see above).

`POST /v1/runs/import` accepts any `paper-trail-run-v2` record exported by the existing app (completed, partial, manual-order
or live) after checking structure, config and market hashes, engine rules and that the recomputed summary matches; anything
malformed is a 422 and nothing is stored. These are **corruption checks, not tamper-proofing** (as with the browser app's own
hashes): someone who edits the account and recomputes the summary passes (a test documents this). Fixtures in
`parity/fixtures/` were produced by the real `history.js`.

## Preserved behaviours

* **Imported timing settings** (`maxQuoteAgeMs`, `maxOutcomeLatenessMs`) pass through normalize, replay, sessions and settings
  export, and through the UI: it keeps the normalized imported settings as its base and overlays only edited fields.
* **Per-asset causal warmup**: a range replay requires lookback+1 causal observations for *each* asset inside the bounded
  warmup window and refuses the run (no run created) otherwise; warmup never earns returns.
* **Snapshot operation ownership**: the browser app's guards are untouched. In Python, replays and sessions never share a
  mutable account, and run ids are owned as described above. In the UI every async operation carries a generation, so a late
  response can never update a newer session or snapshot, and read-only snapshots can never call advance/orders/save.

## Known deviations from the browser app

* A rejected live order discards the fresh frame it fetched (the browser would keep it ingested), so rejections never change state.
* Partial session snapshots omit later frames and raw candle rows (causality); the browser keeps them.
* `live.py` reimplements `Date.parse` for ISO timestamps only, and reports invalid JSON as "Invalid JSON response" rather than V8's text.
* Coverage `missingTimes` in candle jobs is capped at 500 per asset (`missingTimesTruncated` marks it).
* Layout and wording of the new UI are not pixel-matched to the original.

## GitHub Pages constraint

GitHub Pages serves static files only and cannot run Python. The Pages app therefore stays on its JavaScript engine until a
host for the API is chosen; that is a hosting/cost decision this work does not make. Until then the Python API runs locally.
The TypeScript client takes a `baseUrl` (or `?api=http://host:port` in the UI), so once an API host exists the static
frontend can be published from Pages and pointed at it, after the hardening below.

## Remaining work

1. **Switch the root app to the TypeScript build** (behind a flag) and retire the JavaScript engine once the Python service is
   hosted; today both coexist and the JS modules are the parity reference.
2. **Hardening before any remote hosting**: authentication, a CORS allow-list, request-size and rate limits, quotas on runs,
   sessions, jobs and ticks (any API caller can currently trigger outbound public-data fetches), pagination, and a review of
   the environment-controlled upstream base URLs.
3. **Hosting decision** for the API (no host, account or paid service was provisioned).
4. **Session durability**: sessions are in memory; resuming a saved snapshot as a live session after a restart is not supported.
5. **UI polish**: pixel/wording parity with the original, accessibility audit, small-screen review.
6. **Large-range performance**: a 31-day range record serializes in seconds (about 5 s measured); acceptable locally, worth
   streaming or caching before hosting.
