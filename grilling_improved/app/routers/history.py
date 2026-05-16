"""History and readings API routes."""
from fastapi import APIRouter, HTTPException, Query

import database as db

router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("")
async def get_history(limit: int = Query(50, le=200)):
    """All cook sessions, newest first."""
    return await db.get_all_sessions(limit=limit)


@router.get("/probe/{probe_id}")
async def get_probe_history(probe_id: str, limit: int = Query(20, le=100)):
    """All cook sessions for a specific probe."""
    probe = await db.get_probe(probe_id)
    if not probe:
        raise HTTPException(404, "Probe not found")
    sessions = await db.get_sessions_for_probe(probe_id, limit=limit)
    return sessions


@router.get("/session/{session_id}/readings")
async def get_session_readings(session_id: str):
    """Full temperature log for a cook session."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    readings = await db.get_readings(session_id)
    notes = await db.get_notes(session_id)
    return {"session": session, "readings": readings, "notes": notes}


@router.get("/session/{session_id}/readings/recent")
async def get_recent_readings(session_id: str, minutes: int = Query(30, le=480)):
    """Recent readings for live chart (default last 30 min)."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    readings = await db.get_recent_readings(session_id, minutes=minutes)
    return {"session": session, "readings": readings}

@router.delete("/session/{session_id}")
async def delete_session(session_id: str):
    """Permanently delete a cook session and all its readings and notes."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    await db.delete_session(session_id)
    return {"ok": True}
