# macdash

A self-hosted web dashboard for monitoring and controlling a headless Mac: live metrics, processes, launchd services and logs, in one page you can open from any device on the LAN.

Existing tools don't cover this well on macOS. Glances, Netdata and Cockpit either don't run natively, can't see the host from inside Docker (Docker on macOS runs in a VM), or know nothing about launchd. So macdash is a small native Python app.

## Features

| Tab | What you get |
|---|---|
| **Overview** | Live tiles (CPU, memory + memory pressure, SoC temperature, system power, GPU, battery, network, uptime). History charts for CPU/GPU, memory, temperature, power, network and disk I/O (up to 1 h, hover for values). Per-core bars (E/P), top processes, storage, thermals/fans. |
| **Processes** | Sortable, filterable process table. Click a process for its command line, cwd, parent/children, network connections and open files. Send TERM / KILL / HUP / STOP / CONT. |
| **Services** | Every launchd job in `~/Library/LaunchAgents`, `/Library/LaunchAgents` and `/Library/LaunchDaemons` (optionally all Apple agents too), with state, PID and last exit code. Start / stop / restart / load / unload / enable / disable. Recent stdout/stderr, `launchctl print` output, and the plist. **Edit, create and delete user agents** in the browser: plists are validated, the old version is backed up to `~/.config/macdash/plist-backups/`, and the agent can be reloaded in one click. |
| **Logs** | Unified log search (`log show`) by process, subsystem, message text, level and time range, or a raw predicate. **Live streaming** (`log stream`). Log file browser covering `~/Library/Logs`, `/Library/Logs`, `/var/log`, Homebrew logs and every path a launchd plist logs to. Tail + follow + filter. |
| **System** | Machine info, battery health (cycles, capacity vs. design, adapter), network interfaces, listening TCP ports (click through to the process), every temperature sensor, `pmset` settings and sleep assertions. |

Data sources, none of which need root:
- `psutil` for CPU, memory, disks, network and processes.
- IOKit's `IOHIDEventSystem` (via ctypes) for temperature sensors.
- [`macmon`](https://github.com/vladkens/macmon) (optional) for system power, GPU usage, cluster frequencies and fans.
- `ioreg` for battery details.
- `launchctl`, `log`, `lsof` and `pmset` for everything else.

## Install

```bash
brew install uv macmon          # macmon is optional
git clone <this repo> ~/Developer/macdash
~/Developer/macdash/scripts/install.sh
```

This installs a LaunchAgent (`local.macdash`) that starts at login and restarts if it crashes. It listens on `0.0.0.0:8765`, so it's reachable at **http://<hostname>.local:8765** (mDNS) from the LAN. The script prints the access token; you can also read it any time:

```bash
cat ~/.config/macdash/token        # or: ~/Developer/macdash/.venv/bin/macdash --print-token
```

To update after pulling changes, re-run `scripts/install.sh`. To remove macdash, run `scripts/uninstall.sh`.

For development: `uv run macdash --port 8799`.

## Configuration

Set these as environment variables, either in the plist's `EnvironmentVariables` or as `MACDASH_*=… scripts/install.sh` for host/port.

| Variable | Default | |
|---|---|---|
| `MACDASH_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to allow SSH-tunnel access only. |
| `MACDASH_PORT` | `8765` | |
| `MACDASH_TOKEN` | generated | Overrides the token stored in `~/.config/macdash/token`. |
| `MACDASH_SAMPLE_INTERVAL` | `2` | Seconds between metric samples. |
| `MACDASH_HISTORY_LEN` | `1800` | Samples kept in memory (1 h at 2 s). |

## Security notes

- Every `/api/*` route needs the token, sent either as the `macdash_token` cookie (set by the login page, `SameSite=Strict`, HttpOnly) or as `Authorization: Bearer <token>`.
- Traffic is plain HTTP. That's fine on a trusted LAN. For anything wider, put it behind Tailscale or a TLS reverse proxy, or bind to `127.0.0.1` and use an SSH tunnel.
- The dashboard runs as your user, so it can control that user's processes and LaunchAgents. System daemons (`/Library/LaunchDaemons`) are read-only unless passwordless `sudo` is configured.
- There is deliberately no "run arbitrary command" feature. File viewing is limited to log directories and paths that launchd plists log to.
- `local.macdash` and `local.claude-rc` are marked *protected*: stopping or unloading them asks for confirmation, and they can't be deleted from the UI.

## Known quirks

- On some macOS builds, macmon's per-component power (CPU/GPU/ANE) reads 0 and its temperature values are wrong. macdash therefore reads temperatures from IOKit itself, and shows component power only when it's non-zero. System power, which comes from the SMC, is reliable.
- History is kept in memory only and resets when the service restarts.
