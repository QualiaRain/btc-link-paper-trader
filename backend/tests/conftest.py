import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from paper_trail.api import create_app
from paper_trail.records import RunStore

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "parity" / "fixtures"


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(store=RunStore(tmp_path / "runs"), web_dir=tmp_path / "no-web"))


@pytest.fixture
def browser_completed():
    return json.loads((FIXTURES / "browser-run-completed.json").read_text())


@pytest.fixture
def browser_partial():
    return json.loads((FIXTURES / "browser-run-partial-manual.json").read_text())


@pytest.fixture
def browser_live():
    return json.loads((FIXTURES / "browser-run-live-partial.json").read_text())
