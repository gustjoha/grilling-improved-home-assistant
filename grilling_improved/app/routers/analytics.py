"""Analytics API routes."""
import csv
import io
import json
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

import database as db

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/preset-stats")
async def preset_stats():
    """Per-preset aggregated statistics for the stats page."""
    return await db.get_preset_stats()


@router.get("/weather-correlation")
async def weather_correlation():
    """All sessions with weather data for scatter plot."""
    return await db.get_weather_correlation()


@router.get("/grill-personality")
async def grill_personality():
    """Ambient probe statistics across all sessions."""
    return await db.get_grill_personality()


@router.get("/compare")
async def compare_sessions(session_ids: str = Query(..., description="Comma-separated session IDs")):
    """Return readings for multiple sessions normalised to minutes-from-start."""
    ids = [s.strip() for s in session_ids.split(",") if s.strip()]
    if not ids:
        raise HTTPException(400, "Provide at least one session_id")
    if len(ids) > 10:
        raise HTTPException(400, "Maximum 10 sessions for comparison")

    sessions = []
    for sid in ids:
        session = await db.get_session(sid)
        if session:
            sessions.append(session)

    readings = await db.get_comparison_readings(ids)
    return {"sessions": sessions, "readings": readings}


@router.get("/preset/{preset}/sessions")
async def sessions_by_preset(preset: str, limit: int = Query(20, le=50)):
    """All completed sessions for a specific preset."""
    return await db.get_sessions_by_preset(preset, limit=limit)


# ── Export ────────────────────────────────────────────────────────────────────

@router.get("/export/session/{session_id}/csv")
async def export_session_csv(session_id: str):
    """Export full session readings as CSV."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    readings = await db.get_readings(session_id)

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=["ts", "temp", "ambient", "ror"])
    writer.writeheader()
    writer.writerows(readings)

    filename = f"cook_{session.get('name', session_id).replace(' ', '_')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/session/{session_id}/json")
async def export_session_json(session_id: str):
    """Export full session + readings as JSON."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    readings = await db.get_readings(session_id)
    milestones = await db.get_milestones(session_id)

    payload = {"session": session, "readings": readings, "milestones": milestones}
    filename = f"cook_{session.get('name', session_id).replace(' ', '_')}.json"
    return StreamingResponse(
        iter([json.dumps(payload, indent=2, default=str)]),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/all/csv")
async def export_all_csv():
    """Export all sessions summary as CSV (no readings)."""
    sessions = await db.get_all_sessions(limit=1000)
    if not sessions:
        raise HTTPException(404, "No sessions found")

    fields = [
        "id", "name", "probe_name", "preset", "started_at", "ended_at",
        "end_reason", "goal", "target_temp", "peak_temp", "min_temp",
        "goal_reached_at", "stall_started_at", "stall_temp",
        "ambient_start", "ambient_end",
        "weather_temp", "weather_humidity", "weather_condition",
        "meat_weight_kg", "notes",
    ]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(sessions)

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="all_cooks.csv"'},
    )
