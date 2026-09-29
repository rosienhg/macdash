"""launchd services: discovery, status, control and plist editing.

Scopes:
  user    ~/Library/LaunchAgents   -> domain gui/<uid>   (full control)
  agent   /Library/LaunchAgents    -> domain gui/<uid>   (control; plist is root-owned)
  daemon  /Library/LaunchDaemons   -> domain system      (read-only unless passwordless sudo)
  apple   anything else loaded in gui/<uid> (e.g. com.apple.*), shown on request
"""

import os
import plistlib
import re
import shutil
import time
from pathlib import Path

from . import config
from .util import run

UID = os.getuid()
GUI = f"gui/{UID}"
USER_DIR = config.HOME / "Library" / "LaunchAgents"
DIRS = {
    "user": USER_DIR,
    "agent": Path("/Library/LaunchAgents"),
    "daemon": Path("/Library/LaunchDaemons"),
}
LAUNCHCTL = "/bin/launchctl"
LABEL_RE = re.compile(r"^[A-Za-z0-9._-]+$")
PROTECTED = {config.SELF_LABEL, "local.claude-rc"}


class LaunchdError(Exception):
    pass


def _domain(scope: str) -> str:
    return "system" if scope == "daemon" else GUI


def _gui_list() -> dict[str, dict]:
    """Parse `launchctl list` for the gui domain: label -> {pid, status}."""
    res = {}
    text = run([LAUNCHCTL, "list"]).stdout
    for line in text.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        pid, status, label = parts
        res[label] = {"pid": int(pid) if pid != "-" else None, "last_exit": int(status) if status.lstrip("-").isdigit() else status}
    return res


def _print_state(target: str) -> dict:
    """Minimal parse of `launchctl print` for state/pid/last exit/runs."""
    r = run([LAUNCHCTL, "print", target])
    if r.returncode != 0:
        return {"loaded": False}
    info = {"loaded": True}
    for line in r.stdout.splitlines()[:80]:
        line = line.strip()
        for key, name in (("state = ", "state"), ("pid = ", "pid"), ("last exit code = ", "last_exit"), ("runs = ", "runs")):
            if line.startswith(key) and name not in info:
                val = line[len(key):]
                info[name] = int(val) if val.lstrip("-").isdigit() else val
    return info


def _read_plist(path: Path) -> dict:
    try:
        with open(path, "rb") as f:
            return plistlib.load(f)
    except Exception as e:
        return {"__error__": str(e)}


def _summary(path: Path, scope: str, data: dict) -> dict:
    label = data.get("Label") or path.stem
    args = data.get("ProgramArguments") or ([data["Program"]] if data.get("Program") else [])
    return {
        "label": label,
        "scope": scope,
        "path": str(path),
        "program": " ".join(args),
        "run_at_load": bool(data.get("RunAtLoad")),
        "keep_alive": bool(data.get("KeepAlive")),
        "disabled_key": bool(data.get("Disabled")),
        "interval": data.get("StartInterval"),
        "calendar": bool(data.get("StartCalendarInterval")),
        "stdout": data.get("StandardOutPath"),
        "stderr": data.get("StandardErrorPath"),
        "error": data.get("__error__"),
        "protected": label in PROTECTED,
        "editable": scope == "user",
    }


def list_services(include_apple: bool = False) -> list[dict]:
    gui = _gui_list()
    services, seen = [], set()
    for scope, d in DIRS.items():
        if not d.is_dir():
            continue
        for path in sorted(d.glob("*.plist")):
            s = _summary(path, scope, _read_plist(path))
            seen.add(s["label"])
            if scope == "daemon":
                st = _print_state(f"system/{s['label']}")
                s.update(loaded=st["loaded"], pid=st.get("pid"), last_exit=st.get("last_exit"), state=st.get("state"))
            else:
                g = gui.get(s["label"])
                s.update(loaded=g is not None, pid=g and g["pid"], last_exit=g and g["last_exit"],
                         state=("running" if g and g["pid"] else "loaded" if g else "unloaded"))
            services.append(s)
    if include_apple:
        for label, g in sorted(gui.items()):
            if label in seen:
                continue
            services.append({
                "label": label, "scope": "apple", "path": None, "program": "", "loaded": True,
                "pid": g["pid"], "last_exit": g["last_exit"],
                "state": "running" if g["pid"] else "loaded", "editable": False, "protected": False,
            })
    return services


def _find(label: str) -> tuple[str, Path | None]:
    if not LABEL_RE.match(label):
        raise LaunchdError("invalid label")
    for scope, d in DIRS.items():
        p = d / f"{label}.plist"
        if p.exists():
            return scope, p
        # Some plists aren't named after their label.
        for path in d.glob("*.plist") if d.is_dir() else []:
            if _read_plist(path).get("Label") == label:
                return scope, path
    return "apple", None


def details(label: str) -> dict:
    scope, path = _find(label)
    target = f"{_domain(scope)}/{label}"
    r = run([LAUNCHCTL, "print", target])
    data = _read_plist(path) if path else {}
    return {
        "label": label,
        "scope": scope,
        "path": str(path) if path else None,
        "summary": _summary(path, scope, data) if path else None,
        "plist_xml": path.read_text(errors="replace") if path else None,
        "print": r.stdout if r.returncode == 0 else r.stderr or r.stdout,
        "loaded": r.returncode == 0,
    }


def _launchctl(args: list[str], sudo: bool = False) -> str:
    cmd = (["/usr/bin/sudo", "-n"] if sudo else []) + [LAUNCHCTL, *args]
    r = run(cmd, timeout=30)
    output = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        raise LaunchdError(output or f"launchctl {' '.join(args)} failed ({r.returncode})")
    return output


ACTIONS = ("start", "stop", "restart", "load", "unload", "enable", "disable")


def action(label: str, act: str, sudo_ok: bool) -> str:
    if act not in ACTIONS:
        raise LaunchdError(f"unknown action {act}")
    scope, path = _find(label)
    sudo = scope == "daemon"
    if sudo and not sudo_ok:
        raise LaunchdError("system daemons need root; configure passwordless sudo for launchctl to control them")
    domain = _domain(scope)
    target = f"{domain}/{label}"
    if act == "start":
        return _launchctl(["kickstart", target], sudo)
    if act == "restart":
        return _launchctl(["kickstart", "-k", target], sudo)
    if act == "stop":
        # With KeepAlive launchd would immediately respawn, so SIGTERM is only
        # a real "stop" for non-KeepAlive jobs; use unload for the others.
        return _launchctl(["kill", "SIGTERM", target], sudo)
    if act == "load":
        if not path:
            raise LaunchdError("no plist found for this label")
        return _launchctl(["bootstrap", domain, str(path)], sudo)
    if act == "unload":
        return _launchctl(["bootout", target], sudo)
    if act == "enable":
        return _launchctl(["enable", target], sudo)
    if act == "disable":
        return _launchctl(["disable", target], sudo)
    raise AssertionError


def save_plist(label: str, xml: str, reload: bool) -> dict:
    """Validate and write a user agent plist (backing up the previous version)."""
    if not LABEL_RE.match(label):
        raise LaunchdError("invalid label")
    try:
        data = plistlib.loads(xml.encode())
    except Exception as e:
        raise LaunchdError(f"invalid plist: {e}")
    if not isinstance(data, dict) or data.get("Label") != label:
        raise LaunchdError("plist Label must match the service label")
    if not (data.get("Program") or data.get("ProgramArguments")):
        raise LaunchdError("plist needs Program or ProgramArguments")
    scope, existing = _find(label)
    if existing and scope != "user":
        raise LaunchdError("only ~/Library/LaunchAgents plists can be edited")
    path = existing or USER_DIR / f"{label}.plist"
    USER_DIR.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup_dir = config.CONFIG_DIR / "plist-backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup_dir / f"{path.name}.{time.strftime('%Y%m%d-%H%M%S')}")
    path.write_text(xml)
    lint = run(["/usr/bin/plutil", "-lint", str(path)], timeout=5)
    msg = lint.stdout.strip()
    if reload:
        try:
            _launchctl(["bootout", f"{GUI}/{label}"])
            # bootout is async; give launchd a moment before re-bootstrapping.
            time.sleep(1)
        except LaunchdError:
            pass
        _launchctl(["bootstrap", GUI, str(path)])
        msg += "\nreloaded"
    return {"path": str(path), "message": msg}


TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/path/to/program</string>
  </array>

  <key>WorkingDirectory</key>
  <string>{home}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>{home}/Library/Logs/{label}.log</string>
  <key>StandardErrorPath</key>
  <string>{home}/Library/Logs/{label}.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
"""


def template(label: str) -> str:
    if not LABEL_RE.match(label):
        raise LaunchdError("invalid label")
    return TEMPLATE.format(label=label, home=config.HOME)


def delete_plist(label: str) -> str:
    scope, path = _find(label)
    if scope != "user" or not path:
        raise LaunchdError("only ~/Library/LaunchAgents plists can be deleted")
    if label in PROTECTED:
        raise LaunchdError("refusing to delete a protected service")
    try:
        _launchctl(["bootout", f"{GUI}/{label}"])
    except LaunchdError:
        pass
    backup_dir = config.CONFIG_DIR / "plist-backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), backup_dir / f"{path.name}.deleted-{time.strftime('%Y%m%d-%H%M%S')}")
    return f"unloaded and moved to {backup_dir}"
