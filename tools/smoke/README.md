# Smoke test

Drives the packaged app over Electron's remote-debugging port (CDP) and asserts the
flows that have actually broken before: engine switching, Live Captions capture,
selection, guards and session save/delete.

    # 1. launch the app with the debugger open (clear ELECTRON_RUN_AS_NODE -- the
    #    launcher .cmd does this too, some shells export it and the exe then runs as node)
    "Caption assistance-1.0.2-local\Caption assistance.exe" --remote-debugging-port=9222

    # 2. run the suite
    python tools/smoke/smoke.py

Exit code is non-zero if any check fails. `cdp.py` is a dependency-free CDP client
(raw WebSocket over a socket), so no npm/pip install is needed.

Step 5 speaks through the system audio device and expects Windows Live Captions to
transcribe it, so run it on a machine with audio output enabled.
