#!/usr/bin/env bash
# Linux x86_64 SDK setup from the official Google distribution. No sudo needed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$ROOT/.toolchains/android-sdk}}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$ROOT/.toolchains/android-user}"
mkdir -p "$ANDROID_USER_HOME"
TOOLS_REVISION=15859902
TOOLS_SHA256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
URL="https://dl.google.com/android/repository/commandlinetools-linux-${TOOLS_REVISION}_latest.zip"
if [[ "${ANDROID_ACCEPT_SDK_LICENSE:-}" != yes ]]; then
  echo "This setup downloads Google's Android SDK and accepts its license." >&2
  echo "Read https://developer.android.com/studio/terms first." >&2
  echo "Only after you agree, run: ANDROID_ACCEPT_SDK_LICENSE=yes bash scripts/android-setup.sh" >&2
  exit 2
fi
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo "This bootstrap is Linux x86_64 only. Install SDK tools for your OS from developer.android.com/studio." >&2
  exit 1
}
command -v java >/dev/null
mkdir -p "$SDK/cmdline-tools"
if [[ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]]; then
  TEMP="$(mktemp -d)"
  trap 'rm -rf "$TEMP"' EXIT
  curl --fail --location --retry 2 "$URL" -o "$TEMP/tools.zip"
  echo "$TOOLS_SHA256  $TEMP/tools.zip" | sha256sum --check -
  unzip -q "$TEMP/tools.zip" -d "$TEMP/unpacked"
  mv "$TEMP/unpacked/cmdline-tools" "$SDK/cmdline-tools/latest"
fi
SDKMANAGER=("$SDK/cmdline-tools/latest/bin/sdkmanager" "--sdk_root=$SDK")
# A restrictive build environment may provide an HTTP proxy. sdkmanager does not
# consistently use HTTPS_PROXY, so pass supported explicit flags when supplied.
if [[ -z "${ANDROID_SDK_PROXY_HOST:-}" && -n "${HTTPS_PROXY:-${https_proxy:-}}" ]]; then
  read -r ANDROID_SDK_PROXY_HOST ANDROID_SDK_PROXY_PORT < <(python3 -c \
    'import sys,urllib.parse; p=urllib.parse.urlparse(sys.argv[1]); print(p.hostname or "",p.port or 80)' \
    "${HTTPS_PROXY:-$https_proxy}")
fi
if [[ -n "${ANDROID_SDK_PROXY_HOST:-}" ]]; then
  SDKMANAGER+=(--proxy=http "--proxy_host=$ANDROID_SDK_PROXY_HOST" "--proxy_port=${ANDROID_SDK_PROXY_PORT:-8889}")
  export SDKMANAGER_OPTS="${SDKMANAGER_OPTS:-} -Dhttp.proxyHost=$ANDROID_SDK_PROXY_HOST -Dhttp.proxyPort=${ANDROID_SDK_PROXY_PORT:-8889} -Dhttps.proxyHost=$ANDROID_SDK_PROXY_HOST -Dhttps.proxyPort=${ANDROID_SDK_PROXY_PORT:-8889}"
fi
# An explicit opt-in above is mandatory; never auto-accept while merely inspecting setup.
# Request only these three packages, not --licenses (which includes unrelated SDK agreements).
set +o pipefail
yes | "${SDKMANAGER[@]}" 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
LICENSE_STATUS=${PIPESTATUS[1]}
set -o pipefail
[[ "$LICENSE_STATUS" == 0 ]] || exit "$LICENSE_STATUS"
echo "SDK ready at $SDK"
echo "Build the web app, then run: bash scripts/android-build.sh"
