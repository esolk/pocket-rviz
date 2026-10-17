# Independent synthetic integration QA

These fixtures serialize ROS1 bytes directly in Python. They do not import application parsing/rendering code, connect to a robot, or run a real ROS master/bridge. The WebSocket framing uses the documented `foxglove.websocket.v1` handshake and serverInfo/advertise/subscribe/unsubscribe/binary message subset.

Dependencies: Python 3.10+, `websockets`, `Pillow`; manual browser checks additionally require Chromium. Install Python packages with `python -m pip install -r qa/requirements.txt` from the repository root. No test dependency is installed into the web app.

```bash
cd qa
python fixtures.py
python test_fixture_protocol.py
python fake_bridge.py --port 8765
# Connect app to ws://127.0.0.1:8765 and add /qa topics.
```

Fixtures:
- `/tf`: moving map → base_link, 90° yaw at all samples; `/tf_static`: base_link → lidar translation (0.5, 0, 0.25).
- `/qa/points_mixed` and `/qa/points_bigendian`: 2×3 organized cloud, float64 y/float32 x/int16 z/uint16 intensity/uint32 RGB, reordered fields, 24-byte points, 80-byte rows (8 padding bytes), NaN point. Exactly 5 finite points expected.
- `/qa/map`: 16×16 occupancy grid, 0.5 m resolution, free/occupied/unknown cells, translated origin.
- `/qa/path`: 15 stamped poses.
- `/qa/markers`: two objects in namespace SYNTHETIC_QA, followed on demand by DELETE or DELETEALL.
- `/qa/camera/compressed`: locally generated 320×180 JPEG explicitly labeled SYNTHETIC QA / NO ROBOT CAMERA.

`expected.json` contains independently generated expected geometry/counts. `test_fixture_protocol.py` separately walks byte offsets and verifies little- and big-endian point data, padding, envelope offsets, analytic TF composition, image size, marker action fields, and an actual socket subscribe/unsubscribe/disconnect lifecycle.

`fake_bridge.py` writes actual observed socket operations to `artifacts/bridge-state.json`. It accepts no client writes or service/parameter actions. For deterministic edge cases write `{"seq":1,"op":"marker_delete"}` to `artifacts/control.json`, increasing seq for each command. Other operations: marker_add, marker_deleteall, disconnect, unadvertise and advertise (optional channelIds list).

A passed synthetic test does not establish ROS hardware compatibility, Android WebView behavior, latency, thermal limits or tablet FPS. Those require the acceptance checks in `docs/ACCEPTANCE.zh-CN.md`.

## v0.1.1 connection diagnostics regression

```
python qa/test_diagnostic_protocol.py
node qa/test_connection_diagnostics.cjs
bash scripts/android-test.sh
```

`diagnostic_bridge.py` binds only `127.0.0.1:8876`. Paths `/open-no-info`, `/empty-info`, `/info-no-advertise`, `/zero-topics`, `/unsupported`, `/normal`, `/close-1000`, `/close-1008`, and `/close-1011` provide deterministic synthetic states. Close reasons contain deliberately fake redaction canaries. No robot is contacted. Use an unused loopback port for connection-refused checks.

`test_diagnostic_protocol.py` independently verifies the fixture server over real sockets. `test_connection_diagnostics.cjs` bundles the app client into a generated QA artifact, supplies fake transport and deterministic timers, and checks diagnostic stages, redaction, bounded logs, retry, manual stop, and read-only outbound operations. These are distinct kinds of evidence; neither is an Android device test.

`start-diagnostic-qa.sh` launches the strict-CSP server, synthetic diagnostics bridge, fixed-viewport shell, and software-rendered desktop Chromium. Run it from a Linux desktop terminal and stop it with Ctrl+C. It has no DevTools or remote-debugging flags. Manual UI tests use ordinary mouse/keyboard input. Current source validation is recorded in `docs/VALIDATION.zh-CN.md`.
