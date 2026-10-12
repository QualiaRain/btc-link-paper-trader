"""Write the OpenAPI contract: `python -m paper_trail.contract [path]` (default: contract/openapi.json)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .api import REPO_ROOT, create_app
from .records import RunStore


def build() -> str:
    # A throwaway store and no web mount keep the document independent of the environment.
    schema = create_app(store=RunStore(), web_dir=REPO_ROOT / "does-not-exist").openapi()
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "contract" / "openapi.json"
    target.write_text(build())
    print(f"wrote {target}")
