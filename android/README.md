# Android app

ROS Tablet Viewer is a small offline WebView host for the web application in `../web`.

- Application ID: `dev.dot.rosviewer`
- Version: `0.1.1` (version code 2)
- Minimum: Android 7.0 / API 24; compile/target API 35
- Requires an updated Android System WebView with WebGL 2 and a suitable GPU
- Layout target: 7-inch phone in landscape; portrait and larger tablet layouts remain supported
- ABI-neutral Java/DEX: runs on ARM64 phones/tablets; contains no native ABI-specific libraries
- Debug-signed for sideload testing, with WebView/manifest debugging disabled

## Build

Requirements: JDK 17 or 21, Node.js 22.12+ / npm, Python 3, Android SDK platform 35 and build-tools 35.0.0. The build is intentionally Gradle-free: it invokes Google's normal `aapt2`, `d8`, `zipalign`, and `apksigner` tools, with Java's standard compiler. No third-party Android libraries are downloaded.

If needed, install the official SDK. The supplied Linux x86_64 setup script downloads a checksum-pinned official command-line tools archive and prompts for an explicit license opt-in. Review the [Android SDK license](https://developer.android.com/studio/terms) before agreeing:

```sh
ANDROID_ACCEPT_SDK_LICENSE=yes bash scripts/android-setup.sh
cd web
npm ci
npm run build
cd ..
bash scripts/android-build.sh
```

For an existing SDK, set `ANDROID_SDK_ROOT` or `ANDROID_HOME`. Build output is `android/build/ros-tablet-viewer-0.1.1-debug.apk`; its checksum, manifest/signature reports, and `build-metadata.json` are adjacent. The metadata lists SHA-256 hashes for each bundled web file so the packaged bundle can be compared with browser QA. Web assets are copied from `web/dist`, or the directory specified by `WEB_DIST`. The build never edits web sources. ZIP entry timestamps are normalized; repeating the build with identical web files, SDK tools, Java compiler and debug key should produce identical APK bytes.

The build creates an ordinary local debug keystore at `.local/android-debug.keystore` if absent. This is not a production signing identity; do not use this build for Play Store publication. The key is deliberately excluded from the source delivery. Rebuilding with a different key may require uninstalling the earlier APK (which removes its saved preferences) before installation. Keep the same local key for your own future test updates.

To install yourself, transfer the APK to the tablet and open it, or use `adb install -r android/build/ros-tablet-viewer-0.1.1-debug.apk` after enabling authorized USB debugging. No device is installed or modified by the build script.

## Network and WebView security

The app loads `https://appassets.androidplatform.net/index.html` through a custom in-process asset-only interceptor, equivalent in purpose to Android's `WebViewAssetLoader`. Nothing is hosted on the public Internet. Missing local assets return a local 404 instead of falling back to a network request. JavaScript and DOM storage are enabled for the viewer; file/content access, file-origin privileges, cookies, popups, geolocation and reflection-based native JavaScript interfaces are disabled. A narrowly scoped message-port bridge supports explicit local network diagnostics, as described below.

The web client uses ROS1 Foxglove bridge (`foxglove.websocket.v1`), usually at `ws://ROBOT_LAN_IP:8765`. It does not speak rosbridge JSON on port 9090. To support arbitrary user-entered bridge addresses, Android cleartext networking and WebView mixed-content WebSockets must be allowed. These platform switches are app-wide: they cannot be scoped dynamically to just the currently selected IP. The page's enforced Content Security Policy limits executable code, fonts, and assets to the local app and remote connections to `ws:`/`wss:`. Other HTTP(S) resource requests and all external top-level navigation are blocked by the interceptor.

Plain `ws://` has no encryption or server authentication. Use it only on a trusted isolated robot LAN. For any untrusted network, use `wss://` with a valid system-trusted certificate and a secured Foxglove bridge endpoint or trusted private network. TLS verification is never bypassed; self-signed or otherwise invalid certificates fail. No certificate-installation or security-setting changes are made by this app. The app does not make an unsecured robot bridge server safe or private.

The only declared permission is Internet access. There are no background services, analytics, CDNs, location/storage/camera/microphone permissions or robot-control native interfaces. Web content is bundled and works in demo mode offline.

## User-triggered network diagnostics (v0.1.1)

The “网络诊断” button runs on the phone itself against only the host and port in the currently entered `ws://` or `wss://` URL. It does not run a cloud-side test or automatically send the result to anyone. A copied report contains the selected endpoint (without URL credentials, path or query), resolved addresses, per-step elapsed milliseconds, categorized errors, app version, Android release/API, device manufacturer/model and WebView version. No serial number, account, location, nearby networks, files or broad system inventory is collected.

- DNS uses the system resolver with a 3-second result deadline. An interrupted system resolver cannot spawn unlimited replacement threads; subsequent tests report a busy resolver until it returns.
- TCP tries at most 4 resolved addresses with a 5-second total budget (at most 2.5 seconds per address). It sends no application data. A successful TCP connection does not establish that TLS, WebSocket, Foxglove or topic advertisement works.
- Optional ICMP checks the first resolved address (reported separately, which may differ from the successful TCP address) and uses the system `/system/bin/ping` or `/system/bin/ping6` with fixed arguments, one packet and a numeric IP. No shell is used. Unsupported or denied ICMP is labeled skipped. Missing replies do not establish that the server or TCP service is down. Elapsed time is total check time, not precise ICMP RTT.
- The diagnostic channel is transferred only to the main frame at the bundled HTTPS origin, after verifying the exact home page. A private message-port wrapper requires a trusted click on the diagnostic button and the exact current URL field value. Java validates the URL again and rechecks the field before networking. Credentials, fragments, non-WebSocket schemes and ambiguous/option-like hosts are rejected. There is no `addJavascriptInterface`, arbitrary command, file operation, TLS bypass or robot-control API.
- Navigation, backgrounding or destruction closes the channel and cancels sockets/processes. Resume establishes a fresh channel; old results cannot cross page generations. Only one check can run at a time.
- At most 24 warning/error categories are retained in memory from the WebView console. Raw console messages and arbitrary remote data are omitted. If the render process terminates, a native fallback offers an explicitly triggered copy of the local report and page restart.

No Android network-security or mixed-content allowance was broadened in this diagnostic update. The existing HTTPS local-page/`ws://` configuration remains unchanged so evidence from a tested phone can distinguish network reachability from browser/protocol errors. In particular, TCP success with a WebView security error is evidence to investigate the browser path; it is not a reason to disable TLS validation.

## Lifecycle and tablet behavior

The Activity preserves its WebView across portrait/landscape changes, supports multi-window resizing, and uses immersive system bars (swipe from the edge to reveal them). Native window-inset padding protects compact landscape controls from camera cutouts, navigation gestures and revealed system bars. The screen stays awake only while this foreground Activity is active.

It dispatches `window` events named `androidlifecycle` with `event.detail.state` set to `pause` or `resume`, and calls the WebView's normal lifecycle methods. The web app must also handle browser `visibilitychange`; it owns socket suspension/reconnection and render-loop pauses. No background connection service runs.

Android Back dispatches a cancelable `androidback` event to the page. The page closes an open dialog/drawer and calls `preventDefault()` when it handles Back; otherwise the Activity exits. Android normally dismisses the software keyboard before delivering Back to the Activity. Native Back/keyboard behavior still requires validation on a physical device.

## Verification

`android-build.sh` checks APK signature validity, ZIP alignment, manifest package/version/SDK data, ZIP integrity, DEX presence, and byte-for-byte inclusion of all built web files and the native bridge bootstrap. If the original v0.1.0 APK is still in the build folder, it also checks that the signing certificate is unchanged. Run `bash scripts/android-test.sh` for pure-JVM URL/error classification and sandboxed JavaScript bridge authorization checks; these tests make no network requests. With the command-line tools installed, `bash scripts/android-lint.sh` checks Android API compatibility and missing permissions. A successful static build does not establish phone rendering or live-robot correctness. Test on the target phone: offline demo, WebGL availability, portrait/landscape, keyboard input, Back, home/resume, LAN socket disconnect/reconnect, and an appropriately secured TLS endpoint.

Official references: [local WebView content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content), [network security configuration](https://developer.android.com/privacy-and-security/security-config), [APK signing tool](https://developer.android.com/tools/apksigner).
