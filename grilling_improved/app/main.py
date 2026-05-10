"""Grilling Improved — FastAPI main application."""
import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

import database as db
import ha_client
from routers import probes, cooks, history, analytics

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
_LOGGER = logging.getLogger(__name__)

DATA_DIR  = os.environ.get("DATA_DIR", "/data")
CFG_PATH  = os.path.join(DATA_DIR, "config.json")
FRONTEND  = os.path.join(os.path.dirname(__file__), "frontend")
INDEX     = os.path.join(FRONTEND, "index.html")


# ── Addon config (HA URL + token) ─────────────────────────────────────────────

def load_addon_config() -> dict:
    try:
        with open(CFG_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_addon_config(cfg: dict):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CFG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


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


# ── App lifespan ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    ha_client.broadcast_fn = broadcast
    cfg = load_addon_config()
    if cfg.get("ha_url") and cfg.get("ha_token"):
        ha_client.set_config(cfg["ha_url"], cfg["ha_token"])
        asyncio.create_task(ha_client.run_websocket())
        _LOGGER.info("Grilling Improved started (HA: %s)", cfg["ha_url"])
    else:
        _LOGGER.info("Grilling Improved started — awaiting setup (no HA config yet)")
    yield
    _LOGGER.info("Grilling Improved shutting down")


app = FastAPI(title="Grilling Improved", lifespan=lifespan)

# ── Routes ────────────────────────────────────────────────────────────────────

app.include_router(probes.router)
app.include_router(cooks.router)
app.include_router(history.router)
app.include_router(analytics.router)


class SetupPayload(BaseModel):
    ha_url: str
    ha_token: str


@app.get("/api/setup/status")
async def setup_status():
    cfg = load_addon_config()
    configured = bool(cfg.get("ha_url") and cfg.get("ha_token"))
    return {"configured": configured, "ha_url": cfg.get("ha_url", "")}


@app.post("/api/setup/configure")
async def setup_configure(payload: SetupPayload):
    url = payload.ha_url.rstrip("/")
    token = payload.ha_token.strip()

    # Validate by hitting the HA API
    import aiohttp
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{url}/api/",
                headers={"Authorization": f"Bearer {token}"},
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                if r.status not in (200, 201):
                    return JSONResponse(
                        {"ok": False, "error": f"HA returned HTTP {r.status} — check URL and token"},
                        status_code=400,
                    )
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    cfg = {"ha_url": url, "ha_token": token}
    save_addon_config(cfg)
    ha_client.set_config(url, token)
    asyncio.create_task(ha_client.run_websocket())
    _LOGGER.info("Setup complete — connected to %s", url)
    return {"ok": True}


@app.get("/api/ha/entities")
async def ha_entities(domain: str = ""):
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
            data = await ws.receive_text()
            msg = json.loads(data)
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        manager.disconnect(ws)


# ── Serve frontend ─────────────────────────────────────────────────────────────
# Ingress forwards requests with various path prefixes stripped.
# We serve index.html for ANY path that isn't an API route.
# Using middleware instead of a route catch-all avoids method conflicts.

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from starlette.responses import Response as StarletteResponse

class SPAMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response = await call_next(request)
        if (response.status_code == 404
                and request.method == "GET"
                and not request.url.path.startswith("/api/")
                and not request.url.path.startswith("/ws")):
            return FileResponse(INDEX)
        return response

app.add_middleware(SPAMiddleware)

@app.get("/")
@app.get("/index.html")
async def serve_root():
    return FileResponse(INDEX)

