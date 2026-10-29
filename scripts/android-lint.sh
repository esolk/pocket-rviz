#!/usr/bin/env bash
# Targeted API-compatibility and permission lint for this Gradle-free app.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$ROOT/.toolchains/android-sdk}}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$ROOT/.toolchains/android-user}"
mkdir -p "$ANDROID_USER_HOME" "$ROOT/android/build"
LINT="$SDK/cmdline-tools/latest/bin/lint"
[[ -x "$LINT" ]] || { echo "Android command-line tools are required for lint; run android-setup.sh." >&2; exit 1; }
[[ -d "$ROOT/android/build/classes" ]] || { echo "Run scripts/android-build.sh before lint." >&2; exit 1; }
"$LINT" --exitcode --sdk-home "$SDK" --compile-sdk-version 35 \
  --sources "$ROOT/android/app/src/main/java" --resources "$ROOT/android/app/src/main/res" \
  --classpath "$ROOT/android/build/classes:$ROOT/.toolchains/deps/jsch-0.2.26-android.jar:$ROOT/.toolchains/deps/bcprov-1.80-android.jar" \
  --check NewApi,InlinedApi,MissingPermission \
  --text "$ROOT/android/build/android-api-lint.txt" "$ROOT/android/app/src/main"
cat "$ROOT/android/build/android-api-lint.txt"
