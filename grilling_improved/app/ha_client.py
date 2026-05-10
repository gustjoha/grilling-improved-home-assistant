"""
Home Assistant WebSocket client + cooking intelligence engine.
- Real-time state streaming via WebSocket
- Rate of Rise calculation (linear regression)
- Stall detection and resolution
- Milestone checking with HA event firing
- Auto-end timer management
- Optional MQTT publishing
- Weather snapshot on session start
"""
import asyncio
import json
import logging
import os
from collections import deque
from datetime import datetime, timezone, timedelta
from typing import Any, Callable, Optional

import aiohttp
import websockets

import database as db

_LOGGER = logging.getLogger(__name__)


# ── Config (lazy) ─────────────────────────────────────────────────────────────

def _ha_url() -> str:
    return os.environ.get("HA_URL", "http://supervisor/core")

def _token() -> str:
    token = os.environ.get("SUPERVISOR_TOKEN", "")
    if not token:
        _LOGGER.error("SUPERVISOR_TOKEN is empty!")
    return token

def _ws_url() -> str:
    return _ha_url().replace("http://", "ws://").replace("https://", "wss://") + "/api/websocket"

def _mqtt_enabled() -> bool:
    return os.environ.get("MQTT_ENABLED", "").lower() in ("1", "true", "yes")

def _mqtt_host() -> str:
    return os.environ.get("MQTT_HOST", "core-mosquitto")

def _mqtt_port() -> int:
    return int(os.environ.get("MQTT_PORT", "1883"))

def _mqtt_topic_prefix() -> str:
    return os.environ.get("MQTT_TOPIC_PREFIX", "grilling_improved")


# ── In-memory state ────────────────────────────────────────────────────────────

_state_cache: dict[str, Any] = {}
_listeners: dict[str, list[Callable]] = {}
_msg_id = 0
_auto_end_tasks: dict[str, asyncio.Task] = {}
_rest_tasks: dict[str, asyncio.Task] = {}
_ror_history: dict[str, deque] = {}

ROR_WINDOW = 20
STALL_THRESHOLD = 0.15
STALL_MIN_READINGS = 12

_stall_readings: dict[str, int] = {}
_stall_active: dict[str, bool] = {}

broadcast_fn: Optional[Callable] = None


# ── Helpers ────────────────────────────────────────────────────────────────────

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


# ── HA REST API ────────────────────────────────────────────────────────────────

async def call_service(domain: str, service: str, data: dict) -> bool:
    url = f"{_ha_url()}/api/services/{domain}/{service}"
    headers = {"Authorization": f"Bearer {_token()}"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=data, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=5)) as r:
                return r.status in (200, 201)
    except Exception as e:
        _LOGGER.error("Service call failed %s.%s: %s", domain, service, e)
        return False


async def fire_ha_event(event_type: str, event_data: dict) -> bool:
    url = f"{_ha_url()}/api/events/{event_type}"
    headers = {"Authorization": f"Bearer {_token()}"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=event_data, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=5)) as r:
                return r.status == 200
    except Exception as e:
        _LOGGER.error("Event fire failed %s: %s", event_type, e)
        return False


async def get_ha_states() -> list[dict]:
    url = f"{_ha_url()}/api/states"
    headers = {"Authorization": f"Bearer {_token()}"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status == 200:
                    return await r.json()
                _LOGGER.error("get_ha_states HTTP %s", r.status)
    except Exception as e:
        _LOGGER.error("Failed to fetch HA states: %s", e)
    return []


async def get_ha_entities() -> list[dict]:
    states = await get_ha_states()
    return [
        {
            "entity_id": s["entity_id"],
            "friendly_name": s["attributes"].get("friendly_name", s["entity_id"]),
            "state": s["state"],
            "domain": s["entity_id"].split(".")[0],
            "unit": s["attributes"].get("unit_of_measurement", ""),
        }
        for s in states
    ]


async def get_weather_snapshot(entity_id: str) -> dict:
    url = f"{_ha_url()}/api/states/{entity_id}"
    headers = {"Authorization": f"Bearer {_token()}"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status == 200:
                    data = await r.json()
                    attrs = data.get("attributes", {})
                    return {
                        "weather_condition": data.get("state"),
                        "weather_temp": attrs.get("temperature"),
                        "weather_humidity": attrs.get("humidity"),
                    }
    except Exception as e:
        _LOGGER.error("Weather fetch failed %s: %s", entity_id, e)
    return {}


# ── Rate of Rise ───────────────────────────────────────────────────────────────

def _calculate_ror(session_id: str, ts: datetime, temp: float) -> Optional[float]:
    if session_id not in _ror_history:
        _ror_history[session_id] = deque(maxlen=ROR_WINDOW)
    _ror_history[session_id].append((ts, temp))
    history = list(_ror_history[session_id])
    if len(history) < 5:
        return None
    base = history[0][0]
    xs = [(t - base).total_seconds() / 60.0 for t, _ in history]
    ys = [t for _, t in history]
    n = len(xs)
    x_mean = sum(xs) / n
    y_mean = sum(ys) / n
    num = sum((xs[i] - x_mean) * (ys[i] - y_mean) for i in range(n))
    den = sum((xs[i] - x_mean) ** 2 for i in range(n))
    return round(num / den, 3) if den != 0 else 0.0


# ── Stall detection ────────────────────────────────────────────────────────────

async def _check_stall(session_id: str, ror: Optional[float], temp: Optional[float],
                       session: dict, probe_id: str):
    if ror is None or temp is None:
        return
    is_stalling = abs(ror) < STALL_THRESHOLD
    if is_stalling:
        _stall_readings[session_id] = _stall_readings.get(session_id, 0) + 1
    else:
        _stall_readings[session_id] = 0

    stall_was_active = _stall_active.get(session_id, False)

    if not stall_was_active and _stall_readings.get(session_id, 0) >= STALL_MIN_READINGS:
        _stall_active[session_id] = True
        now = datetime.now(timezone.utc).isoformat()
        await db.update_session(session_id, {"stall_started_at": now, "stall_temp": temp})
        _LOGGER.info("Stall detected session=%s temp=%.1f", session_id, temp)
        await fire_ha_event("grilling_improved_stall_started", {
            "session_id": session_id, "probe_id": probe_id,
            "session_name": session.get("name"), "temp": temp,
        })
        if broadcast_fn:
            await broadcast_fn({"type": "stall_started", "session_id": session_id, "temp": temp})

    elif stall_was_active and _stall_readings.get(session_id, 0) == 0:
        _stall_active[session_id] = False
        now = datetime.now(timezone.utc).isoformat()
        await db.update_session(session_id, {"stall_ended_at": now})
        _LOGGER.info("Stall ended session=%s", session_id)
        await fire_ha_event("grilling_improved_stall_ended", {
            "session_id": session_id, "probe_id": probe_id,
            "session_name": session.get("name"), "temp": temp,
        })
        if broadcast_fn:
            await broadcast_fn({"type": "stall_ended", "session_id": session_id, "temp": temp})


# ── Milestone checking ─────────────────────────────────────────────────────────

async def _check_milestones(session_id: str, temp: Optional[float], probe_id: str, session: dict):
    if temp is None:
        return
    for milestone in await db.get_unreached_milestones(session_id):
        if temp >= milestone["temp"]:
            await db.mark_milestone_reached(milestone["id"])
            label = milestone.get("label") or f"{milestone['temp']}°C"
            await fire_ha_event("grilling_improved_milestone_reached", {
                "session_id": session_id, "probe_id": probe_id,
                "session_name": session.get("name"),
                "milestone_temp": milestone["temp"],
                "milestone_label": label, "current_temp": temp,
            })
            if broadcast_fn:
                await broadcast_fn({
                    "type": "milestone_reached", "session_id": session_id,
                    "milestone_id": milestone["id"], "label": label,
                    "temp": milestone["temp"],
                })


# ── MQTT ──────────────────────────────────────────────────────────────────────

async def _publish_mqtt(probe_id: str, session_id: str, temp: Optional[float],
                        ambient: Optional[float], ror: Optional[float]):
    if not _mqtt_enabled():
        return
    try:
        import asyncio_mqtt as aiomqtt
        prefix = _mqtt_topic_prefix()
        payload = json.dumps({
            "probe_id": probe_id, "session_id": session_id,
            "temp": temp, "ambient": ambient, "ror": ror,
            "ts": datetime.now(timezone.utc).isoformat(),
        })
        async with aiomqtt.Client(_mqtt_host(), port=_mqtt_port()) as client:
            await client.publish(f"{prefix}/{probe_id}/reading", payload)
    except ImportError:
        pass
    except Exception as e:
        _LOGGER.debug("MQTT publish error: %s", e)


# ── Auto-end & rest timer ──────────────────────────────────────────────────────

async def schedule_auto_end(session_id: str, probe_id: str, minutes: int):
    if session_id in _auto_end_tasks:
        _auto_end_tasks[session_id].cancel()

    async def _do_end():
        await asyncio.sleep(minutes * 60)
        session = await db.get_session(session_id)
        if session and not session.get("ended_at"):
            probe = await db.get_probe(probe_id)
            ambient = get_state_float(probe["ambient_entity"]) if probe and probe.get("ambient_entity") else None
            await db.end_session(session_id, "auto_end_after_target", ambient)
            await fire_ha_event("grilling_improved_cook_ended", {
                "session_id": session_id, "probe_id": probe_id,
                "session_name": session.get("name"), "reason": "auto_end_after_target",
            })
            if broadcast_fn:
                await broadcast_fn({"type": "session_ended", "session_id": session_id,
                                    "reason": "auto_end_after_target"})
        _auto_end_tasks.pop(session_id, None)

    _auto_end_tasks[session_id] = asyncio.create_task(_do_end())


def cancel_auto_end(session_id: str):
    task = _auto_end_tasks.pop(session_id, None)
    if task:
        task.cancel()


async def schedule_rest_timer(session_id: str, probe_id: str, minutes: int):
    if session_id in _rest_tasks:
        _rest_tasks[session_id].cancel()

    async def _do_rest():
        await asyncio.sleep(minutes * 60)
        now = datetime.now(timezone.utc).isoformat()
        await db.update_session(session_id, {"rest_ended_at": now})
        session = await db.get_session(session_id)
        await fire_ha_event("grilling_improved_rest_complete", {
            "session_id": session_id, "probe_id": probe_id,
            "session_name": session.get("name") if session else "",
        })
        if broadcast_fn:
            await broadcast_fn({"type": "rest_complete", "session_id": session_id})
        _rest_tasks.pop(session_id, None)

    now = datetime.now(timezone.utc).isoformat()
    await db.update_session(session_id, {"rest_started_at": now, "rest_minutes": minutes})
    _rest_tasks[session_id] = asyncio.create_task(_do_rest())


def cancel_rest_timer(session_id: str):
    task = _rest_tasks.pop(session_id, None)
    if task:
        task.cancel()


# ── Core state change handler ──────────────────────────────────────────────────

async def _handle_state_change(entity_id: str, new_state: str, attributes: dict):
    _state_cache[entity_id] = new_state
    for k, v in attributes.items():
        _state_cache[f"{entity_id}::{k}"] = v

    for cb in _listeners.get(entity_id, []):
        try:
            await cb(entity_id, new_state, attributes)
        except Exception as e:
            _LOGGER.error("Listener error %s: %s", entity_id, e)

    for session in await db.get_all_active_sessions():
        probe = await db.get_probe(session["probe_id"])
        if not probe:
            continue

        is_probe = probe.get("probe_entity") == entity_id
        is_ambient = probe.get("ambient_entity") == entity_id
        if not is_probe and not is_ambient:
            continue

        temp: Optional[float] = None
        ambient: Optional[float] = None

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

        if is_probe and probe.get("ambient_entity"):
            ambient = get_state_float(probe["ambient_entity"])
        if is_ambient and probe.get("probe_entity"):
            temp = get_state_float(probe["probe_entity"])

        ror: Optional[float] = None
        if temp is not None and is_probe:
            ror = _calculate_ror(session["id"], datetime.now(timezone.utc), temp)

        await db.insert_reading(session["id"], session["probe_id"], temp, ambient, ror)

        updates: dict = {}
        if temp is not None:
            if session.get("peak_temp") is None or temp > session["peak_temp"]:
                updates["peak_temp"] = temp
            if session.get("min_temp") is None or temp < session["min_temp"]:
                updates["min_temp"] = temp

        goal_just_reached = False
        if temp is not None and not session.get("goal_reached_at"):
            goal = session.get("goal", "at_target_temperature")
            target = session.get("target_temp")
            lower = session.get("lower_threshold")
            upper = session.get("upper_threshold")
            reached = (
                (goal == "at_target_temperature" and target and temp >= target) or
                (goal == "in_temperature_range" and lower and upper and lower <= temp <= upper) or
                (goal == "above_threshold" and upper and temp >= upper) or
                (goal == "below_threshold" and lower and temp <= lower)
            )
            if reached:
                updates["goal_reached_at"] = datetime.now(timezone.utc).isoformat()
                goal_just_reached = True
                await fire_ha_event("grilling_improved_goal_reached", {
                    "session_id": session["id"], "probe_id": session["probe_id"],
                    "session_name": session.get("name"), "temp": temp, "target": target,
                })

        if updates:
            await db.update_session(session["id"], updates)
            session = await db.get_session(session["id"]) or session

        if goal_just_reached and session.get("auto_end"):
            await schedule_auto_end(session["id"], session["probe_id"],
                                    session.get("auto_end_minutes", 10))

        if is_probe:
            await _check_stall(session["id"], ror, temp, session, session["probe_id"])
            await _check_milestones(session["id"], temp, session["probe_id"], session)

        await _publish_mqtt(session["probe_id"], session["id"], temp, ambient, ror)

        if broadcast_fn:
            await broadcast_fn({
                "type": "reading",
                "session_id": session["id"],
                "probe_id": session["probe_id"],
                "ts": datetime.now(timezone.utc).isoformat(),
                "temp": temp, "ambient": ambient, "ror": ror,
                "peak_temp": session.get("peak_temp"),
                "min_temp": session.get("min_temp"),
                "goal_reached_at": session.get("goal_reached_at"),
                "stall_active": _stall_active.get(session["id"], False),
                "auto_end_scheduled": session["id"] in _auto_end_tasks,
            })


# ── WebSocket main loop ────────────────────────────────────────────────────────

async def run_websocket():
    while True:
        try:
            ws_url = _ws_url()
            token = _token()
            _LOGGER.info("Connecting to HA WebSocket at %s (token: %s)",
                         ws_url, "present" if token else "MISSING")

            async with websockets.connect(ws_url, ping_interval=30) as ws:
                msg = json.loads(await ws.recv())
                if msg.get("type") != "auth_required":
                    raise Exception(f"Unexpected: {msg}")

                await ws.send(json.dumps({"type": "auth", "access_token": token}))
                msg = json.loads(await ws.recv())
                if msg.get("type") != "auth_ok":
                    raise Exception(f"Auth failed: {msg}")

                _LOGGER.info("HA WebSocket authenticated")

                states = await get_ha_states()
                for s in states:
                    _state_cache[s["entity_id"]] = s["state"]
                    for k, v in s.get("attributes", {}).items():
                        _state_cache[f"{s['entity_id']}::{k}"] = v
                _LOGGER.info("Loaded %d initial HA states", len(states))

                sub_id = next_id()
                await ws.send(json.dumps({
                    "id": sub_id, "type": "subscribe_events",
                    "event_type": "state_changed",
                }))
                msg = json.loads(await ws.recv())
                if not msg.get("success"):
                    raise Exception(f"Subscribe failed: {msg}")
                _LOGGER.info("Subscribed to HA state changes")

                # Resume timers after restart
                for session in await db.get_all_active_sessions():
                    if session.get("goal_reached_at") and session.get("auto_end"):
                        reached_at = datetime.fromisoformat(session["goal_reached_at"])
                        end_at = reached_at + timedelta(minutes=session.get("auto_end_minutes", 10))
                        remaining = (end_at - datetime.now(timezone.utc)).total_seconds()
                        if remaining > 0:
                            await schedule_auto_end(session["id"], session["probe_id"],
                                                    int(remaining / 60) + 1)
                        else:
                            await db.end_session(session["id"], "auto_end_after_target")

                    if session.get("rest_started_at") and not session.get("rest_ended_at"):
                        started = datetime.fromisoformat(session["rest_started_at"])
                        done_at = started + timedelta(minutes=session.get("rest_minutes", 0))
                        remaining = (done_at - datetime.now(timezone.utc)).total_seconds()
                        if remaining > 0:
                            await schedule_rest_timer(session["id"], session["probe_id"],
                                                      int(remaining / 60) + 1)

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
                        await _handle_state_change(
                            entity_id,
                            new_state_obj.get("state", ""),
                            new_state_obj.get("attributes", {}),
                        )
                    except Exception as e:
                        _LOGGER.error("WS message error: %s", e)

        except Exception as e:
            _LOGGER.error("WebSocket error: %s — reconnecting in 10s", e)
            await asyncio.sleep(10)
