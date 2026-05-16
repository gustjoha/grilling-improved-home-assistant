"""Cook session API routes."""
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import database as db
import ha_client

router = APIRouter(prefix="/api/cooks", tags=["cooks"])


class MilestoneIn(BaseModel):
    temp: float
    label: Optional[str] = None


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
    meat_weight_kg: Optional[float] = None
    rest_minutes: int = 0
    milestones: List[MilestoneIn] = []


class UpdateCookRequest(BaseModel):
    name: Optional[str] = None
    preset: Optional[str] = None
    notes: Optional[str] = None
    journal: Optional[str] = None
    target_temp: Optional[float] = None
    lower_threshold: Optional[float] = None
    upper_threshold: Optional[float] = None
    goal: Optional[str] = None
    auto_end: Optional[bool] = None
    auto_end_minutes: Optional[int] = None
    meat_weight_kg: Optional[float] = None
    rest_minutes: Optional[int] = None


class RestTimerRequest(BaseModel):
    minutes: int


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
    session["milestones"] = await db.get_milestones(session_id)
    return session


@router.post("/start")
async def start_cook(data: StartCookRequest):
    probe = await db.get_probe(data.probe_id)
    if not probe:
        raise HTTPException(404, "Probe not found")

    # End any existing active session
    existing = await db.get_active_session(data.probe_id)
    if existing:
        await _end_session_internal(existing["id"], "superseded", probe)

    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    # Ambient start
    ambient_start = None
    if probe.get("ambient_entity"):
        ambient_start = ha_client.get_state_float(probe["ambient_entity"])

    # Weather snapshot
    weather = {}
    if probe.get("weather_entity"):
        weather = await ha_client.get_weather_snapshot(probe["weather_entity"])

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
        "meat_weight_kg": data.meat_weight_kg,
        "rest_minutes": data.rest_minutes,
        **weather,
    })

    # Create milestones
    if data.milestones:
        await db.create_milestones(
            session_id, data.probe_id,
            [m.model_dump() for m in data.milestones]
        )

    # Enable switch
    if probe.get("enable_switch"):
        await ha_client.call_service(
            probe["enable_switch"].split(".")[0], "turn_on",
            {"entity_id": probe["enable_switch"]},
        )

    # Fire HA event
    await ha_client.fire_ha_event("grilling_improved_cook_started", {
        "session_id": session_id,
        "probe_id": data.probe_id,
        "session_name": data.name,
        "preset": data.preset,
        "target_temp": data.target_temp,
    })

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

    updates = data.model_dump(exclude_unset=True)

    # If target changed, reset goal_reached and cancel auto-end
    if "target_temp" in updates and updates["target_temp"] != session.get("target_temp"):
        updates["goal_reached_at"] = None
        ha_client.cancel_auto_end(session_id)

    updated = await db.update_session(session_id, updates)
    if ha_client.broadcast_fn:
        await ha_client.broadcast_fn({"type": "session_updated", "session": updated})
    return updated


@router.patch("/{session_id}/journal")
async def update_journal(session_id: str, payload: dict):
    """Update cook journal notes."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    updated = await db.update_session(session_id, {"journal": payload.get("journal", "")})
    return updated


@router.post("/{session_id}/rest")
async def start_rest_timer(session_id: str, data: RestTimerRequest):
    """Start the post-cook rest timer."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    await ha_client.schedule_rest_timer(session_id, session["probe_id"], data.minutes)
    return {"ok": True, "rest_minutes": data.minutes}


@router.delete("/{session_id}/rest")
async def cancel_rest_timer(session_id: str):
    """Cancel a running rest timer."""
    ha_client.cancel_rest_timer(session_id)
    await db.update_session(session_id, {"rest_started_at": None, "rest_ended_at": None})
    return {"ok": True}


@router.post("/{session_id}/photo")
async def save_photo(session_id: str, payload: dict):
    """Save a base64-encoded photo to the session."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    photo_data = payload.get("photo_data", "")
    if len(photo_data) > 5_000_000:
        raise HTTPException(400, "Photo too large (max ~3.5MB base64)")
    await db.update_session(session_id, {"photo_data": photo_data})
    return {"ok": True}


@router.post("/{session_id}/milestones")
async def add_milestones(session_id: str, milestones: List[MilestoneIn]):
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    await db.create_milestones(session_id, session["probe_id"],
                                [m.model_dump() for m in milestones])
    return await db.get_milestones(session_id)


@router.get("/{session_id}/milestones")
async def get_milestones(session_id: str):
    return await db.get_milestones(session_id)


@router.post("/{session_id}/cook-again")
async def cook_again(session_id: str):
    """Start a new cook session with the same settings as a past one."""
    old = await db.get_session(session_id)
    if not old:
        raise HTTPException(404, "Session not found")

    probe = await db.get_probe(old["probe_id"])
    if not probe:
        raise HTTPException(404, "Probe no longer exists")

    old_milestones = await db.get_milestones(session_id)

    req = StartCookRequest(
        probe_id=old["probe_id"],
        name=f"{old['name']} (repeat)",
        preset=old.get("preset"),
        notes=old.get("notes", ""),
        target_temp=old.get("target_temp"),
        lower_threshold=old.get("lower_threshold"),
        upper_threshold=old.get("upper_threshold"),
        goal=old.get("goal", "at_target_temperature"),
        auto_end=bool(old.get("auto_end", True)),
        auto_end_minutes=old.get("auto_end_minutes", 10),
        meat_weight_kg=old.get("meat_weight_kg"),
        rest_minutes=old.get("rest_minutes", 0),
        milestones=[MilestoneIn(temp=m["temp"], label=m.get("label")) for m in old_milestones],
    )
    return await start_cook(req)


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
            "type": "session_ended", "session_id": session_id, "reason": reason,
        })


# ── Cook Notes ────────────────────────────────────────────────────────────────

class NoteCreate(BaseModel):
    note: str
    photo_data: Optional[str] = None


@router.get("/{session_id}/notes")
async def get_notes(session_id: str):
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return await db.get_notes(session_id)


@router.post("/{session_id}/notes")
async def add_note(session_id: str, data: NoteCreate):
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if data.photo_data and len(data.photo_data) > 5_000_000:
        raise HTTPException(400, "Photo too large (max ~3.5MB base64)")
    note = await db.add_note(session_id, data.note.strip(), data.photo_data or None)
    if ha_client.broadcast_fn:
        await ha_client.broadcast_fn({"type": "note_added", "session_id": session_id, "note": note})
    return note


@router.delete("/{session_id}/notes/{note_id}")
async def delete_note(session_id: str, note_id: int):
    await db.delete_note(note_id)
    return {"ok": True}
