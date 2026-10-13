"""Shared HTTP error type. Rendered as {"error": {"code", "message", ...extra}} by api.py."""
from __future__ import annotations

from typing import Any


class ApiProblem(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra
