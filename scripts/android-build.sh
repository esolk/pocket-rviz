#!/usr/bin/env bash
# A reproducible, dependency-free Android build using Google's SDK tools directly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$ROOT/.toolchains/android-sdk}}"
BUILD_TOOLS_VERSION="${ANDROID_BUILD_TOOLS_VERSION:-35.0.0}"
COMPILE_SDK="${ANDROID_COMPILE_SDK:-35}"
BT="$SDK/build-tools/$BUILD_TOOLS_VERSION"
ANDROID_JAR="$SDK/platforms/android-$COMPILE_SDK/android.jar"
OUT="$ROOT/android/build"
WEB_DIST="${WEB_DIST:-$ROOT/web/dist}"
VERSION_NAME="$(python3 - "$ROOT/android/app/src/main/AndroidManifest.xml" <<'PYVERSION'
import sys, xml.etree.ElementTree as ET
print(ET.parse(sys.argv[1]).getroot().attrib['{http://schemas.android.com/apk/res/android}versionName'])
PYVERSION
)"
APK="$OUT/ros-tablet-viewer-$VERSION_NAME-debug.apk"
KEYSTORE="${ANDROID_DEBUG_KEYSTORE:-$ROOT/.local/android-debug.keystore}"

for tool in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner"; do
  if [[ ! -x "$tool" ]]; then
    echo "Missing SDK tool: $tool. See android/README.md for setup." >&2
    exit 1
  fi
done
[[ -f "$ANDROID_JAR" ]] || { echo "Missing Android platform: $ANDROID_JAR" >&2; exit 1; }
[[ -f "$WEB_DIST/index.html" ]] || { echo "Build the web app first: cd web && npm ci && npm run build" >&2; exit 1; }
command -v java >/dev/null
command -v python3 >/dev/null

# Full JDKs have javac; some containers retain its standard module but omit its wrapper.
if command -v javac >/dev/null; then JAVAC=(javac); else JAVAC=(java com.sun.tools.javac.Main); fi
if command -v keytool >/dev/null; then KEYTOOL=(keytool)
elif [[ -x "${JAVA_HOME:-/usr/lib/jvm/default-java}/bin/keytool" ]]; then
  KEYTOOL=("${JAVA_HOME:-/usr/lib/jvm/default-java}/bin/keytool")
else echo "A JDK with keytool is required." >&2; exit 1; fi

mkdir -p "$OUT"
# Only generated build output is replaced. Never modify web sources or signing keys.
rm -rf "$OUT/classes" "$OUT/dex" "$OUT/generated" "$OUT/assets"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/generated" "$OUT/assets/web"
cp -R "$WEB_DIST/." "$OUT/assets/web/"
if [[ -d "$ROOT/android/app/src/main/assets" ]]; then
  cp -R "$ROOT/android/app/src/main/assets/." "$OUT/assets/"
fi

"$BT/aapt2" compile --dir "$ROOT/android/app/src/main/res" -o "$OUT/resources.zip"
"$BT/aapt2" link -o "$OUT/resources.ap_" -I "$ANDROID_JAR" \
  --manifest "$ROOT/android/app/src/main/AndroidManifest.xml" \
  --java "$OUT/generated" --min-sdk-version 24 --target-sdk-version 35 \
  -A "$OUT/assets" "$OUT/resources.zip"
find "$ROOT/android/app/src/main/java" "$OUT/generated" -name '*.java' | sort > "$OUT/sources.list"
"${JAVAC[@]}" -encoding UTF-8 -source 8 -target 8 -bootclasspath "$ANDROID_JAR" \
  -d "$OUT/classes" @"$OUT/sources.list"
mapfile -t CLASSES < <(find "$OUT/classes" -name '*.class' | sort)
"$BT/d8" --min-api 24 --lib "$ANDROID_JAR" --output "$OUT/dex" "${CLASSES[@]}"
cp "$OUT/resources.ap_" "$OUT/unsigned.apk"
python3 - "$OUT" <<'PY'
from pathlib import Path
import sys, zipfile
out = Path(sys.argv[1])
with zipfile.ZipFile(out / 'unsigned.apk', 'a') as archive:
    for source in sorted((out / 'dex').glob('classes*.dex')):
        info = zipfile.ZipInfo(source.name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, source.read_bytes(), compresslevel=9)
PY
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [[ ! -f "$KEYSTORE" ]]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  umask 077
  "${KEYTOOL[@]}" -genkeypair -noprompt -keystore "$KEYSTORE" -storetype JKS \
    -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-key-alias androiddebugkey \
  --ks-pass pass:android --key-pass pass:android --v1-signing-enabled false \
  --v4-signing-enabled false --out "$APK" "$OUT/aligned.apk"
"$BT/apksigner" verify --verbose --print-certs "$APK" | tee "$OUT/signature-report.txt"
# Keep the original APK for update-signature verification. This never reads/exposes key material.
PREVIOUS_APK="$OUT/ros-tablet-viewer-0.1.0-debug.apk"
if [[ -f "$PREVIOUS_APK" && "$PREVIOUS_APK" != "$APK" ]]; then
  "$BT/apksigner" verify --print-certs "$PREVIOUS_APK" > "$OUT/previous-signature-report.txt"
  PREVIOUS_CERT="$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' "$OUT/previous-signature-report.txt")"
  CURRENT_CERT="$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' "$OUT/signature-report.txt")"
  [[ -n "$PREVIOUS_CERT" && "$PREVIOUS_CERT" == "$CURRENT_CERT" ]] || {
    echo "Signing certificate differs from v0.1.0; cannot safely deliver as an update." >&2; exit 1;
  }
  echo "Update signing certificate matches v0.1.0: $CURRENT_CERT" | tee "$OUT/upgrade-signature-report.txt"
fi
"$BT/zipalign" -c -p 4 "$APK"
"$BT/aapt2" dump badging "$APK" | tee "$OUT/manifest-report.txt"
"$BT/aapt2" dump xmltree "$APK" --file AndroidManifest.xml > "$OUT/manifest-tree.txt"
python3 "$ROOT/scripts/android-verify.py" "$APK"
(cd "$OUT" && sha256sum "$(basename "$APK")") | tee "$OUT/SHA256SUMS"
echo "Built: $APK"
