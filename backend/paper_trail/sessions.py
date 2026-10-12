"""Server-held stepwise replay sessions with manual paper orders.

A session owns one replay account and reveals it causally: frames are ingested strictly in order and only the
latest ingested frame is ever exposed. Behaviour mirrors app.js (`start`, `ingestNext`, `replayWork`, `order`):

* create  = same dataset construction and first-frame ingest as a complete replay (`replay.prepare_replay`);
* advance = `frames` ingests `count` frames, `decision` ingests until the next automatic decision is due
  (`target = (lastDecisionAt ?? currentFrame.time) + horizon`), `finish` runs to the end;
* order   = `manual_trade(account, asset, side, buy ? dollars : (dollars ?? MAX_FLOAT), currentFrame)`.

Every successful state change bumps `version` by one. Mutating calls carry `expectedVersion`; a mismatch changes
nothing. Work happens on a deep copy of the account that replaces the live one only on success, so a rejected
call leaves state and version untouched. Each session has its own lock; a stale loser of a race gets a 409.

A session claims its run id from the `RunStore` while it is open: only the owner writes snapshots to that id and
imports cannot overwrite it. Closing releases the id; saved snapshots remain. Sessions live in memory only.
"""
from __future__ import annotations

import threading
import uuid
from copy import deepcopy
from typing import Any

from .engine import ASSETS, MAX_FLOAT, get_summary, ingest, manual_trade
from .errors import ApiProblem
from .records import RunOwned, RunStore, make_run_record, market_for, run_metadata
from .replay import prepare_replay, start_account

MAX_SESSIONS = 64


def _stale(current: int) -> ApiProblem:
    return ApiProblem(409, "stale_session", f"Session changed: expected version differs from {current}; "
                                            "reload the session state and retry", currentVersion=current)


class Session:
    def __init__(self, session_id: str, run_id: str, settings: dict, config: dict, dataset: dict, account: dict,
                 name: str | None) -> None:
        self.id, self.run_id = session_id, run_id
        self.lock = threading.Lock()
        self.settings, self.dataset, self.account, self.name = settings, dataset, account, name
        self.frames: list[dict] | None = dataset["frames"]
        self.cursor = dataset["cursor"]
        self.frame_count = len(self.frames)
        self.version = 1
        self.saved_version: int | None = None
        self.closed = False
        self.closed_order = 0
        self._final_frame: dict | None = None
        self._horizon = account["config"]["horizonMs"]

    # ---- views (call with the lock held) -------------------------------------------------------
    def _frame(self) -> dict:
        return self._final_frame if self.frames is None else self.frames[self.cursor]

    def _revealed_all(self) -> bool:
        return self.account["status"] == "completed" or self.cursor >= self.frame_count - 1

    def state(self) -> dict[str, Any]:
        account = self.account
        frame = self._frame()
        quotes = {a: {k: frame["quotes"][a].get(k) for k in ("bid", "ask", "mid", "observedAt", "source")}
                  for a in ASSETS}
        completed = account["status"] == "completed"
        last = account["lastDecisionAt"]
        return {
            "id": self.id, "runId": self.run_id,
            "status": "closed" if self.closed else "completed" if self._revealed_all() else "active",
            "version": self.version, "kind": self.dataset["kind"], "cursor": self.cursor,
            "frameCount": self.frame_count, "warmupFrameCount": self.dataset["warmupFrameCount"],
            "scoreStart": self.dataset["scoreStart"], "scoreEnd": self.dataset["scoreEnd"],
            "currentFrame": {"time": frame["time"], "quotes": quotes},
            "nextDecisionAt": None if completed else (frame["time"] if last is None else last) + self._horizon,
            "config": dict(account["config"]), "summary": get_summary(account),
            "savedVersion": self.saved_version,
            "manualTradeCount": sum(1 for e in account["ledger"] if e["type"] == "trade" and e["actor"] == "manual"),
        }

    def _check(self, expected: int | None, *, live: bool = True) -> None:
        if self.closed:
            raise ApiProblem(409, "session_closed", "The session is closed")
        if expected is not None and expected != self.version:
            raise _stale(self.version)
        if live and self._revealed_all():
            raise ApiProblem(409, "session_completed", "The replay is complete; nothing further can be ingested or traded")

    # ---- operations ----------------------------------------------------------------------------
    def read(self) -> dict[str, Any]:
        with self.lock:
            return self.state()

    def read_account(self) -> dict[str, Any]:
        with self.lock:
            return {"state": self.state(), "account": deepcopy(self.account)}

    def advance(self, expected: int, mode: str, count: int) -> dict[str, Any]:
        with self.lock:
            self._check(expected)
            work = deepcopy(self.account)
            before = len(work["ledger"])
            frames, cursor, ingested = self.frames, self.cursor, 0
            target = (work["lastDecisionAt"] if work["lastDecisionAt"] is not None
                      else frames[cursor]["time"]) + self._horizon
            try:
                while cursor < len(frames) - 1:
                    cursor += 1
                    ingest(work, frames[cursor])
                    ingested += 1
                    if work["status"] == "completed":
                        break
                    if mode == "frames" and ingested >= count:
                        break
                    if mode == "decision" and frames[cursor]["time"] >= target:
                        break
            except ValueError as error:
                raise ApiProblem(422, "replay_rejected", str(error)) from None
            self.account, self.cursor = work, cursor
            self.version += 1
            return {"state": self.state(), "events": deepcopy(work["ledger"][before:]), "framesIngested": ingested}

    def order(self, expected: int, asset: str, side: str, dollars: float | None) -> dict[str, Any]:
        with self.lock:
            self._check(expected)
            if side == "buy" and (dollars is None or not dollars > 0):
                raise ApiProblem(422, "order_rejected", "A buy needs dollars greater than zero")
            work = deepcopy(self.account)
            before = len(work["ledger"])
            try:
                manual_trade(work, asset, side, dollars if side == "buy" or dollars is not None else MAX_FLOAT,
                             self.frames[self.cursor])
            except ValueError as error:
                raise ApiProblem(422, "order_rejected", str(error)) from None
            events = work["ledger"][before:]
            if not any(e["type"] == "trade" for e in events):
                raise ApiProblem(422, "order_rejected", "The order produced no trade: "
                                 + ("no cash available" if side == "buy" else "no position to sell"))
            self.account = work
            self.version += 1
            return {"state": self.state(), "events": deepcopy(events), "framesIngested": 0}

    def save(self, runs: RunStore, expected: int, name: str | None) -> dict[str, Any]:
        with self.lock:
            self._check(expected, live=False)
            label = name if name is not None else self.name
            frame_time = None if self._revealed_all() else self.frames[self.cursor]["time"]
            record = make_run_record(self.account, market_for(self.settings, self.dataset, upto=frame_time),
                                     name=label, run_id=self.run_id)
            try:
                stored = runs.save(record, owner=self.id)
            except RunOwned as error:
                raise ApiProblem(409, "run_owned", f"Run {error.run_id} is not owned by this session") from None
            self.name = label
            self.version += 1
            self.saved_version = self.version
            return {"run": run_metadata(stored), "state": self.state()}

    def close(self, runs: RunStore, expected: int | None, order: int) -> dict[str, Any]:
        with self.lock:
            self._check(expected, live=False)
            self._final_frame, self.frames = self.frames[self.cursor], None  # release the dataset
            self.closed, self.closed_order = True, order
            self.version += 1
            runs.release(self.run_id, self.id)
            return self.state()


class SessionService:
    def __init__(self, runs: RunStore, max_sessions: int = MAX_SESSIONS) -> None:
        self.runs, self.max_sessions = runs, max_sessions
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self._closed_counter = 0

    def _find(self, session_id: str) -> Session:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise ApiProblem(404, "session_not_found", "Session not found")
        return session

    def _make_room(self) -> bool:
        """Callers hold `_lock`. Evicts the oldest closed session if full; True when still no slot is free."""
        if len(self._sessions) < self.max_sessions:
            return False
        closed = [s for s in self._sessions.values() if s.closed]
        if not closed:
            return True
        del self._sessions[min(closed, key=lambda s: s.closed_order).id]
        return False

    def create(self, settings: dict, candles: dict | None, name: str | None) -> dict[str, Any]:
        too_many = ApiProblem(429, "too_many_sessions", f"At most {self.max_sessions} open sessions; close one first")
        with self._lock:
            if len(self._sessions) >= self.max_sessions and all(not s.closed for s in self._sessions.values()):
                raise too_many
        config, dataset = prepare_replay(settings, candles, share_sample=True)  # ValueError -> caller
        account = start_account(config, dataset)
        session_id = str(uuid.uuid4())
        with self._lock:
            if self._make_room():
                raise too_many
            session = Session(session_id, self.runs.claim(session_id), settings, config, dataset, account, name)
            self._sessions[session_id] = session
        return session.read()

    def get(self, session_id: str) -> dict[str, Any]:
        return self._find(session_id).read()

    def get_account(self, session_id: str) -> dict[str, Any]:
        return self._find(session_id).read_account()

    def advance(self, session_id: str, expected: int, mode: str, count: int) -> dict[str, Any]:
        return self._find(session_id).advance(expected, mode, count)

    def order(self, session_id: str, expected: int, asset: str, side: str, dollars: float | None) -> dict[str, Any]:
        return self._find(session_id).order(expected, asset, side, dollars)

    def save(self, session_id: str, expected: int, name: str | None) -> dict[str, Any]:
        return self._find(session_id).save(self.runs, expected, name)

    def close(self, session_id: str, expected: int | None) -> dict[str, Any]:
        session = self._find(session_id)
        with self._lock:
            self._closed_counter += 1
            order = self._closed_counter
        return session.close(self.runs, expected, order)
