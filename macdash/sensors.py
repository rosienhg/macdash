"""Temperature sensors via the IOHIDEventSystem private API (no sudo needed).

This is the same source tools like Stats/iStat use on Apple Silicon. Sensors are
exposed as HID services on usage page 0xff00 / usage 5; each reports a
temperature event (type 15).
"""

import ctypes
import re
import threading
from ctypes import POINTER, c_bool, c_char_p, c_double, c_int32, c_int64, c_long, c_uint32, c_void_p

_UTF8 = 0x08000100
_TEMP_EVENT = 15

_lock = threading.Lock()
_client = None
_cf = None
_iokit = None


def _load():
    global _client, _cf, _iokit
    if _client is not None:
        return
    cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    io = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/IOKit.framework/IOKit")

    cf.CFStringCreateWithCString.restype = c_void_p
    cf.CFStringCreateWithCString.argtypes = [c_void_p, c_char_p, c_uint32]
    cf.CFNumberCreate.restype = c_void_p
    cf.CFNumberCreate.argtypes = [c_void_p, c_long, c_void_p]
    cf.CFDictionaryCreate.restype = c_void_p
    cf.CFDictionaryCreate.argtypes = [c_void_p, POINTER(c_void_p), POINTER(c_void_p), c_long, c_void_p, c_void_p]
    cf.CFArrayGetCount.restype = c_long
    cf.CFArrayGetCount.argtypes = [c_void_p]
    cf.CFArrayGetValueAtIndex.restype = c_void_p
    cf.CFArrayGetValueAtIndex.argtypes = [c_void_p, c_long]
    cf.CFStringGetCString.restype = c_bool
    cf.CFStringGetCString.argtypes = [c_void_p, c_char_p, c_long, c_uint32]
    cf.CFRelease.argtypes = [c_void_p]

    io.IOHIDEventSystemClientCreate.restype = c_void_p
    io.IOHIDEventSystemClientCreate.argtypes = [c_void_p]
    io.IOHIDEventSystemClientSetMatching.argtypes = [c_void_p, c_void_p]
    io.IOHIDEventSystemClientCopyServices.restype = c_void_p
    io.IOHIDEventSystemClientCopyServices.argtypes = [c_void_p]
    io.IOHIDServiceClientCopyProperty.restype = c_void_p
    io.IOHIDServiceClientCopyProperty.argtypes = [c_void_p, c_void_p]
    io.IOHIDServiceClientCopyEvent.restype = c_void_p
    io.IOHIDServiceClientCopyEvent.argtypes = [c_void_p, c_int64, c_int32, c_int64]
    io.IOHIDEventGetFloatValue.restype = c_double
    io.IOHIDEventGetFloatValue.argtypes = [c_void_p, c_int32]

    def cfstr(s):
        return cf.CFStringCreateWithCString(None, s.encode(), _UTF8)

    page, usage = c_int32(0xFF00), c_int32(5)
    keys = (c_void_p * 2)(cfstr("PrimaryUsagePage"), cfstr("PrimaryUsage"))
    vals = (c_void_p * 2)(
        cf.CFNumberCreate(None, 3, ctypes.byref(page)),
        cf.CFNumberCreate(None, 3, ctypes.byref(usage)),
    )
    kcb = c_void_p.in_dll(cf, "kCFTypeDictionaryKeyCallBacks")
    vcb = c_void_p.in_dll(cf, "kCFTypeDictionaryValueCallBacks")
    matching = cf.CFDictionaryCreate(None, keys, vals, 2, ctypes.addressof(kcb), ctypes.addressof(vcb))

    client = io.IOHIDEventSystemClientCreate(None)
    io.IOHIDEventSystemClientSetMatching(client, matching)
    _cf, _iokit, _client = cf, io, client
    _load.product_key = cfstr("Product")


def read_raw() -> list[tuple[str, float]]:
    """Return (sensor name, °C) for every temperature sensor."""
    with _lock:
        _load()
        cf, io = _cf, _iokit
        services = io.IOHIDEventSystemClientCopyServices(_client)
        if not services:
            return []
        out = []
        buf = ctypes.create_string_buffer(256)
        try:
            for i in range(cf.CFArrayGetCount(services)):
                svc = cf.CFArrayGetValueAtIndex(services, i)
                name_ref = io.IOHIDServiceClientCopyProperty(svc, _load.product_key)
                name = "?"
                if name_ref:
                    if cf.CFStringGetCString(name_ref, buf, 256, _UTF8):
                        name = buf.value.decode(errors="replace")
                    cf.CFRelease(name_ref)
                event = io.IOHIDServiceClientCopyEvent(svc, _TEMP_EVENT, 0, 0)
                if event:
                    value = io.IOHIDEventGetFloatValue(event, _TEMP_EVENT << 16)
                    cf.CFRelease(event)
                    if -40 < value < 150:
                        out.append((name, value))
        finally:
            cf.CFRelease(services)
        return out


def _group(name: str) -> str:
    n = name.lower()
    if "tdie" in n or "soc" in n or "cpu" in n or "gpu" in n:
        return "SoC"
    if "battery" in n or "gas gauge" in n:
        return "Battery"
    if "nand" in n or "ssd" in n:
        return "SSD"
    if "pmu" in n:
        return "PMU"
    return "Other"


def read() -> dict:
    """Summarise sensors: per-group avg/max plus the full (deduplicated) list."""
    try:
        raw = read_raw()
    except Exception as e:  # private API; never let it take the sampler down
        return {"error": str(e), "groups": {}, "sensors": []}
    by_name: dict[str, list[float]] = {}
    for name, v in raw:
        by_name.setdefault(name, []).append(v)
    sensors = sorted(
        ({"name": k, "group": _group(k), "value": round(max(v), 1)} for k, v in by_name.items()),
        key=lambda s: (s["group"], s["name"]),
    )
    groups: dict[str, dict] = {}
    for s in sensors:
        if "tcal" in s["name"].lower():  # calibration constant, not a live reading
            continue
        g = groups.setdefault(s["group"], {"values": []})
        g["values"].append(s["value"])
    for g in groups.values():
        vals = g.pop("values")
        g["avg"] = round(sum(vals) / len(vals), 1)
        g["max"] = round(max(vals), 1)
        g["count"] = len(vals)
    return {"groups": groups, "sensors": sensors}
