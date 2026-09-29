"""Runtime configuration, read from environment variables."""

import os
import secrets
from pathlib import Path

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("MACDASH_CONFIG_DIR", HOME / ".config" / "macdash"))

HOST = os.environ.get("MACDASH_HOST", "0.0.0.0")
PORT = int(os.environ.get("MACDASH_PORT", "8765"))

# Sampling interval for the background metrics collector, in seconds.
SAMPLE_INTERVAL = float(os.environ.get("MACDASH_SAMPLE_INTERVAL", "2"))
# How many samples of history to keep in memory (default: 1 hour at 2s).
HISTORY_LEN = int(os.environ.get("MACDASH_HISTORY_LEN", "1800"))

# Label the dashboard's own LaunchAgent is installed under.
SELF_LABEL = os.environ.get("MACDASH_LABEL", "local.macdash")


def load_token() -> str:
    """Return the access token, generating and persisting one on first run."""
    env = os.environ.get("MACDASH_TOKEN")
    if env:
        return env
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    path = CONFIG_DIR / "token"
    if path.exists():
        token = path.read_text().strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    path.write_text(token + "\n")
    path.chmod(0o600)
    return token


TOKEN = load_token()
