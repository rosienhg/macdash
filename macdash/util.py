import asyncio
import subprocess


def run(cmd: list[str], timeout: float = 15, check: bool = False) -> subprocess.CompletedProcess:
    """Run a command (never via a shell) and capture text output."""
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=check, errors="replace")


async def arun(cmd: list[str], timeout: float = 15) -> subprocess.CompletedProcess:
    """Run a blocking command in a worker thread so the event loop stays free."""
    return await asyncio.to_thread(run, cmd, timeout)


def out(cmd: list[str], timeout: float = 15) -> str:
    try:
        return run(cmd, timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""
