"""Grilling Improved — FastAPI main application."""
import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

import database as db
import ha_client
from routers import probes, cooks, history, analytics

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
_LOGGER = logging.getLogger(__name__)

# ── WebSocket connection manager ──────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, data: Any):
        msg = json.dumps(data, default=str)
        dead = []
        for ws in self.active:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


async def broadcast(data: dict):
    await manager.broadcast(data)


# ── HA entities endpoint ──────────────────────────────────────────────────────

# ── App lifespan ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await db.init_db()
    ha_client.broadcast_fn = broadcast
    asyncio.create_task(ha_client.run_websocket())
    _LOGGER.info("Grilling Improved started")
    yield
    # Shutdown
    _LOGGER.info("Grilling Improved shutting down")


app = FastAPI(title="Grilling Improved", lifespan=lifespan)

# ── Routes ────────────────────────────────────────────────────────────────────

app.include_router(probes.router)
app.include_router(cooks.router)
app.include_router(history.router)
app.include_router(analytics.router)


@app.get("/api/ha/entities")
async def ha_entities(domain: str = ""):
    """Return HA entities, optionally filtered by domain."""
    entities = await ha_client.get_ha_entities()
    if domain:
        domains = [d.strip() for d in domain.split(",")]
        entities = [e for e in entities if e["domain"] in domains]
    return entities


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            # Keep connection alive; client sends pings
            data = await ws.receive_text()
            msg = json.loads(data)
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        manager.disconnect(ws)


# ── Static files / SPA ───────────────────────────────────────────────────────

FRONTEND = os.path.join(os.path.dirname(__file__), "frontend")
INDEX = os.path.join(FRONTEND, "index.html")


@app.get("/")
async def serve_root():
    return FileResponse(INDEX)


@app.get("/index.html")
async def serve_index():
    return FileResponse(INDEX)
