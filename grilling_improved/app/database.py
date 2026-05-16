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
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    probe_entity        TEXT NOT NULL,
    ambient_entity      TEXT,
    enable_switch       TEXT,
    weather_entity      TEXT,
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
    journal             TEXT DEFAULT '',
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
    stall_started_at    TEXT,
    stall_ended_at      TEXT,
    stall_temp          REAL,
    ambient_start       REAL,
    ambient_end         REAL,
    weather_temp        REAL,
    weather_humidity    REAL,
    weather_condition   TEXT,
    meat_weight_kg      REAL,
    rest_minutes        INTEGER DEFAULT 0,
    rest_started_at     TEXT,
    rest_ended_at       TEXT,
    photo_data          TEXT,
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
    ror         REAL,
    FOREIGN KEY (session_id) REFERENCES cook_sessions(id)
)
"""

CREATE_MILESTONES = """
CREATE TABLE IF NOT EXISTS milestones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    probe_id    TEXT NOT NULL,
    temp        REAL NOT NULL,
    label       TEXT,
    reached_at  TEXT,
    notified    INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES cook_sessions(id)
)
"""

CREATE_NOTES = """
CREATE TABLE IF NOT EXISTS cook_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    ts          TEXT NOT NULL,
    note        TEXT NOT NULL,
    photo_data  TEXT,
    FOREIGN KEY (session_id) REFERENCES cook_sessions(id)
)
"""

CREATE_NOTES_IDX = "CREATE INDEX IF NOT EXISTS idx_notes_session ON cook_notes(session_id, ts)"

CREATE_READINGS_IDX = "CREATE INDEX IF NOT EXISTS idx_readings_session ON readings(session_id, ts)"
CREATE_MILESTONES_IDX = "CREATE INDEX IF NOT EXISTS idx_milestones_session ON milestones(session_id)"


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(CREATE_PROBES)
        await db.execute(CREATE_COOK_SESSIONS)
        await db.execute(CREATE_READINGS)
        await db.execute(CREATE_MILESTONES)
        await db.execute(CREATE_READINGS_IDX)
        await db.execute(CREATE_MILESTONES_IDX)
        # Migrations — add columns if missing
        await _migrate(db)
        await db.commit()
    _LOGGER.info("Database initialised at %s", DB_PATH)


async def _migrate(db):
    """Add new columns to existing tables without breaking old installs."""
    new_probe_cols = [
        ("weather_entity", "TEXT"),
    ]
    new_session_cols = [
        ("journal", "TEXT DEFAULT ''"),
        ("stall_started_at", "TEXT"),
        ("stall_ended_at", "TEXT"),
        ("stall_temp", "REAL"),
        ("weather_temp", "REAL"),
        ("weather_humidity", "REAL"),
        ("weather_condition", "TEXT"),
        ("meat_weight_kg", "REAL"),
        ("rest_minutes", "INTEGER DEFAULT 0"),
        ("rest_started_at", "TEXT"),
        ("rest_ended_at", "TEXT"),
        ("photo_data", "TEXT"),
    ]
    new_reading_cols = [("ror", "REAL")]

    for col, coltype in new_probe_cols:
        try:
            await db.execute(f"ALTER TABLE probes ADD COLUMN {col} {coltype}")
        except Exception:
            pass

    for col, coltype in new_session_cols:
        try:
            await db.execute(f"ALTER TABLE cook_sessions ADD COLUMN {col} {coltype}")
        except Exception:
            pass

    for col, coltype in new_reading_cols:
        try:
            await db.execute(f"ALTER TABLE readings ADD COLUMN {col} {coltype}")
        except Exception:
            pass

    # Ensure cook_notes table exists (added in 2.1.4)
    try:
        await db.execute(CREATE_NOTES)
        await db.execute(CREATE_NOTES_IDX)
    except Exception:
        pass


# ── Probes ────────────────────────────────────────────────────────────────────

async def get_all_probes() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM probes ORDER BY created_at") as cur:
            return [dict(r) for r in await cur.fetchall()]


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
               (id,name,probe_entity,ambient_entity,enable_switch,weather_entity,
                goal,target_temp,lower_threshold,upper_threshold,preset,notes,
                alert_enabled,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                probe["id"], probe["name"], probe["probe_entity"],
                probe.get("ambient_entity"), probe.get("enable_switch"),
                probe.get("weather_entity"),
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
        "name", "probe_entity", "ambient_entity", "enable_switch", "weather_entity",
        "goal", "target_temp", "lower_threshold", "upper_threshold",
        "preset", "notes", "alert_enabled",
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
                ambient_start,weather_temp,weather_humidity,weather_condition,
                meat_weight_kg,rest_minutes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                session.get("weather_temp"),
                session.get("weather_humidity"),
                session.get("weather_condition"),
                session.get("meat_weight_kg"),
                session.get("rest_minutes", 0),
            ),
        )
        await db.commit()
    return await get_session(session["id"])


async def get_session(session_id: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM cook_sessions WHERE id=?", (session_id,)) as cur:
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
        async with db.execute("SELECT * FROM cook_sessions WHERE ended_at IS NULL") as cur:
            return [dict(r) for r in await cur.fetchall()]


async def update_session(session_id: str, updates: dict) -> Optional[dict]:
    allowed = {
        "name", "preset", "notes", "journal", "target_temp", "lower_threshold",
        "upper_threshold", "goal", "auto_end", "auto_end_minutes",
        "ended_at", "end_reason", "peak_temp", "min_temp",
        "goal_reached_at", "stall_started_at", "stall_ended_at", "stall_temp",
        "ambient_start", "ambient_end", "weather_temp", "weather_humidity",
        "weather_condition", "meat_weight_kg", "rest_minutes",
        "rest_started_at", "rest_ended_at", "photo_data",
    }
    fields = {k: v for k, v in updates.items() if k in allowed}
    if not fields:
        return await get_session(session_id)
    set_clause = ", ".join(f"{k}=?" for k in fields)
    values = list(fields.values()) + [session_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE cook_sessions SET {set_clause} WHERE id=?", values)
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
            "SELECT * FROM cook_sessions WHERE probe_id=? ORDER BY started_at DESC LIMIT ?",
            (probe_id, limit),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


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
            return [dict(r) for r in await cur.fetchall()]


# ── Readings ──────────────────────────────────────────────────────────────────

async def insert_reading(session_id: str, probe_id: str, temp: Optional[float],
                         ambient: Optional[float], ror: Optional[float] = None):
    ts = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO readings (session_id,probe_id,ts,temp,ambient,ror) VALUES (?,?,?,?,?,?)",
            (session_id, probe_id, ts, temp, ambient, ror),
        )
        await db.commit()


async def get_readings(session_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT ts,temp,ambient,ror FROM readings WHERE session_id=? ORDER BY ts",
            (session_id,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_recent_readings(session_id: str, minutes: int = 30) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT ts,temp,ambient,ror FROM readings
               WHERE session_id=? AND ts >= datetime('now', ?)
               ORDER BY ts""",
            (session_id, f"-{minutes} minutes"),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_last_n_readings(session_id: str, n: int = 30) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT ts,temp,ambient,ror FROM readings
               WHERE session_id=? ORDER BY ts DESC LIMIT ?""",
            (session_id, n),
        ) as cur:
            rows = await cur.fetchall()
            return list(reversed([dict(r) for r in rows]))


# ── Milestones ────────────────────────────────────────────────────────────────

async def create_milestones(session_id: str, probe_id: str, milestones: list[dict]):
    async with aiosqlite.connect(DB_PATH) as db:
        for m in milestones:
            await db.execute(
                "INSERT INTO milestones (session_id,probe_id,temp,label) VALUES (?,?,?,?)",
                (session_id, probe_id, m["temp"], m.get("label", f"{m['temp']}°C")),
            )
        await db.commit()


async def get_milestones(session_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM milestones WHERE session_id=? ORDER BY temp",
            (session_id,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def mark_milestone_reached(milestone_id: int) -> None:
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE milestones SET reached_at=?, notified=1 WHERE id=?",
            (now, milestone_id),
        )
        await db.commit()


async def get_unreached_milestones(session_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM milestones WHERE session_id=? AND reached_at IS NULL ORDER BY temp",
            (session_id,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── Analytics ─────────────────────────────────────────────────────────────────

async def get_sessions_by_preset(preset: str, limit: int = 20) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT cs.*, p.name as probe_name FROM cook_sessions cs
               LEFT JOIN probes p ON cs.probe_id = p.id
               WHERE cs.preset=? AND cs.ended_at IS NOT NULL
               ORDER BY cs.started_at DESC LIMIT ?""",
            (preset, limit),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_preset_stats() -> list[dict]:
    """Per-preset aggregated statistics."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT
                 preset,
                 COUNT(*) as cook_count,
                 AVG((julianday(ended_at) - julianday(started_at)) * 24 * 60) as avg_duration_min,
                 MIN((julianday(ended_at) - julianday(started_at)) * 24 * 60) as min_duration_min,
                 MAX((julianday(ended_at) - julianday(started_at)) * 24 * 60) as max_duration_min,
                 AVG(peak_temp) as avg_peak_temp,
                 AVG(weather_temp) as avg_weather_temp,
                 AVG(stall_temp) as avg_stall_temp,
                 SUM(CASE WHEN goal_reached_at IS NOT NULL THEN 1 ELSE 0 END) as success_count
               FROM cook_sessions
               WHERE preset IS NOT NULL AND ended_at IS NOT NULL
               GROUP BY preset
               ORDER BY cook_count DESC""",
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_weather_correlation() -> list[dict]:
    """Sessions with weather data for correlation analysis."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT
                 preset,
                 weather_temp,
                 weather_humidity,
                 weather_condition,
                 (julianday(ended_at) - julianday(started_at)) * 24 * 60 as duration_min,
                 peak_temp,
                 stall_temp,
                 started_at
               FROM cook_sessions
               WHERE weather_temp IS NOT NULL AND ended_at IS NOT NULL
               ORDER BY started_at DESC""",
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_grill_personality() -> dict:
    """Aggregate ambient probe stats across all sessions."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT
                 AVG(ambient_start) as avg_ambient_start,
                 AVG(r.ambient) as avg_ambient_reading,
                 MIN(r.ambient) as min_ambient,
                 MAX(r.ambient) as max_ambient,
                 COUNT(DISTINCT cs.id) as session_count
               FROM cook_sessions cs
               JOIN readings r ON r.session_id = cs.id
               WHERE r.ambient IS NOT NULL""",
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else {}


async def get_comparison_readings(session_ids: list[str]) -> dict:
    """Get readings for multiple sessions for overlay chart."""
    result = {}
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        for sid in session_ids:
            async with db.execute(
                """SELECT ts, temp, ambient,
                     (julianday(ts) - julianday(MIN(ts) OVER (PARTITION BY session_id))) * 24 * 60 as minutes_elapsed
                   FROM readings WHERE session_id=? ORDER BY ts""",
                (sid,),
            ) as cur:
                result[sid] = [dict(r) for r in await cur.fetchall()]
    return result

# ── Cook Notes ────────────────────────────────────────────────────────────────

async def add_note(session_id: str, note: str, photo_data: Optional[str] = None) -> dict:
    ts = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO cook_notes (session_id, ts, note, photo_data) VALUES (?,?,?,?)",
            (session_id, ts, note, photo_data),
        )
        row_id = cursor.lastrowid
        await db.commit()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM cook_notes WHERE id=?", (row_id,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else {}


async def get_notes(session_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM cook_notes WHERE session_id=? ORDER BY ts",
            (session_id,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def delete_note(note_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM cook_notes WHERE id=?", (note_id,))
        await db.commit()

async def delete_session(session_id: str):
    """Delete a cook session and all associated readings and notes."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM readings WHERE session_id=?", (session_id,))
        await db.execute("DELETE FROM cook_notes WHERE session_id=?", (session_id,))
        await db.execute("DELETE FROM milestones WHERE session_id=?", (session_id,))
        await db.execute("DELETE FROM cook_sessions WHERE id=?", (session_id,))
        await db.commit()
