#!/bin/bash
set -euo pipefail
LABEL="${MACDASH_LABEL:-local.macdash}"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL (config and token kept in ~/.config/macdash)"
