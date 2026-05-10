"""Probe management API routes."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import database as db
import ha_client

router = APIRouter(prefix="/api/probes", tags=["probes"])


class ProbeCreate(BaseModel):
    name: str
    probe_entity: str
    ambient_entity: Optional[str] = None
    enable_switch: Optional[str] = None
    weather_entity: Optional[str] = None
    goal: str = "at_target_temperature"
    target_temp: Optional[float] = None
    lower_threshold: Optional[float] = None
    upper_threshold: Optional[float] = None
    preset: Optional[str] = None
    notes: str = ""
    alert_enabled: bool = True


class ProbeUpdate(BaseModel):
    name: Optional[str] = None
    probe_entity: Optional[str] = None
    ambient_entity: Optional[str] = None
    enable_switch: Optional[str] = None
    weather_entity: Optional[str] = None
    goal: Optional[str] = None
    target_temp: Optional[float] = None
    lower_threshold: Optional[float] = None
    upper_threshold: Optional[float] = None
    preset: Optional[str] = None
    notes: Optional[str] = None
    alert_enabled: Optional[bool] = None


@router.get("")
async def list_probes():
    probes = await db.get_all_probes()
    # Enrich with live state
    for probe in probes:
        probe["current_temp"] = ha_client.get_state_float(probe["probe_entity"])
        probe["current_ambient"] = (
            ha_client.get_state_float(probe["ambient_entity"])
            if probe.get("ambient_entity") else None
        )
        if probe.get("enable_switch"):
            probe["switch_state"] = ha_client.get_state(probe["enable_switch"])
        else:
            probe["switch_state"] = None
        # Active session
        session = await db.get_active_session(probe["id"])
        probe["active_session"] = session
    return probes


@router.get("/{probe_id}")
async def get_probe(probe_id: str):
    probe = await db.get_probe(probe_id)
    if not probe:
        raise HTTPException(404, "Probe not found")
    probe["current_temp"] = ha_client.get_state_float(probe["probe_entity"])
    probe["current_ambient"] = (
        ha_client.get_state_float(probe["ambient_entity"])
        if probe.get("ambient_entity") else None
    )
    if probe.get("enable_switch"):
        probe["switch_state"] = ha_client.get_state(probe["enable_switch"])
    session = await db.get_active_session(probe_id)
    probe["active_session"] = session
    return probe


@router.post("")
async def create_probe(data: ProbeCreate):
    probe_id = str(uuid.uuid4())[:8]
    probe = data.model_dump()
    probe["id"] = probe_id
    return await db.create_probe(probe)


@router.patch("/{probe_id}")
async def update_probe(probe_id: str, data: ProbeUpdate):
    probe = await db.get_probe(probe_id)
    if not probe:
        raise HTTPException(404, "Probe not found")
    # Use model_dump with exclude_unset=True so only fields the client
    # explicitly sent are included — this allows sending null to clear a field
    updates = data.model_dump(exclude_unset=True)
    return await db.update_probe(probe_id, updates)


@router.delete("/{probe_id}")
async def delete_probe(probe_id: str):
    probe = await db.get_probe(probe_id)
    if not probe:
        raise HTTPException(404, "Probe not found")
    # End any active session first
    session = await db.get_active_session(probe_id)
    if session:
        await db.end_session(session["id"], "probe_deleted")
    await db.delete_probe(probe_id)
    return {"ok": True}


@router.post("/{probe_id}/switch")
async def toggle_switch(probe_id: str, payload: dict):
    probe = await db.get_probe(probe_id)
    if not probe:
        raise HTTPException(404, "Probe not found")
    if not probe.get("enable_switch"):
        raise HTTPException(400, "No enable switch configured for this probe")
    state = payload.get("state", True)
    domain = probe["enable_switch"].split(".")[0]
    service = "turn_on" if state else "turn_off"
    ok = await ha_client.call_service(domain, service, {"entity_id": probe["enable_switch"]})
    return {"ok": ok}
