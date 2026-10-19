# pocket-rviz

A lightweight, read-only ROS1 viewer for Android phones and tablets, with a Three.js web renderer and an offline synthetic demo.

[中文说明](README.zh-CN.md) · [Android build guide](android/README.md) · [ROS1 bridge setup](docs/ROS1_BRIDGE_SETUP.zh-CN.md)

## Features

- PointCloud2, LaserScan, TF/static TF, OccupancyGrid, Path, Odometry/PoseStamped, common Marker shapes, supported Image encodings, and JPEG/PNG CompressedImage
- Foxglove WebSocket connection stages, bounded diagnostic logs, and user-triggered Android DNS/TCP/Ping checks
- Searchable topic selection with per-server saved choices; new visual streams stay off until selected (TF is enabled by default)
- Per-layer point-cloud color modes, point size, opacity, and bounded point budgets; color/opacity controls for other common layers
- Touch-friendly landscape UI and offline synthetic demo
- Read-only subscriptions; no robot-control publishing

This is an early prototype, not an Android port of desktop RViz. It does not support RViz C++ plugins, URDF RobotModel, InteractiveMarker, or bag-file playback. See [feature limits](web/README.md).

## Quick start

Requires Node.js 22.12+ (tested with Node.js 24), npm, and a WebGL 2 browser.

```sh
cd web
npm ci
npm test
npm run build
npm run dev
```

For Android, follow the [build guide](android/README.md). Android 7.0/API 24 is the minimum, but a WebGL 2-capable GPU and modern Android System WebView are also required. The build uses JDK 17/21, Android SDK 35, and build-tools 35.0.0 without Gradle.

## Connect to ROS1

Run a secured ROS1 Foxglove bridge and enter its ws:// or wss:// address in the app. Port 8765 is the usual default; rosbridge JSON on port 9090 is not supported. The initial address ws://192.0.2.1:8765 is a documentation placeholder and must be replaced. No connection starts automatically.

Use plain WS only on a trusted isolated network. Prefer valid TLS and appropriate bridge access restrictions elsewhere. Do not expose a robot bridge or ROS master directly to the public Internet.

See [display settings guide](docs/DISPLAY_SETTINGS_0.2.0.zh-CN.md) for controls, fallback behavior, and storage limits.

## Validation and build artifacts

See the [source validation record](docs/VALIDATION.zh-CN.md) and [device acceptance checklist](docs/ACCEPTANCE.zh-CN.md). Synthetic tests do not establish physical Android or real-robot compatibility.

This repository publishes source, tests, and documentation only. SDKs, dependencies, debug logs, signing keys, and prebuilt APKs are excluded. Build an APK locally; a different signing key may require uninstalling an older installation and clearing its saved preferences.

## License

A project-level license has not yet been selected. Public visibility alone is not a grant to reuse, modify, or redistribute the project. Third-party dependencies retain their own licenses and copyright notices in [THIRD_PARTY_NOTICES.txt](web/public/THIRD_PARTY_NOTICES.txt).
