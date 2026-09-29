#!/bin/bash
# Install macdash as a per-user LaunchAgent (starts at login, restarts on crash).
set -euo pipefail

LABEL="${MACDASH_LABEL:-local.macdash}"
PORT="${MACDASH_PORT:-8765}"
HOST="${MACDASH_HOST:-0.0.0.0}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/macdash.log"
DOMAIN="gui/$(id -u)"

command -v uv >/dev/null || { echo "uv is required: brew install uv"; exit 1; }
command -v macmon >/dev/null || echo "note: macmon not found (brew install macmon) — power/GPU/fan panels will be hidden"

echo "==> Syncing environment"
(cd "$REPO" && uv sync --frozen 2>/dev/null || uv sync)

echo "==> Writing $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$REPO/.venv/bin/macdash</string>
    <string>--host</string>
    <string>$HOST</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MACDASH_LABEL</key>
    <string>$LABEL</string>
  </dict>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

echo "==> (Re)loading $LABEL"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && sleep 1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"

TOKEN="$("$REPO/.venv/bin/macdash" --print-token)"
echo
echo "macdash is running:  http://$(scutil --get LocalHostName 2>/dev/null || hostname -s).local:$PORT"
echo "access token:        $TOKEN   (also in ~/.config/macdash/token)"
echo "logs:                $LOG"
