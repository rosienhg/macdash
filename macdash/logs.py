"""Log access: macOS unified log (`log show` / `log stream`) and plain log files."""

import asyncio
import collections
import json
import os
from pathlib import Path

from . import config, launchd

LOG = "/usr/bin/log"
LEVELS = ("default", "info", "debug")
MAX_ENTRIES = 5000

FILE_ROOTS = [
    config.HOME / "Library" / "Logs",
    Path("/Library/Logs"),
    Path("/var/log"),
    Path("/opt/homebrew/var/log"),
]


def _quote(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_predicate(process: str = "", subsystem: str = "", text: str = "", errors_only: bool = False,
                    raw: str = "") -> str | None:
    parts = []
    if process:
        parts.append(f"process == {_quote(process)}" if process.isascii() and " " not in process
                     else f"process CONTAINS[c] {_quote(process)}")
    if subsystem:
        parts.append(f"subsystem BEGINSWITH {_quote(subsystem)}")
    if text:
        parts.append(f"eventMessage CONTAINS[c] {_quote(text)}")
    if errors_only:
        parts.append("(messageType == error OR messageType == fault)")
    if raw:
        parts.append(f"({raw})")
    return " AND ".join(parts) or None


def _entry(line: str) -> dict | None:
    try:
        e = json.loads(line)
    except ValueError:
        return None
    if not isinstance(e, dict) or "eventMessage" not in e:
        return None
    return {
        "time": e.get("timestamp", "")[:23],
        "level": e.get("messageType", ""),
        "process": (e.get("processImagePath") or "").rsplit("/", 1)[-1],
        "pid": e.get("processID"),
        "subsystem": e.get("subsystem", ""),
        "category": e.get("category", ""),
        "message": e.get("eventMessage", ""),
    }


def _base_args(level: str) -> list[str]:
    args = ["--style", "ndjson"]
    if level == "info":
        args.append("--info")
    elif level == "debug":
        args += ["--info", "--debug"]
    return args


async def show(minutes: float, predicate: str | None, level: str = "default", limit: int = 1000) -> dict:
    """Return the most recent `limit` entries from the last `minutes`."""
    limit = min(max(limit, 1), MAX_ENTRIES)
    args = [LOG, "show", "--last", f"{int(max(6, min(minutes * 60, 86400)))}s", *_base_args(level)]
    if predicate:
        args += ["--predicate", predicate]
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    entries: collections.deque = collections.deque(maxlen=limit)
    total = 0
    timed_out = False

    async def consume():
        nonlocal total
        assert proc.stdout
        async for line in proc.stdout:
            e = _entry(line)
            if e:
                entries.append(e)
                total += 1

    try:
        await asyncio.wait_for(consume(), timeout=60)
    except asyncio.TimeoutError:
        timed_out = True
        proc.kill()
    await proc.wait()
    err = (await proc.stderr.read()).decode(errors="replace").strip() if proc.stderr else ""
    if proc.returncode not in (0, None) and not entries and not timed_out:
        raise ValueError(err or "log show failed")
    return {"entries": list(entries), "matched": total, "truncated": total > len(entries), "timed_out": timed_out}


async def stream(predicate: str | None, level: str = "default"):
    """Async generator yielding entries from `log stream` until cancelled."""
    args = [LOG, "stream", *_base_args(level)]
    if predicate:
        args += ["--predicate", predicate]
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        assert proc.stdout
        async for line in proc.stdout:
            e = _entry(line)
            if e:
                yield e
            elif line.strip() and not line.startswith(b"Filtering"):
                yield {"time": "", "level": "error", "process": "log", "message": line.decode(errors="replace").strip()}
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


# ------------------------------------------------------------------ log files

def _allowed_paths() -> set[str]:
    """Log paths declared by launchd plists are always allowed."""
    paths = set()
    for s in launchd.list_services():
        for key in ("stdout", "stderr"):
            if s.get(key):
                paths.add(os.path.realpath(s[key]))
    return paths


def is_allowed(path: str) -> bool:
    real = os.path.realpath(path)
    if any(real == str(r) or real.startswith(os.path.realpath(r) + os.sep) for r in FILE_ROOTS):
        return True
    return real in _allowed_paths()


def list_files() -> list[dict]:
    files = {}

    def add(p: Path, source: str):
        try:
            st = p.stat()
        except OSError:
            return
        if not p.is_file() or not os.access(p, os.R_OK):
            return
        key = os.path.realpath(p)
        if key not in files:
            files[key] = {"path": str(p), "size": st.st_size, "mtime": st.st_mtime, "source": source}

    for s in launchd.list_services():
        for key in ("stdout", "stderr"):
            if s.get(key):
                add(Path(s[key]), f"launchd: {s['label']}")
    for root in FILE_ROOTS:
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            depth = Path(dirpath).relative_to(root).parts
            if len(depth) >= 2:
                dirnames[:] = []
            for fn in filenames:
                if fn.startswith(".") or fn == "StoreData" or fn.endswith((".gz", ".bz2", ".zip", ".asl")):
                    continue
                add(Path(dirpath) / fn, str(root))
    return sorted(files.values(), key=lambda f: -f["mtime"])


def tail(path: str, lines: int = 500) -> dict:
    if not is_allowed(path):
        raise PermissionError("path not in an allowed log location")
    lines = min(max(lines, 1), 20000)
    size = os.path.getsize(path)
    chunk = 64 * 1024
    data = b""
    with open(path, "rb") as f:
        pos = size
        while pos > 0 and data.count(b"\n") <= lines:
            step = min(chunk, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data
            if len(data) > 32 * 1024 * 1024:
                break
    text = data.decode(errors="replace").splitlines()[-lines:]
    return {"path": path, "size": size, "lines": text}


async def follow(path: str, start: int):
    """Yield new text appended to a file from byte offset `start` onward."""
    if not is_allowed(path):
        raise PermissionError("path not in an allowed log location")
    pos = start
    buf = b""
    while True:
        try:
            size = os.path.getsize(path)
        except OSError:
            await asyncio.sleep(1)
            continue
        if size < pos:  # truncated / rotated
            pos = 0
            yield {"rotated": True}
        if size > pos:
            with open(path, "rb") as f:
                f.seek(pos)
                data = f.read(min(size - pos, 1024 * 1024))
            pos += len(data)
            buf += data
            *complete, buf = buf.split(b"\n")
            if complete:
                yield {"lines": [c.decode(errors="replace") for c in complete]}
        else:
            await asyncio.sleep(1)
