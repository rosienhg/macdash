import asyncio
import contextlib
import hmac
import json
import os
from pathlib import Path

import psutil
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, launchd, logs, macmon, metrics, processes

STATIC = Path(__file__).parent / "static"
COOKIE = "macdash_token"


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    metrics.start()
    macmon.start(int(config.SAMPLE_INTERVAL * 1000))
    yield
    await macmon.stop()


app = FastAPI(title="macdash", lifespan=lifespan, docs_url=None, redoc_url=None)


def _authed(request: Request) -> bool:
    supplied = request.cookies.get(COOKIE) or ""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        supplied = auth[7:]
    return hmac.compare_digest(supplied.encode(), config.TOKEN.encode())


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path != "/api/login" and not _authed(request):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


def _err(e: Exception, code: int = 400):
    raise HTTPException(code, str(e))


# ---------------------------------------------------------------- auth

class Login(BaseModel):
    token: str


@app.post("/api/login")
def login(body: Login, response: Response):
    if not hmac.compare_digest(body.token.encode(), config.TOKEN.encode()):
        raise HTTPException(401, "invalid token")
    response.set_cookie(COOKIE, body.token, httponly=True, samesite="strict", max_age=60 * 60 * 24 * 90)
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


# ---------------------------------------------------------------- metrics

@app.get("/api/stats")
def stats():
    cur = metrics.current()
    if not cur:
        raise HTTPException(503, "warming up")
    return cur


@app.get("/api/history")
def history(since: float = 0):
    return {"interval": config.SAMPLE_INTERVAL, "points": [p for p in metrics.history() if p["t"] > since]}


@app.get("/api/system")
async def system():
    info, disks, bat = await asyncio.gather(
        asyncio.to_thread(metrics.system_info),
        asyncio.to_thread(metrics.disks),
        asyncio.to_thread(metrics.battery),
    )
    return {"info": info, "disks": disks, "battery": bat, "sudo": await asyncio.to_thread(metrics.sudo_available)}


@app.get("/api/battery")
async def battery():
    return await asyncio.to_thread(metrics.battery)


@app.get("/api/network")
async def network():
    return await asyncio.to_thread(metrics.network)


@app.get("/api/power")
async def power():
    return await asyncio.to_thread(metrics.power_info)


# ---------------------------------------------------------------- processes

@app.get("/api/processes")
async def list_processes():
    return await asyncio.to_thread(processes.list_processes)


@app.get("/api/processes/{pid}")
async def process_details(pid: int):
    try:
        return await asyncio.to_thread(processes.details, pid)
    except psutil.NoSuchProcess:
        raise HTTPException(404, "no such process")


class Signal(BaseModel):
    signal: str = "TERM"


@app.post("/api/processes/{pid}/signal")
def process_signal(pid: int, body: Signal):
    try:
        processes.send_signal(pid, body.signal)
    except psutil.NoSuchProcess:
        raise HTTPException(404, "no such process")
    except psutil.AccessDenied:
        raise HTTPException(403, "permission denied (process owned by another user?)")
    except ValueError as e:
        _err(e)
    return {"ok": True}


# ---------------------------------------------------------------- launchd

@app.get("/api/services")
async def services(apple: bool = False):
    return await asyncio.to_thread(launchd.list_services, apple)


@app.get("/api/services/{label}")
async def service(label: str):
    try:
        return await asyncio.to_thread(launchd.details, label)
    except launchd.LaunchdError as e:
        _err(e)


class ServiceAction(BaseModel):
    action: str


@app.post("/api/services/{label}/action")
async def service_action(label: str, body: ServiceAction):
    if label == config.SELF_LABEL and body.action in ("restart", "stop", "unload"):
        # Respond first, then act, so the browser gets an answer.
        async def later():
            await asyncio.sleep(0.5)
            await asyncio.to_thread(launchd.action, label, body.action, False)
        asyncio.create_task(later())
        return {"ok": True, "output": "dashboard is going away; reload in a few seconds"}
    try:
        sudo_ok = await asyncio.to_thread(metrics.sudo_available)
        out = await asyncio.to_thread(launchd.action, label, body.action, sudo_ok)
    except launchd.LaunchdError as e:
        _err(e)
    return {"ok": True, "output": out}


class PlistBody(BaseModel):
    xml: str
    reload: bool = False


@app.put("/api/services/{label}/plist")
async def service_save(label: str, body: PlistBody):
    try:
        return await asyncio.to_thread(launchd.save_plist, label, body.xml, body.reload)
    except launchd.LaunchdError as e:
        _err(e)


@app.delete("/api/services/{label}")
async def service_delete(label: str):
    try:
        return {"output": await asyncio.to_thread(launchd.delete_plist, label)}
    except launchd.LaunchdError as e:
        _err(e)


@app.get("/api/services-template/{label}")
def service_template(label: str):
    try:
        return {"xml": launchd.template(label)}
    except launchd.LaunchdError as e:
        _err(e)


# ---------------------------------------------------------------- logs

def _predicate(process: str, subsystem: str, text: str, errors: bool, raw: str):
    return logs.build_predicate(process, subsystem, text, errors, raw)


@app.get("/api/logs")
async def log_show(minutes: float = 5, process: str = "", subsystem: str = "", text: str = "",
                   errors: bool = False, raw: str = "", level: str = "default", limit: int = 1000):
    try:
        return await logs.show(minutes, _predicate(process, subsystem, text, errors, raw), level, limit)
    except ValueError as e:
        _err(e)


def _sse(gen):
    async def body():
        yield ": connected\n\n"
        async for item in gen:
            yield f"data: {json.dumps(item)}\n\n"

    return StreamingResponse(body(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/logs/stream")
async def log_stream(process: str = "", subsystem: str = "", text: str = "", errors: bool = False,
                     raw: str = "", level: str = "default"):
    return _sse(logs.stream(_predicate(process, subsystem, text, errors, raw), level))


@app.get("/api/files")
async def log_files():
    return await asyncio.to_thread(logs.list_files)


@app.get("/api/files/tail")
async def file_tail(path: str, lines: int = 500):
    try:
        return await asyncio.to_thread(logs.tail, path, lines)
    except PermissionError as e:
        _err(e, 403)
    except OSError as e:
        _err(e, 404)


@app.get("/api/files/follow")
async def file_follow(path: str, start: int):
    if not await asyncio.to_thread(logs.is_allowed, path):
        raise HTTPException(403, "path not in an allowed log location")
    return _sse(logs.follow(path, start))


# ---------------------------------------------------------------- static

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
