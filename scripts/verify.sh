#!/usr/bin/env bash
# Runs every check for the Python backend / TypeScript client slice plus the existing JavaScript tests.
# Prerequisites: Node 22+, Python 3.11+, `pip install -e "backend[dev]"`, `npm ci --prefix web`.
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHON="${PYTHON:-python3}"
# The browser regression tests must run, not skip: a missing Chromium is a failure here.
# (Install one with `npx playwright-core install chromium` or set CHROMIUM_PATH.)
export REQUIRE_BROWSER=1

echo "== existing JavaScript tests (unchanged app) =="
npm test
echo "== JavaScript goldens still match the existing JS =="
node --test parity/golden.test.mjs
echo "== Python backend tests (unit, API, parity vs JS goldens, contract drift) =="
(cd backend && "$PYTHON" -m pytest -q)
echo "== TypeScript: generated types match the contract, typecheck, build, end-to-end + real-Chromium UI tests against the running API =="
(cd web && npm run types:check && npm run typecheck && npm run build && npm test)
echo "all checks passed"
