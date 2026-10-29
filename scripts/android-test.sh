#!/usr/bin/env bash
# Pure-JVM URL/error classification and JS bridge contract tests; no network requests.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/android/build/unit-tests"
mkdir -p "$OUT"
if command -v javac >/dev/null; then JAVAC=(javac); else JAVAC=(java com.sun.tools.javac.Main); fi
"${JAVAC[@]}" -encoding UTF-8 -d "$OUT" \
  "$ROOT/android/app/src/main/java/dev/dot/rosviewer/DiagnosticEndpoint.java" \
  "$ROOT/android/app/src/main/java/dev/dot/rosviewer/NetworkDiagnostics.java" \
  "$ROOT/android/tests/DiagnosticUnitTest.java"
java -cp "$OUT" dev.dot.rosviewer.DiagnosticUnitTest
node "$ROOT/android/tests/bridge-test.cjs"
"${JAVAC[@]}" -encoding UTF-8 -d "$OUT" \
  "$ROOT/android/app/src/main/java/dev/dot/rosviewer/InstallerPolicy.java" \
  "$ROOT/android/tests/InstallerPolicyTest.java"
java -cp "$OUT" dev.dot.rosviewer.InstallerPolicyTest
