"""Background reader for `macmon pipe` (Apple Silicon power / GPU / frequency / fans).

macmon is optional: if it isn't installed, `latest()` returns None and the
dashboard simply hides those panels.
"""

import asyncio
import json
import logging
import os
import shutil

log = logging.getLogger(__name__)

_latest: dict | None = None
_task: asyncio.Task | None = None
_proc: asyncio.subprocess.Process | None = None


def binary() -> str | None:
    return shutil.which("macmon") or next(
        (p for p in ("/opt/homebrew/bin/macmon", "/usr/local/bin/macmon") if os.path.exists(p)), None
    )


def latest() -> dict | None:
    return _latest


def _summarise(d: dict) -> dict:
    def cores(key):
        return [{"freq": c.get("freq_mhz"), "active": c.get("active_ratio")} for c in d.get(key, [])]

    return {
        "power": {
            "cpu": d.get("cpu_power"),
            "gpu": d.get("gpu_power"),
            "ane": d.get("ane_power"),
            "ram": d.get("ram_power"),
            "gpu_ram": d.get("gpu_ram_power"),
            "package": d.get("all_power"),
            "system": d.get("sys_power"),
        },
        "gpu": {"freq": d.get("gpu_freq_mhz"), "usage": d.get("gpu_active_ratio")},
        "ecpu": {"freq": d.get("ecpu_freq_mhz"), "usage": d.get("ecpu_active_ratio"), "cores": cores("ecpu_cores")},
        "pcpu": {"freq": d.get("pcpu_freq_mhz"), "usage": d.get("pcpu_active_ratio"), "cores": cores("pcpu_cores")},
        "fans": d.get("fans", []),
    }


async def _run(interval_ms: int):
    global _latest, _proc
    exe = binary()
    if not exe:
        log.info("macmon not found; power/GPU metrics disabled")
        return
    while True:
        proc = _proc = await asyncio.create_subprocess_exec(
            exe, "pipe", "-i", str(interval_ms),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            assert proc.stdout
            first = True
            async for line in proc.stdout:
                if first:  # the first sample covers an arbitrary window and is often garbage
                    first = False
                    continue
                try:
                    _latest = _summarise(json.loads(line))
                except ValueError:
                    continue
        except asyncio.CancelledError:
            proc.terminate()
            raise
        await proc.wait()
        log.warning("macmon exited (%s); restarting in 10s", proc.returncode)
        _latest = None
        await asyncio.sleep(10)


def start(interval_ms: int = 2000):
    global _task
    if _task is None:
        _task = asyncio.create_task(_run(interval_ms))


async def stop():
    global _task
    if _proc and _proc.returncode is None:
        _proc.terminate()
    if _task:
        _task.cancel()
        _task = None
