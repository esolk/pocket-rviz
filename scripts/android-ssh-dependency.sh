#!/usr/bin/env bash
# Pinned JSch from Maven Central; no vendored binaries or new SDK license acceptance.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.toolchains/deps"
JAR="$DIR/jsch-0.2.26.jar"
SHA=5ad82d1a9534404d0a519c525e796c8ef69f4fe47b19bc4d16bbd296686ac9f2
mkdir -p "$DIR"
if [[ ! -f "$JAR" ]]; then
  TEMP="$(mktemp "$DIR/jsch-download.XXXXXX")"
  trap 'rm -f "$TEMP"' EXIT
  curl --fail --location --retry 2 'https://repo.maven.apache.org/maven2/com/github/mwiede/jsch/0.2.26/jsch-0.2.26.jar' -o "$TEMP"
  echo "$SHA  $TEMP" | sha256sum --check -
  mv "$TEMP" "$JAR"
fi
echo "$SHA  $JAR" | sha256sum --check -
# D8 consumes Java8 base classes only, not Java9+ multi-release overrides/module-info.
python3 - "$JAR" "$DIR/jsch-0.2.26-android.jar" <<'PY'
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as dest:
    for name in sorted(source.namelist()):
        if name.endswith('.class') and not name.startswith('META-INF/') and name != 'module-info.class':
            info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
            dest.writestr(info,source.read(name))
PY

BC="$DIR/bcprov-jdk18on-1.80.jar"
BC_SHA=e8ad209f8c58d291a37ca9750e9e9fac60596956c983e49dd8282381dd8b3249
if [[ ! -f "$BC" ]]; then
  curl --fail --location --retry 2 'https://repo.maven.apache.org/maven2/org/bouncycastle/bcprov-jdk18on/1.80/bcprov-jdk18on-1.80.jar' -o "$BC.download"
  echo "$BC_SHA  $BC.download" | sha256sum --check -
  mv "$BC.download" "$BC"
fi
echo "$BC_SHA  $BC" | sha256sum --check -
python3 - "$BC" "$DIR/bcprov-1.80-android.jar" <<'PYBC'
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as dest:
    for name in sorted(source.namelist()):
        if name.endswith('.class') and not name.startswith('META-INF/') and name != 'module-info.class':
            info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
            dest.writestr(info,source.read(name))
PYBC
