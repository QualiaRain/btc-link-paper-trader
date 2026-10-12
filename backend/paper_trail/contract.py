"""Write the OpenAPI contract: `python -m paper_trail.contract [path]` (default: contract/openapi.json)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .api import REPO_ROOT, create_app
from .records import RunStore


# FastAPI copies `http.HTTPStatus` phrases into response descriptions, and those differ between
# Python versions (422 is "Unprocessable Entity" before 3.13 and "Unprocessable Content" from 3.13).
# Fixed text keeps the committed contract identical on every supported interpreter.
STATUS_DESCRIPTIONS = {
    "200": "Successful Response", "201": "Created", "202": "Accepted", "400": "Bad Request", "404": "Not Found",
    "409": "Conflict", "422": "Unprocessable Entity", "429": "Too Many Requests", "501": "Not Implemented", "502": "Bad Gateway",
}


def build() -> str:
    # A throwaway store and no web mount keep the document independent of the environment.
    schema = create_app(store=RunStore(), web_dir=REPO_ROOT / "does-not-exist").openapi()
    for item in schema["paths"].values():
        for operation in item.values():
            for code, response in operation.get("responses", {}).items():
                if code not in STATUS_DESCRIPTIONS:
                    raise SystemExit(f"Add a fixed description for HTTP {code} to contract.STATUS_DESCRIPTIONS")
                response["description"] = STATUS_DESCRIPTIONS[code]
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "contract" / "openapi.json"
    target.write_text(build())
    print(f"wrote {target}")
