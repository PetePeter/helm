"""Helm CLI hook shim — the ONE transport all three CLIs share.

Installed system-wide (user-level config) once per CLI by Helm's CLI
Integrations pane. Every hook Helm registered invokes it as:

    <python> helm-hook-shim.py <cli> <event>

It does exactly one thing: forward the hook JSON from stdin to Helm's local
/hooks endpoint using the session credentials Helm injected into the PTY
environment, and print Helm's reply on stdout.

FAIL OPEN IS MANDATORY. On ANY failure — no session id, Helm not running,
connection refused, timeout, malformed stdin — print nothing and exit 0.
For command hooks exit code 2 DENIES on supported events, so this script must
never exit 2 by accident; an unhandled traceback exits 1, but everything is
caught explicitly anyway.

If HELM_SESSION_ID is absent the shim does nothing at all: user-level hook
config is machine-wide and fires for CLI sessions Helm did not spawn, and
those must be untouched.

Stdlib only (urllib). No pip installs, ever.
"""

import json
import math
import os
import subprocess
import sys
import urllib.request

TIMEOUT_SECONDS = 10
STATUSLINE_TIMEOUT_SECONDS = 1
STATUSLINE_CONFIG = "helm-claude-statusline.json"


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def compact_tokens(value):
    count = int(round(value))
    if count >= 1000000:
        millions = f"{count / 1000000:.1f}".rstrip("0").rstrip(".")
        return millions + "m"
    if count >= 1000:
        return str(int(round(count / 1000))) + "k"
    return str(count)


def statusline_badge(payload):
    context = payload.get("context_window")
    if not isinstance(context, dict):
        return None
    if "current_usage" in context and context.get("current_usage") is None:
        return None

    total_input = context.get("total_input_tokens")
    total_output = context.get("total_output_tokens")
    if number(total_input):
        input_tokens = max(0, total_input)
        tokens = input_tokens + (max(0, total_output) if number(total_output) else 0)
    else:
        current = context.get("current_usage")
        if not isinstance(current, dict):
            return None
        input_tokens = sum(
            max(0, current.get(key, 0)) if number(current.get(key, 0)) else 0
            for key in (
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            )
        )
        output_tokens = max(0, current.get("output_tokens", 0)) if number(current.get("output_tokens", 0)) else 0
        tokens = input_tokens + output_tokens

    window = context.get("context_window_size")
    if not number(window) or window <= 0 or tokens <= 0:
        return None

    used_percentage = context.get("used_percentage")
    percent = used_percentage if number(used_percentage) and used_percentage >= 0 else input_tokens / window * 100
    return f"CTX {int(round(percent))}% {compact_tokens(tokens)}/{compact_tokens(window)}"


def append_statusline_badge(output, badge):
    trailing_newlines = output[len(output.rstrip("\r\n")):]
    content = output[:-len(trailing_newlines)] if trailing_newlines else output
    separator = " | " if content else ""
    return content + separator + badge + trailing_newlines


def run_original_statusline(raw, payload, helm_session):
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), STATUSLINE_CONFIG)
    try:
        with open(config_path, "r", encoding="utf-8") as config_file:
            original = json.load(config_file).get("command")
    except Exception:
        original = None

    if isinstance(original, str) and original:
        result = subprocess.run(
            original,
            shell=True,
            input=raw,
            text=True,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
        )
        output = result.stdout
        if result.returncode == 0 and helm_session:
            badge = statusline_badge(payload)
            if badge:
                output = append_statusline_badge(output, badge)
        sys.stdout.write(output)
        sys.stderr.write(result.stderr)
        return result.returncode

    badge = statusline_badge(payload) if helm_session else None
    if badge:
        sys.stdout.write(badge + "\n")
    return 0


def post_statusline_usage(payload):
    session_id = os.environ.get("HELM_SESSION_ID")
    url = os.environ.get("HELM_CONTEXT_USAGE_URL")
    token = os.environ.get("HELM_MCP_TOKEN")
    if not session_id or not url or not token:
        return

    context = payload.get("context_window")
    if not isinstance(context, dict):
        return
    body = json.dumps({
        "session_id": payload.get("session_id"),
        "context_window": context,
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=STATUSLINE_TIMEOUT_SECONDS):
            pass
    except Exception:
        # Usage reporting is optional; never suppress the user's status line.
        pass


def run_statusline():
    raw = sys.stdin.read()
    payload = None
    try:
        payload = json.loads(raw)
        if isinstance(payload, dict):
            post_statusline_usage(payload)
        else:
            payload = None
    except Exception:
        payload = None
    return run_original_statusline(raw, payload or {}, bool(os.environ.get("HELM_SESSION_ID")))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "statusline":
        return run_statusline()

    session_id = os.environ.get("HELM_SESSION_ID")
    if not session_id:
        # Not a Helm-spawned CLI session. Do nothing, touch nothing.
        return 0

    url = os.environ.get("HELM_HOOK_URL")
    token = os.environ.get("HELM_MCP_TOKEN")
    if not url or not token:
        return 0

    cli = sys.argv[1] if len(sys.argv) > 1 else ""
    event = sys.argv[2] if len(sys.argv) > 2 else ""

    payload = json.loads(sys.stdin.read())
    if not isinstance(payload, dict):
        return 0

    body = json.dumps({"cli": cli, "event": event, "payload": payload}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
            "x-helm-session-id": session_id,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        reply = response.read().decode("utf-8")
    if reply.strip():
        sys.stdout.write(reply)
    return 0


try:
    exit_code = main()
except Exception:
    # Swallow everything: a hook must never brick the CLI session it serves.
    exit_code = 0

sys.exit(exit_code)
