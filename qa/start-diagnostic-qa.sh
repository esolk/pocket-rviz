#!/usr/bin/env bash
# Local desktop QA using synthetic data and software rendering.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PY="${PYTHON:-python3}"
BROWSER="${CHROMIUM:-chromium}"
command -v "$PY" >/dev/null
command -v "$BROWSER" >/dev/null
mkdir -p artifacts
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/pocket-rviz-qa.XXXXXX")"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait || true
  rm -rf "$PROFILE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$PY" serve_android_csp.py > artifacts/v011-csp-server.log 2>&1 & pids+=("$!")
"$PY" diagnostic_bridge.py > artifacts/v011-bridge-server.log 2>&1 & pids+=("$!")
"$PY" viewport_server.py > artifacts/v011-viewport-server.log 2>&1 & pids+=("$!")
"$BROWSER" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=1100,800 'http://127.0.0.1:4174/?w=800&h=360' > artifacts/v011-software-browser.log 2>&1 & pids+=("$!")
wait -n
