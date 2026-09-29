"""Background sampler: collects system metrics on an interval and keeps history."""

import asyncio
import collections
import getpass
import os
import platform
import plistlib
import socket
import time

import psutil

from . import config, macmon, sensors
from .util import out, run

_history: collections.deque = collections.deque(maxlen=config.HISTORY_LEN)
_current: dict = {}
_prev_io: dict = {}
_task: asyncio.Task | None = None

_PRESSURE = {1: "normal", 2: "warning", 4: "critical"}


def _sysctl(name: str) -> str:
    return out(["/usr/sbin/sysctl", "-n", name]).strip()


def battery() -> dict | None:
    raw = out(["/usr/sbin/ioreg", "-rn", "AppleSmartBattery", "-a"])
    if not raw.strip():
        return None
    try:
        items = plistlib.loads(raw.encode())
    except Exception:
        return None
    if not items:
        return None
    b = items[0]
    data = b.get("BatteryData", {})
    design = data.get("DesignCapacity") or b.get("DesignCapacity")
    full = b.get("AppleRawMaxCapacity") or data.get("FullChargeCapacity")
    ps = psutil.sensors_battery()
    time_left = b.get("TimeRemaining") or b.get("AvgTimeToEmpty")
    return {
        "percent": ps.percent if ps else b.get("CurrentCapacity"),
        "plugged": bool(b.get("ExternalConnected")),
        "charging": bool(b.get("IsCharging")),
        "fully_charged": bool(b.get("FullyCharged")),
        "cycles": b.get("CycleCount"),
        "design_capacity": design,
        "max_capacity": full,
        "health": round(100 * full / design, 1) if full and design else None,
        "temperature": round(b["Temperature"] / 100, 1) if b.get("Temperature") else None,
        "voltage": round(b["Voltage"] / 1000, 2) if b.get("Voltage") else None,
        "amperage": b.get("Amperage"),
        "watts": round(b.get("Voltage", 0) * _signed(b.get("Amperage", 0)) / 1e6, 2),
        "time_remaining_min": time_left if time_left and time_left < 65535 else None,
        "adapter_watts": (b.get("AdapterDetails") or {}).get("Watts"),
        "not_charging_reason": (b.get("ChargerData") or {}).get("NotChargingReason"),
    }


def _signed(v: int) -> int:
    # ioreg reports amperage as an unsigned 64-bit value when negative.
    return v - (1 << 64) if v > (1 << 63) else v


def _rate(key: str, now: float, values: dict) -> dict:
    prev = _prev_io.get(key)
    _prev_io[key] = (now, values)
    if not prev:
        return {k: 0.0 for k in values}
    dt = max(now - prev[0], 1e-6)
    return {k: max(0.0, (values[k] - prev[1].get(k, 0)) / dt) for k in values}


def sample() -> dict:
    now = time.time()
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    disk = psutil.disk_io_counters()
    net = psutil.net_io_counters()
    try:
        pressure = _PRESSURE.get(int(_sysctl("kern.memorystatus_vm_pressure_level")), "unknown")
    except ValueError:
        pressure = "unknown"
    per_cpu = psutil.cpu_percent(percpu=True)
    temps = sensors.read()
    mm = macmon.latest()
    s = {
        "t": now,
        "cpu": {
            "percent": round(sum(per_cpu) / len(per_cpu), 1) if per_cpu else 0,
            "per_cpu": per_cpu,
            "load": os.getloadavg(),
            "times": psutil.cpu_times_percent()._asdict(),
        },
        "mem": {
            "total": vm.total,
            "used": vm.total - vm.available,
            "available": vm.available,
            "percent": vm.percent,
            "wired": getattr(vm, "wired", None),
            "active": getattr(vm, "active", None),
            "inactive": getattr(vm, "inactive", None),
            "pressure": pressure,
            "swap_total": sw.total,
            "swap_used": sw.used,
        },
        "disk_io": _rate("disk", now, {"read": disk.read_bytes, "write": disk.write_bytes}) if disk else None,
        "net_io": _rate("net", now, {"rx": net.bytes_recv, "tx": net.bytes_sent}),
        "temps": temps,
        "macmon": mm,
        "procs": len(psutil.pids()),
    }
    return s


def _history_point(s: dict) -> dict:
    groups = s["temps"].get("groups", {})
    mm = s["macmon"] or {}
    return {
        "t": round(s["t"], 1),
        "cpu": s["cpu"]["percent"],
        "mem": s["mem"]["percent"],
        "load": round(s["cpu"]["load"][0], 2),
        "rx": round(s["net_io"]["rx"]),
        "tx": round(s["net_io"]["tx"]),
        "dr": round((s["disk_io"] or {}).get("read", 0)),
        "dw": round((s["disk_io"] or {}).get("write", 0)),
        "temp": groups.get("SoC", {}).get("max"),
        "power": (mm.get("power") or {}).get("system"),
        "gpu": round(100 * ((mm.get("gpu") or {}).get("usage") or 0), 1) if mm else None,
    }


async def _loop():
    global _current
    psutil.cpu_percent(percpu=True)  # prime the counters
    psutil.cpu_times_percent()
    while True:
        try:
            _current = await asyncio.to_thread(sample)
            _history.append(_history_point(_current))
        except Exception:  # keep sampling no matter what
            import logging

            logging.getLogger(__name__).exception("sample failed")
        await asyncio.sleep(config.SAMPLE_INTERVAL)


def start():
    global _task
    if _task is None:
        _task = asyncio.create_task(_loop())


def current() -> dict:
    return _current


def history() -> list:
    return list(_history)


# ---------------------------------------------------------------- static-ish info

def system_info() -> dict:
    boot = psutil.boot_time()
    return {
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "model": _sysctl("hw.model"),
        "chip": _sysctl("machdep.cpu.brand_string"),
        "cores_physical": psutil.cpu_count(logical=False),
        "cores_logical": psutil.cpu_count(),
        "perf_cores": _sysctl("hw.perflevel0.physicalcpu"),
        "eff_cores": _sysctl("hw.perflevel1.physicalcpu"),
        "mem_total": psutil.virtual_memory().total,
        "os": f"macOS {platform.mac_ver()[0]} ({out(['/usr/bin/sw_vers', '-buildVersion']).strip()})",
        "kernel": platform.release(),
        "boot_time": boot,
        "uptime": time.time() - boot,
        "users": [u._asdict() for u in psutil.users()],
        "macmon": bool(macmon.binary()),
    }


def disks() -> list:
    result = []
    seen = set()
    for p in psutil.disk_partitions(all=False):
        if p.mountpoint in seen or p.mountpoint == "/Volumes/Recovery" or p.mountpoint.startswith("/System/Volumes/") and p.mountpoint != "/System/Volumes/Data":
            continue
        seen.add(p.mountpoint)
        try:
            u = psutil.disk_usage(p.mountpoint)
        except OSError:
            continue
        result.append({
            "device": p.device, "mount": p.mountpoint, "fs": p.fstype,
            "total": u.total, "used": u.used, "free": u.free, "percent": u.percent,
        })
    return result


def network() -> dict:
    stats = psutil.net_if_stats()
    ifaces = []
    for name, addrs in psutil.net_if_addrs().items():
        st = stats.get(name)
        ips = [a.address for a in addrs if a.family in (socket.AF_INET, socket.AF_INET6)]
        if not ips or not st:
            continue
        ifaces.append({"name": name, "up": st.isup, "speed": st.speed, "mtu": st.mtu, "addresses": ips})
    return {"interfaces": ifaces, "listening": listening_ports()}


def listening_ports() -> list:
    """TCP listeners visible to this user (via lsof; psutil needs root on macOS)."""
    text = out(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], timeout=10)
    rows, pid, cmd = [], None, None
    seen = set()
    for line in text.splitlines():
        if not line:
            continue
        tag, val = line[0], line[1:]
        if tag == "p":
            pid = int(val)
        elif tag == "c":
            cmd = val
        elif tag == "n":
            key = (pid, val)
            if key not in seen:
                seen.add(key)
                rows.append({"pid": pid, "command": cmd, "address": val})
    return sorted(rows, key=lambda r: r["address"].rsplit(":", 1)[-1].zfill(6))


def power_info() -> dict:
    return {
        "pmset": out(["/usr/bin/pmset", "-g"]),
        "assertions": out(["/usr/bin/pmset", "-g", "assertions"]),
        "therm": out(["/usr/bin/pmset", "-g", "therm"]),
    }


def sudo_available() -> bool:
    try:
        return run(["/usr/bin/sudo", "-n", "true"], timeout=5).returncode == 0
    except Exception:
        return False
