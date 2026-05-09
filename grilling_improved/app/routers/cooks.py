"""Cook session API routes."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import database as db
import ha_client

router = APIRouter(prefix="/api/cooks", tags=["cooks"])


class StartCookRequest(BaseModel):
    probe_id: str
    name: str
    preset: Optional[str] = None
    notes: str = ""
    target_temp: Optional[float] = None
    lower_threshold: Optional[float] = None
    upper_threshold: Optional[float] = None
    goal: str = "at_target_temperature"
    auto_end: bool = True
    auto_end_minutes: int = 10


class UpdateCookRequest(BaseModel):
    name: Optional[str] = None
    preset: Optional[str] = None
    notes: Optional[str] = None
    target_temp: Optional[float] = None
    lower_threshold: Optional[float] = None
    upper_threshold: Optional[float] = None
    goal: Optional[str] = None
    auto_end: Optional[bool] = None
    auto_end_minutes: Optional[int] = None


@router.get("")
async def list_sessions():
    return await db.get_all_sessions()


@router.get("/active")
async def list_active_sessions():
    return await db.get_all_active_sessions()


@router.get("/{session_id}")
async def get_session(session_id: str):
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session


@router.post("/start")
async def start_cook(data: StartCookRequest):
    probe = await db.get_probe(data.probe_id)
    if not probe:
        raise HTTPException(404, "Probe not found")

    # End any existing active session for this probe
    existing = await db.get_active_session(data.probe_id)
    if existing:
        await _end_session_internal(existing["id"], "superseded", probe)

    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    # Capture ambient start
    ambient_start = None
    if probe.get("ambient_entity"):
        ambient_start = ha_client.get_state_float(probe["ambient_entity"])

    session = await db.create_session({
        "id": session_id,
        "probe_id": data.probe_id,
        "name": data.name,
        "preset": data.preset,
        "notes": data.notes,
        "target_temp": data.target_temp,
        "lower_threshold": data.lower_threshold,
        "upper_threshold": data.upper_threshold,
        "goal": data.goal,
        "auto_end": data.auto_end,
        "auto_end_minutes": data.auto_end_minutes,
        "started_at": now,
        "ambient_start": ambient_start,
    })

    # Turn on enable switch if configured
    if probe.get("enable_switch"):
        await ha_client.call_service(
            probe["enable_switch"].split(".")[0],
            "turn_on",
            {"entity_id": probe["enable_switch"]},
        )

    if ha_client.broadcast_fn:
        await ha_client.broadcast_fn({"type": "session_started", "session": session})

    return session


@router.patch("/{session_id}")
async def update_cook(session_id: str, data: UpdateCookRequest):
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if session.get("ended_at"):
        raise HTTPException(400, "Cannot update a completed session")

    updates = {k: v for k, v in data.model_dump().items() if v is not None}

    # If target_temp changed and goal_reached_at was set, reset it so new target can re-trigger
    if "target_temp" in updates and updates["target_temp"] != session.get("target_temp"):
        updates["goal_reached_at"] = None
        ha_client.cancel_auto_end(session_id)

    updated = await db.update_session(session_id, updates)

    if ha_client.broadcast_fn:
        await ha_client.broadcast_fn({"type": "session_updated", "session": updated})

    return updated


@router.post("/{session_id}/end")
async def end_cook(session_id: str):
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if session.get("ended_at"):
        raise HTTPException(400, "Session already ended")

    probe = await db.get_probe(session["probe_id"])
    ha_client.cancel_auto_end(session_id)
    await _end_session_internal(session_id, "manual", probe)
    return await db.get_session(session_id)


async def _end_session_internal(session_id: str, reason: str, probe: Optional[dict]):
    ambient_end = None
    if probe and probe.get("ambient_entity"):
        ambient_end = ha_client.get_state_float(probe["ambient_entity"])
    await db.end_session(session_id, reason, ambient_end)

    if ha_client.broadcast_fn:
        await ha_client.broadcast_fn({
            "type": "session_ended",
            "session_id": session_id,
            "reason": reason,
        })
