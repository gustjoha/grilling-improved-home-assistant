"""
Home Assistant WebSocket client.
Subscribes to entity state changes and feeds the cook session engine.
"""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Any, Callable, Optional

import aiohttp
import websockets

import database as db

_LOGGER = logging.getLogger(__name__)

HA_URL = os.environ.get("HA_URL", "http://homeassistant:8123")
SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")

# WS URL derived from HA_URL
WS_URL = HA_URL.replace("http://", "ws://").replace("https://", "wss://") + "/api/websocket"

# In-memory state cache: entity_id -> state string
_state_cache: dict[str, Any] = {}

# Callbacks registered by session engine: entity_id -> list of callables
_listeners: dict[str, list[Callable]] = {}

# Message ID counter for WS protocol
_msg_id = 0

# Auto-end timers: session_id -> asyncio.Task
_auto_end_tasks: dict[str, asyncio.Task] = {}

# Reference to broadcast function (set by main.py)
broadcast_fn: Optional[Callable] = None


def next_id() -> int:
    global _msg_id
    _msg_id += 1
    return _msg_id


def get_state(entity_id: str) -> Optional[str]:
    return _state_cache.get(entity_id)


def get_state_float(entity_id: str) -> Optional[float]:
    val = _state_cache.get(entity_id)
    if val in (None, "unknown", "unavailable"):
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def register_listener(entity_id: str, callback: Callable):
    _listeners.setdefault(entity_id, []).append(callback)


def unregister_listener(entity_id: str, callback: Callable):
    if entity_id in _listeners:
        try:
            _listeners[entity_id].remove(callback)
        except ValueError:
            pass


async def call_service(domain: str, service: str, data: dict) -> bool:
    """Call a HA service via REST API."""
    url = f"{HA_URL}/api/services/{domain}/{service}"
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=data, headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as r:
                return r.status in (200, 201)
    except Exception as e:
        _LOGGER.error("Service call failed %s.%s: %s", domain, service, e)
        return False


async def get_ha_states() -> list[dict]:
    """Fetch all HA states via REST."""
    url = f"{HA_URL}/api/states"
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status == 200:
                    return await r.json()
    except Exception as e:
        _LOGGER.error("Failed to fetch HA states: %s", e)
    return []


async def get_ha_entities() -> list[dict]:
    """Return simplified list of all entities for probe picker."""
    states = await get_ha_states()
    return [
        {
            "entity_id": s["entity_id"],
            "friendly_name": s["attributes"].get("friendly_name", s["entity_id"]),
            "state": s["state"],
            "domain": s["entity_id"].split(".")[0],
        }
        for s in states
    ]


async def schedule_auto_end(session_id: str, probe_id: str, minutes: int):
    """Schedule auto-end of a cook session after N minutes."""
    # Cancel any existing timer for this session
    if session_id in _auto_end_tasks:
        _auto_end_tasks[session_id].cancel()

    async def _do_end():
        await asyncio.sleep(minutes * 60)
        session = await db.get_session(session_id)
        if session and not session.get("ended_at"):
            probe = await db.get_probe(probe_id)
            ambient = None
            if probe and probe.get("ambient_entity"):
                ambient = get_state_float(probe["ambient_entity"])
            await db.end_session(session_id, "auto_end_after_target", ambient)
            _LOGGER.info("Session %s auto-ended after %d min post-target", session_id, minutes)
            if broadcast_fn:
                await broadcast_fn({"type": "session_ended", "session_id": session_id, "reason": "auto_end_after_target"})
        _auto_end_tasks.pop(session_id, None)

    task = asyncio.create_task(_do_end())
    _auto_end_tasks[session_id] = task
    _LOGGER.info("Auto-end scheduled for session %s in %d min", session_id, minutes)


def cancel_auto_end(session_id: str):
    task = _auto_end_tasks.pop(session_id, None)
    if task:
        task.cancel()


async def _handle_state_change(entity_id: str, new_state: str, attributes: dict):
    """Called on every HA state change for subscribed entities."""
    _state_cache[entity_id] = new_state

    # Notify registered listeners
    for cb in _listeners.get(entity_id, []):
        try:
            await cb(entity_id, new_state, attributes)
        except Exception as e:
            _LOGGER.error("Listener error for %s: %s", entity_id, e)

    # Find active sessions that use this entity as probe or ambient
    active_sessions = await db.get_all_active_sessions()
    for session in active_sessions:
        probe = await db.get_probe(session["probe_id"])
        if not probe:
            continue

        is_probe = probe.get("probe_entity") == entity_id
        is_ambient = probe.get("ambient_entity") == entity_id

        if not is_probe and not is_ambient:
            continue

        temp = None
        ambient = None

        if is_probe:
            try:
                temp = float(new_state)
            except (ValueError, TypeError):
                temp = None
        else:
            try:
                ambient = float(new_state)
            except (ValueError, TypeError):
                ambient = None

        # Get the other value from cache
        if is_probe and probe.get("ambient_entity"):
            ambient = get_state_float(probe["ambient_entity"])
        if is_ambient and probe.get("probe_entity"):
            temp = get_state_float(probe["probe_entity"])

        # Insert reading
        await db.insert_reading(session["id"], session["probe_id"], temp, ambient)

        # Update peak/min on session
        updates = {}
        if temp is not None:
            if session.get("peak_temp") is None or temp > session["peak_temp"]:
                updates["peak_temp"] = temp
            if session.get("min_temp") is None or temp < session["min_temp"]:
                updates["min_temp"] = temp

        # Goal reached check
        goal_just_reached = False
        if temp is not None and not session.get("goal_reached_at"):
            goal = session.get("goal", "at_target_temperature")
            target = session.get("target_temp")
            lower = session.get("lower_threshold")
            upper = session.get("upper_threshold")
            reached = False

            if goal == "at_target_temperature" and target and temp >= target:
                reached = True
            elif goal == "in_temperature_range" and lower and upper and lower <= temp <= upper:
                reached = True
            elif goal == "above_threshold" and upper and temp >= upper:
                reached = True
            elif goal == "below_threshold" and lower and temp <= lower:
                reached = True

            if reached:
                updates["goal_reached_at"] = datetime.now(timezone.utc).isoformat()
                goal_just_reached = True

        if updates:
            await db.update_session(session["id"], updates)
            # Refresh session after update
            session = await db.get_session(session["id"]) or session

        # Schedule auto-end if goal just reached and auto_end enabled
        if goal_just_reached and session.get("auto_end"):
            auto_minutes = session.get("auto_end_minutes", 10)
            await schedule_auto_end(session["id"], session["probe_id"], auto_minutes)

        # Broadcast live reading to connected WebSocket clients
        if broadcast_fn:
            await broadcast_fn({
                "type": "reading",
                "session_id": session["id"],
                "probe_id": session["probe_id"],
                "ts": datetime.now(timezone.utc).isoformat(),
                "temp": temp,
                "ambient": ambient,
                "peak_temp": session.get("peak_temp"),
                "min_temp": session.get("min_temp"),
                "goal_reached_at": session.get("goal_reached_at"),
                "auto_end_scheduled": session["id"] in _auto_end_tasks,
            })


async def run_websocket():
    """Main WebSocket loop — connects to HA, subscribes to state changes."""
    while True:
        try:
            _LOGGER.info("Connecting to HA WebSocket at %s", WS_URL)
            async with websockets.connect(WS_URL, ping_interval=30) as ws:
                # Auth phase
                msg = json.loads(await ws.recv())
                if msg.get("type") != "auth_required":
                    raise Exception(f"Unexpected first message: {msg}")

                await ws.send(json.dumps({"type": "auth", "access_token": SUPERVISOR_TOKEN}))
                msg = json.loads(await ws.recv())
                if msg.get("type") != "auth_ok":
                    raise Exception(f"Auth failed: {msg}")

                _LOGGER.info("HA WebSocket authenticated")

                # Fetch initial states
                states = await get_ha_states()
                for s in states:
                    _state_cache[s["entity_id"]] = s["state"]
                _LOGGER.info("Loaded %d initial HA states", len(states))

                # Subscribe to all state changes
                sub_id = next_id()
                await ws.send(json.dumps({
                    "id": sub_id,
                    "type": "subscribe_events",
                    "event_type": "state_changed",
                }))
                msg = json.loads(await ws.recv())
                if not msg.get("success"):
                    raise Exception(f"Subscribe failed: {msg}")

                _LOGGER.info("Subscribed to HA state changes")

                # Re-schedule any auto-end timers for sessions that were active before restart
                active = await db.get_all_active_sessions()
                for session in active:
                    if session.get("goal_reached_at") and session.get("auto_end"):
                        # Calculate remaining time
                        reached_at = datetime.fromisoformat(session["goal_reached_at"])
                        auto_minutes = session.get("auto_end_minutes", 10)
                        end_at = reached_at + timedelta(minutes=auto_minutes)
                        remaining = (end_at - datetime.now(timezone.utc)).total_seconds()
                        if remaining > 0:
                            await schedule_auto_end(session["id"], session["probe_id"], int(remaining / 60))
                        else:
                            # Should have ended already
                            await db.end_session(session["id"], "auto_end_after_target")

                # Main message loop
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        if msg.get("type") != "event":
                            continue
                        event = msg.get("event", {})
                        if event.get("event_type") != "state_changed":
                            continue
                        data = event.get("data", {})
                        entity_id = data.get("entity_id", "")
                        new_state_obj = data.get("new_state")
                        if not new_state_obj:
                            continue
                        new_state = new_state_obj.get("state", "")
                        attributes = new_state_obj.get("attributes", {})
                        await _handle_state_change(entity_id, new_state, attributes)
                    except Exception as e:
                        _LOGGER.error("Error processing WS message: %s", e)

        except Exception as e:
            _LOGGER.error("WebSocket error: %s — reconnecting in 10s", e)
            await asyncio.sleep(10)
