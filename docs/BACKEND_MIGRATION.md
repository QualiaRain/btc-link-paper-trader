# Python backend and TypeScript client (migration slice 1)

The app is moving from a browser-only JavaScript program to a **Python backend that owns replay, forecasting and
accounting behind a versioned HTTP API**, with a **TypeScript frontend that only calls that API**. This is the first
vertical slice. **The existing GitHub Pages app (`index.html`, `app.js`, `engine.js`, …) is unchanged and keeps
working**; nothing in this slice is deployed or linked from it.

Simulated cash only. No real orders, exchange credentials, wallets, telemetry or paid services. Minute candles cannot
validate millisecond predictions, and a profitable replay does not establish a reliable edge.

## Layout

| Path | Role |
| --- | --- |
| `backend/paper_trail/` | Python package: `engine.py` (ledger/forecasts/accounting, ported from `engine.js`), `configuration.py` (settings rules, from `configuration.js`), `replay.py` (frame construction and warmup, from `market.js`/`replay.js`/`app.js start`), `records.py` (run records, hash verification, run store), `canonical.py` (canonical JSON identical to `history.js`), `api.py` + `schemas.py` (FastAPI app and typed models), `contract.py` (writes the OpenAPI file) |
| `contract/openapi.json` | The committed API contract, generated from the Python models. A test fails if it drifts |
| `web/` | TypeScript: `src/api-types.ts` (generated from the contract), `src/client.ts` (typed client), `src/main.ts` + `public/` (small UI), `test/e2e.test.ts` |
| `parity/` | Deterministic inputs, golden outputs from the **existing JavaScript**, and a harness. Python is tested against the same goldens |
| `scripts/verify.sh` | Runs every check |

Build/service choice: one Python process (FastAPI + uvicorn, no database; runs are JSON files only if
`PAPER_TRAIL_DATA_DIR` is set) and plain `tsc` for the frontend (no bundler). The API process also serves the built UI
from `web/public`, so a single origin runs everything and CORS is off by default (`PAPER_TRAIL_CORS_ORIGINS` enables it).

## Run it

```sh
pip install -e "backend[dev]"
npm ci --prefix web && npm run build --prefix web
cd backend && python -m uvicorn --factory paper_trail.api:create_app --host 127.0.0.1 --port 8000
# open http://127.0.0.1:8000/   (interactive API docs: /docs)
```

All checks: `scripts/verify.sh` (Node 22+, Python 3.11+, a Chromium for the browser tests: `$CHROMIUM_PATH`,
`/opt/pw-browsers/chromium`, or `npx playwright-core install chromium`; without one those tests skip, and `verify.sh` makes that a failure).

## API v1

Errors are always `{"error": {"code", "message"}}` (`invalid_request`, `invalid_settings`, `replay_rejected`,
`invalid_run_record`, `run_not_found`, `run_exists`, `settings_not_exportable`).

| Method and path | Purpose |
| --- | --- |
| `GET /v1/health` | Version check; `realTrading` is always `false` |
| `GET /v1/defaults` | The documented defaults ($1,000, 7-minute horizon, 7 lookback, 10 bps buffer, 50% per asset, no stop, 10 bps fee, 2 bps slippage, 2 bps assumed half-spread) and the supported horizons |
| `POST /v1/settings/normalize` | Validate settings (same rules and messages as `configuration.js`); also the settings-import path |
| `POST /v1/replays` | Run a whole replay (bundled sample, or a UTC range from supplied candles) and save it |
| `GET /v1/runs`, `GET /v1/runs/{id}` | Run history and a saved run |
| `GET /v1/runs/{id}/export` | **Results export**: the full `paper-trail-run-v2` record (frozen config, ledger, forecasts, equity, summary, evidence, SHA-256 hashes) |
| `GET /v1/runs/{id}/settings` | **Settings export** (`paper-trail-settings-v2`), importable before a new run |
| `POST /v1/runs/import` | Import a run exported by the browser app (see below). Never overwrites a different run with the same id unless `?replace=true`; the conflict check and the write are one atomic step in the store, so concurrent imports of the same new id yield exactly one winner (the other gets 409) |

Regenerate after changing the API: `python -m paper_trail.contract` (in `backend/`) then `npm run types` (in `web/`).

## How parity with the JavaScript is established

`node parity/generate-inputs.mjs` writes seeded, clock-free inputs (`parity/inputs/`). `node parity/generate-expected.mjs`
runs the **existing** JS modules over them (account chronology, missing/stale/crossed quotes, outcome expiry, per-asset
warmup, fees/slippage/buffer/allocation, manual trades and positions, stop loss, completion, settings normalization with exact
messages, canonical JSON hashing, bundled-sample replays and date-range replays through the real `fetchHistoricalRange`
with a stubbed candle endpoint) and stores `parity/expected/`.

* `node --test parity/golden.test.mjs` fails if the goldens stop matching what the JS produces.
* `backend/tests/test_parity.py` fails if Python stops matching the goldens. Integers, strings, booleans, `null` and
  structure must be exactly equal; floats may differ by 1e-12 relative (Python currently matches bit for bit, since
  both use IEEE doubles with the same operation order; the allowance covers libm `exp`/`log` last-bit differences).
* Boundary cases (quote age exactly at/1 ms past the limit, outcome lateness at/1 ms past tolerance, history exactly
  120000 ms old) exist so that off-by-one regressions fail.

Two deliberate differences: the API rejects `mode: "live"` (live polling stays in the browser), and large sample replays
are compared through a digest of trades, forecasts, decisions and a thinned equity curve rather than the whole ledger.

## Saved runs and exports

Python accounts are the same JSON shape as the browser's, and `canonical.py` reproduces `history.js` number formatting and
key ordering, so evidence hashes agree. `POST /v1/runs/import` accepts a `paper-trail-run-v2` record (completed, partial,
manual-order, or live-session) exported by the existing app. It checks the structure, the config and market SHA-256 hashes,
that the config satisfies the engine's rules, and that the summary recomputed from the account matches; anything malformed
is a 422 and nothing is stored. The record is then stored unchanged, and re-exporting it returns the original evidence.
Fixtures in `parity/fixtures/` were produced by the real `history.js`.

These are **corruption checks, not tamper-proofing** (as with the browser app's own hashes): the hashes cover only config
and market evidence, so someone who edits the account and recomputes the summary passes (a test documents this).

Differences to know about:

* Runs *created by Python* store compact market evidence (the supplied/sample price series, coverage and settings), not the
  browser's per-frame history catalog and last observed frame. Their `marketSha256` is not comparable to a browser run's,
  and **the existing browser app cannot open a Python-created export as a snapshot** (it needs `market.lastObservedFrame` and
  `market.dataset.frames`). Python exports are for archiving and analysis; frame-level evidence is listed below as follow-up work.
* Imported live-session runs can be listed, exported and have their settings exported, but this service only replays.

## Preserved behaviours

* **Imported timing settings** (`maxQuoteAgeMs`, `maxOutcomeLatenessMs`) pass through normalize, replay and settings export
  (`test_imported_timing_limits_survive_settings_round_trips`, settings parity case) *and through the TypeScript UI*: the UI
  keeps the normalized imported settings as its base and overlays only fields the user edited, so undisplayed settings and
  unedited values are never rebuilt from the form (`web/test/browser.test.ts`, real Chromium). Date-range and live-session
  settings files are rejected with a clear message before anything is applied, since this slice only replays the sample.
* **Per-asset causal warmup**: a range replay requires lookback+1 causal observations for *each* asset inside the bounded
  warmup window and refuses the run (no run created) otherwise; warmup never earns returns (parity: `range-replay`).
* **Snapshot operation ownership**: the browser app's guards are untouched (its tests still run). The Python side has no
  shared mutable account: replays create a new immutable run id, and the only overwrite is an explicit import of an id.
  The new TS UI captures the selected run id before any awaited export so a changed selection cannot misattribute a file.

## GitHub Pages constraint

GitHub Pages serves static files only and cannot run Python. The Pages app therefore stays on its JavaScript engine until a
host for the API is chosen; that is a hosting/cost decision this change does not make. Until then the Python API runs
locally. The TypeScript client takes a `baseUrl` (or `?api=http://host:port` in the UI), so once an API host exists the
static frontend can be published from Pages and pointed at it, after adding auth/CORS/rate limits (see below).

## Remaining work (suggested follow-up PRs)

1. **Stepwise replay sessions + manual orders**: endpoints for play/next-decision/finish and manual paper orders
   (`manual_trade` is already ported and parity-tested; only the session API and ownership rules are missing).
2. **Range retrieval in Python**: move the Coinbase candle fetching (retries, rate limiting, receipts, cancellation,
   progress) behind the API; today the caller supplies candles. Wire the browser's `replay.js` output to `POST /v1/replays` as an interim.
3. **Python live mode** (public ticker polling, gap handling) or an explicit decision to keep live in the browser.
4. **Frame-level evidence parity**: reproduce the browser's per-frame history catalog and last observed frame so Python-created runs open in the browser app and exports are byte-comparable.
5. **Frontend parity**: chart, ledger, forecast/position panels, read-only snapshot open, copy settings, archive, current-run
   checkpoint, settings-file import UI; then switch the root app to the TS build behind a flag and retire the JS engine.
6. **Hardening before any remote hosting**: authentication, CORS allow-list, request-size and rate limits, run quotas, pagination.
7. **CI**: a workflow running `scripts/verify.sh` (none exists yet; it needs Python, Node and a Chromium).
8. **Hosting decision** for the API (no host, account or paid service was provisioned here).
