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
import os
import sys
import urllib.request

TIMEOUT_SECONDS = 10


def main():
    session_id = os.environ.get("HELM_SESSION_ID")
    if not session_id:
        # Not a Helm-spawned CLI session. Do nothing, touch nothing.
        return

    url = os.environ.get("HELM_HOOK_URL")
    token = os.environ.get("HELM_MCP_TOKEN")
    if not url or not token:
        return

    cli = sys.argv[1] if len(sys.argv) > 1 else ""
    event = sys.argv[2] if len(sys.argv) > 2 else ""

    payload = json.loads(sys.stdin.read())
    if not isinstance(payload, dict):
        return

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


try:
    main()
except Exception:
    # Swallow everything: a hook must never brick the CLI session it serves.
    pass

sys.exit(0)
