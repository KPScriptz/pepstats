"""PepStats optional Python micro-backend.

Compliant by design: it ONLY polls Riot's sanctioned Live Client Data API
(127.0.0.1:2999) at 1 Hz and prints JSON snapshots to stdout for the Electron
app to consume. There is intentionally NO screen capture / computer-vision /
enemy-tracking here — that would be a bannable map-hack under Riot's ToS and is
detected by Vanguard.

The Electron app already does this in Node, so this sidecar is optional. It
exists to demonstrate the PyInstaller + electron-builder `extraResources`
packaging path. Build it with: pyinstaller backend/pepstats_backend.spec
"""

import json
import ssl
import sys
import time
import urllib.request

URL = "https://127.0.0.1:2999/liveclientdata/allgamedata"

# Live Client API uses a self-signed cert; accept it for localhost only.
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


def fetch():
    with urllib.request.urlopen(URL, timeout=2, context=_CTX) as resp:
        return json.load(resp)


def main():
    while True:
        try:
            data = fetch()
            game_time = data.get("gameData", {}).get("gameTime", 0)
            sys.stdout.write(json.dumps({"ok": True, "gameTime": game_time}) + "\n")
        except Exception as exc:  # no game running / not reachable
            sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}) + "\n")
        sys.stdout.flush()
        time.sleep(1)


if __name__ == "__main__":
    main()
