"""SQLite database layer for Grilling Improved."""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

import aiosqlite

_LOGGER = logging.getLogger(__name__)
DB_PATH = os.path.join(os.environ.get("DATA_DIR", "/data"), "grilling.db")


# ── Schema ────────────────────────────────────────────────────────────────────

CREATE_PROBES = """
CREATE TABLE IF NOT EXISTS probes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    probe_entity        TEXT NOT NULL,
    ambient_entity      TEXT,
    enable_switch       TEXT,
    goal                TEXT NOT NULL DEFAULT 'at_target_temperature',
    target_temp         REAL,
    lower_threshold     REAL,
    upper_threshold     REAL,
    preset              TEXT,
    notes               TEXT DEFAULT '',
    alert_enabled       INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
)
"""

CREATE_COOK_SESSIONS = """
CREATE TABLE IF NOT EXISTS cook_sessions (
    id                  TEXT PRIMARY KEY,
    probe_id            TEXT NOT NULL,
    name                TEXT NOT NULL,
    preset              TEXT,
    notes               TEXT DEFAULT '',
    target_temp         REAL,
    lower_threshold     REAL,
    upper_threshold     REAL,
    goal                TEXT NOT NULL DEFAULT 'at_target_temperature',
    auto_end            INTEGER NOT NULL DEFAULT 1,
    auto_end_minutes    INTEGER NOT NULL DEFAULT 10,
    started_at          TEXT NOT NULL,
    ended_at            TEXT,
    end_reason          TEXT,
    peak_temp           REAL,
    min_temp            REAL,
    goal_reached_at     TEXT,
    ambient_start       REAL,
    ambient_end         REAL,
    FOREIGN KEY (probe_id) REFERENCES probes(id)
)
"""

CREATE_READINGS = """
CREATE TABLE IF NOT EXISTS readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    probe_id    TEXT NOT NULL,
    ts          TEXT NOT NULL,
    temp        REAL,
    ambient     REAL,
    FOREIGN KEY (session_id) REFERENCES cook_sessions(id)
)
"""

CREATE_READINGS_IDX = """
CREATE INDEX IF NOT EXISTS idx_readings_session
ON readings(session_id, ts)
"""


async def init_db():
    """Create tables if they don't exist."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(CREATE_PROBES)
        await db.execute(CREATE_COOK_SESSIONS)
        await db.execute(CREATE_READINGS)
        await db.execute(CREATE_READINGS_IDX)
        await db.commit()
    _LOGGER.info("Database initialised at %s", DB_PATH)


def _row_to_dict(row, cursor) -> dict:
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


# ── Probes ────────────────────────────────────────────────────────────────────

async def get_all_probes() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM probes ORDER BY created_at") as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def get_probe(probe_id: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM probes WHERE id=?", (probe_id,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def create_probe(probe: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO probes
               (id,name,probe_entity,ambient_entity,enable_switch,goal,
                target_temp,lower_threshold,upper_threshold,preset,notes,
                alert_enabled,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                probe["id"], probe["name"], probe["probe_entity"],
                probe.get("ambient_entity"), probe.get("enable_switch"),
                probe.get("goal", "at_target_temperature"),
                probe.get("target_temp"), probe.get("lower_threshold"),
                probe.get("upper_threshold"), probe.get("preset"),
                probe.get("notes", ""), int(probe.get("alert_enabled", True)),
                now, now,
            ),
        )
        await db.commit()
    return await get_probe(probe["id"])


async def update_probe(probe_id: str, updates: dict) -> Optional[dict]:
    now = datetime.now(timezone.utc).isoformat()
    allowed = {
        "name", "probe_entity", "ambient_entity", "enable_switch", "goal",
        "target_temp", "lower_threshold", "upper_threshold", "preset",
        "notes", "alert_enabled",
    }
    fields = {k: v for k, v in updates.items() if k in allowed}
    fields["updated_at"] = now
    set_clause = ", ".join(f"{k}=?" for k in fields)
    values = list(fields.values()) + [probe_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE probes SET {set_clause} WHERE id=?", values)
        await db.commit()
    return await get_probe(probe_id)


async def delete_probe(probe_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM probes WHERE id=?", (probe_id,))
        await db.commit()


# ── Cook Sessions ─────────────────────────────────────────────────────────────

async def create_session(session: dict) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO cook_sessions
               (id,probe_id,name,preset,notes,target_temp,lower_threshold,
                upper_threshold,goal,auto_end,auto_end_minutes,started_at,
                ambient_start)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                session["id"], session["probe_id"], session["name"],
                session.get("preset"), session.get("notes", ""),
                session.get("target_temp"), session.get("lower_threshold"),
                session.get("upper_threshold"),
                session.get("goal", "at_target_temperature"),
                int(session.get("auto_end", True)),
                session.get("auto_end_minutes", 10),
                session["started_at"],
                session.get("ambient_start"),
            ),
        )
        await db.commit()
    return await get_session(session["id"])


async def get_session(session_id: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM cook_sessions WHERE id=?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_active_session(probe_id: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM cook_sessions WHERE probe_id=? AND ended_at IS NULL",
            (probe_id,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_all_active_sessions() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM cook_sessions WHERE ended_at IS NULL"
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def update_session(session_id: str, updates: dict) -> Optional[dict]:
    allowed = {
        "name", "preset", "notes", "target_temp", "lower_threshold",
        "upper_threshold", "goal", "auto_end", "auto_end_minutes",
        "ended_at", "end_reason", "peak_temp", "min_temp",
        "goal_reached_at", "ambient_start", "ambient_end",
    }
    fields = {k: v for k, v in updates.items() if k in allowed}
    set_clause = ", ".join(f"{k}=?" for k in fields)
    values = list(fields.values()) + [session_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"UPDATE cook_sessions SET {set_clause} WHERE id=?", values
        )
        await db.commit()
    return await get_session(session_id)


async def end_session(session_id: str, reason: str, ambient_end: Optional[float] = None) -> Optional[dict]:
    now = datetime.now(timezone.utc).isoformat()
    updates = {"ended_at": now, "end_reason": reason}
    if ambient_end is not None:
        updates["ambient_end"] = ambient_end
    return await update_session(session_id, updates)


async def get_sessions_for_probe(probe_id: str, limit: int = 20) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT * FROM cook_sessions WHERE probe_id=?
               ORDER BY started_at DESC LIMIT ?""",
            (probe_id, limit),
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def get_all_sessions(limit: int = 50) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT cs.*, p.name as probe_name
               FROM cook_sessions cs
               LEFT JOIN probes p ON cs.probe_id = p.id
               ORDER BY cs.started_at DESC LIMIT ?""",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


# ── Readings ──────────────────────────────────────────────────────────────────

async def insert_reading(session_id: str, probe_id: str, temp: Optional[float], ambient: Optional[float]):
    ts = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO readings (session_id,probe_id,ts,temp,ambient) VALUES (?,?,?,?,?)",
            (session_id, probe_id, ts, temp, ambient),
        )
        await db.commit()


async def get_readings(session_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT ts,temp,ambient FROM readings WHERE session_id=? ORDER BY ts",
            (session_id,),
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def get_recent_readings(session_id: str, minutes: int = 30) -> list[dict]:
    """Get readings from the last N minutes for live chart."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT ts,temp,ambient FROM readings
               WHERE session_id=?
               AND ts >= datetime('now', ?)
               ORDER BY ts""",
            (session_id, f"-{minutes} minutes"),
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]
