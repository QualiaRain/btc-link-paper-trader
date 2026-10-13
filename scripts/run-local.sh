#!/usr/bin/env bash
# Starts the Python/TypeScript version on this computer only: http://127.0.0.1:${PORT:-8000}/
# First run installs the backend into ./.venv and the web build tools into web/node_modules; later runs reuse them.
# Saved runs persist in ./.paper-trail-data (set PAPER_TRAIL_DATA_DIR to use another folder). Stop with Ctrl+C.
# Requirements: Python 3.11+, Node 22+. The server listens on 127.0.0.1 only and has no login; do not expose it.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
PORT="${PORT:-8000}"
PYTHON="${PYTHON:-python3}"

fail() { echo "run-local: $*" >&2; exit 1; }

command -v "$PYTHON" >/dev/null || fail "Python 3.11+ is required ($PYTHON not found; set PYTHON=/path/to/python3)."
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 11))' \
  || fail "Python 3.11+ is required; found $("$PYTHON" --version 2>&1)."
command -v node >/dev/null || fail "Node 22+ is required (node not found)."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node 22+ is required; found $(node --version)."

if [ ! -x .venv/bin/python ]; then
  echo "run-local: creating .venv and installing the backend (first run only)..."
  "$PYTHON" -m venv .venv
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -e backend
fi
.venv/bin/python -c 'import paper_trail, fastapi, uvicorn' 2>/dev/null \
  || .venv/bin/python -m pip install --quiet -e backend

if [ ! -d web/node_modules ]; then
  echo "run-local: installing web build tools (first run only)..."
  npm ci --prefix web --silent
fi
echo "run-local: building the web UI..."
npm run build --prefix web --silent

export PAPER_TRAIL_DATA_DIR="${PAPER_TRAIL_DATA_DIR:-$REPO/.paper-trail-data}"
mkdir -p "$PAPER_TRAIL_DATA_DIR"
echo "run-local: saved runs are kept in $PAPER_TRAIL_DATA_DIR"
echo "run-local: open http://127.0.0.1:$PORT/  (Ctrl+C to stop)"
exec .venv/bin/python -m uvicorn --factory paper_trail.api:create_app --host 127.0.0.1 --port "$PORT" --log-level warning
