"""Canonical JSON compatible with history.js `canonicalJSON`, so SHA-256 evidence
hashes computed here equal the ones the browser app computes for the same data."""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any


def js_number(value: float | int) -> str:
    """Format a number exactly as ECMAScript Number::toString does."""
    if isinstance(value, bool):
        raise TypeError("bool is not a JSON number")
    x = float(value)
    if not math.isfinite(x):
        raise ValueError("Run evidence contains a non-finite number")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    # repr() yields the shortest round-tripping digits, as JavaScript does.
    parts = Decimal(repr(abs(x))).as_tuple()
    raw_digits = "".join(map(str, parts.digits))
    exponent = parts.exponent
    digits = raw_digits.rstrip("0") or "0"
    k = len(digits)
    n = len(raw_digits) + exponent  # position of the decimal point
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mantissa = digits[0] if k == 1 else digits[0] + "." + digits[1:]
        body = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


def _utf16_key(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


def canonical_json(value: Any) -> str:
    def emit(item: Any) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, (int, float)):
            return js_number(item)
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False)
        if isinstance(item, (list, tuple)):
            return "[" + ",".join(emit(v) for v in item) + "]"
        if isinstance(item, dict):
            # Like JS, keys sort by UTF-16 code unit and undefined (None here is
            # JSON null, which JS keeps) values are retained.
            parts = [json.dumps(k, ensure_ascii=False) + ":" + emit(item[k])
                     for k in sorted(item, key=_utf16_key)]
            return "{" + ",".join(parts) + "}"
        raise TypeError("Run evidence must contain JSON values")

    return emit(value)


def sha256_canonical(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def js_copy(value: Any) -> Any:
    """Round-trip through canonical JSON like history.js `copy`."""
    return json.loads(canonical_json(value))
