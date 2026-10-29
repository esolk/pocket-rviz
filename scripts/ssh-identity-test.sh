#!/usr/bin/env bash
# Local ephemeral fixture keys only. No SSH server or real account is contacted.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v javac >/dev/null; then JAVAC=(javac); else JAVAC=(java com.sun.tools.javac.Main); fi
command -v ssh-keygen >/dev/null
CP="$ROOT/.toolchains/deps/jsch-0.2.26-android.jar:$ROOT/.toolchains/deps/bcprov-1.80-android.jar"
[[ -f "$ROOT/.toolchains/deps/jsch-0.2.26-android.jar" ]] || { echo 'Run scripts/android-ssh-dependency.sh first.' >&2;exit 1; }
OUT="$ROOT/android/build/installer-tests";mkdir -p "$OUT"
TEMP="$(mktemp -d)";trap 'rm -rf "$TEMP"' EXIT
ssh-keygen -q -t ed25519 -N fixture-only-passphrase -f "$TEMP/ed25519"
ssh-keygen -q -t rsa -b 3072 -N fixture-only-passphrase -f "$TEMP/rsa"
ssh-keygen -q -t ecdsa -b 256 -N fixture-only-passphrase -f "$TEMP/ecdsa"
"${JAVAC[@]}" -classpath "$CP" -d "$OUT" "$ROOT/android/tests/SshIdentityTest.java"
java -cp "$OUT:$CP" dev.dot.rosviewer.SshIdentityTest "$TEMP/ed25519" "$TEMP/rsa" "$TEMP/ecdsa"
