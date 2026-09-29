"""Process listing, inspection and signalling."""

import os
import signal
import time

import psutil

ATTRS = ["pid", "ppid", "name", "username", "cpu_percent", "memory_info", "status", "create_time", "num_threads"]
SIGNALS = {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL, "HUP": signal.SIGHUP,
           "INT": signal.SIGINT, "STOP": signal.SIGSTOP, "CONT": signal.SIGCONT}


def list_processes() -> list[dict]:
    # process_iter caches Process objects between calls, so cpu_percent is the
    # usage since the previous listing (the first call returns 0 for everything).
    rows = []
    for p in psutil.process_iter(ATTRS, ad_value=None):
        i = p.info
        mem = i.get("memory_info")
        rows.append({
            "pid": i["pid"],
            "ppid": i.get("ppid"),
            "name": i.get("name") or "?",
            "user": i.get("username"),
            "cpu": round(i.get("cpu_percent") or 0, 1),
            "rss": mem.rss if mem else None,
            "status": i.get("status"),
            "started": i.get("create_time"),
            "threads": i.get("num_threads"),
        })
    return rows


def details(pid: int) -> dict:
    p = psutil.Process(pid)

    def safe(fn, default=None):
        try:
            return fn()
        except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
            return default

    with p.oneshot():
        info = {
            "pid": pid,
            "name": safe(p.name),
            "exe": safe(p.exe),
            "cmdline": safe(p.cmdline, []),
            "cwd": safe(p.cwd),
            "user": safe(p.username),
            "status": safe(p.status),
            "ppid": safe(p.ppid),
            "started": safe(p.create_time),
            "uptime": time.time() - (safe(p.create_time) or time.time()),
            "threads": safe(p.num_threads),
            "fds": safe(p.num_fds),
            "memory": safe(lambda: p.memory_info()._asdict()),
            "cpu_times": safe(lambda: p.cpu_times()._asdict()),
            "nice": safe(p.nice),
        }
    parent = safe(p.parent)
    info["parent_name"] = safe(parent.name) if parent else None
    info["children"] = [
        {"pid": c.pid, "name": safe(c.name)} for c in safe(lambda: p.children(recursive=False), [])
    ]
    info["connections"] = [
        {
            "type": "tcp" if c.type == 1 else "udp",
            "laddr": f"{c.laddr.ip}:{c.laddr.port}" if c.laddr else "",
            "raddr": f"{c.raddr.ip}:{c.raddr.port}" if c.raddr else "",
            "status": c.status,
        }
        for c in safe(lambda: p.net_connections(kind="inet"), [])
    ]
    info["open_files"] = [f.path for f in safe(p.open_files, [])][:200]
    return info


def send_signal(pid: int, sig: str) -> None:
    if sig not in SIGNALS:
        raise ValueError(f"unsupported signal {sig}")
    if pid <= 1:
        raise ValueError("refusing to signal launchd / kernel")
    if pid == os.getpid():
        raise ValueError("refusing to signal the dashboard itself (use the Services tab to restart it)")
    psutil.Process(pid).send_signal(SIGNALS[sig])
