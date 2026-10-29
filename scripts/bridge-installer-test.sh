#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/android/build/installer-tests"
mkdir -p "$OUT"
if command -v javac >/dev/null; then JAVAC=(javac); else JAVAC=(java com.sun.tools.javac.Main); fi
"${JAVAC[@]}" -encoding UTF-8 -d "$OUT" \
 "$ROOT/android/app/src/main/java/dev/dot/rosviewer/InstallerPolicy.java" \
 "$ROOT/android/app/src/main/java/dev/dot/rosviewer/BridgePackagePlan.java" \
 "$ROOT/android/app/src/main/java/dev/dot/rosviewer/BridgeDownloader.java" \
 "$ROOT/android/tests/InstallerPolicyTest.java" \
 "$ROOT/android/tests/BridgePackagePlanTest.java"
java -cp "$OUT" dev.dot.rosviewer.InstallerPolicyTest
java -cp "$OUT" dev.dot.rosviewer.BridgePackagePlanTest
bash -n "$ROOT/android/app/src/main/assets/bridge-installer.sh"
cd "$ROOT"
python3 -m unittest qa/test_bridge_installer.py qa/test_bridge_handshake.py -v
