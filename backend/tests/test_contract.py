import json
from pathlib import Path

from paper_trail.contract import build

CONTRACT = Path(__file__).resolve().parents[2] / "contract" / "openapi.json"


def test_committed_openapi_contract_matches_the_service():
    """Fails when the API changes without regenerating contract/openapi.json (and the TS types)."""
    assert CONTRACT.read_text() == build(), "Run: python -m paper_trail.contract && (cd web && npm run types)"


def test_contract_is_versioned_and_documents_errors():
    spec = json.loads(CONTRACT.read_text())
    assert spec["info"]["version"] == "1"
    assert all(path.startswith("/v1/") for path in spec["paths"])
    replay = spec["paths"]["/v1/replays"]["post"]
    assert replay["operationId"] == "createReplay" and "422" in replay["responses"]
