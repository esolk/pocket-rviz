package dev.dot.rosviewer;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.DisplayCutout;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;
import org.json.JSONException;
import org.json.JSONTokener;
import java.util.Locale;
import java.util.Map;

/** Offline, single-origin WebView host with a narrowly scoped message-port diagnostic bridge. */
public final class MainActivity extends Activity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + ASSET_HOST + "/index.html";
    private WebView webView;
    private final NetworkDiagnostics diagnostics = new NetworkDiagnostics();
    private final ArrayDeque<Map<String, Object>> consoleEvents = new ArrayDeque<>();
    private WebMessagePort diagnosticPort;
    private int pageGeneration;
    private boolean foreground;
    private boolean pageReady;
    private String diagnosticRequestId;
    private static final Pattern NETWORK_ERROR = Pattern.compile("(?:net::)?ERR_[A-Z0-9_]{1,70}");

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams layout = getWindow().getAttributes();
            layout.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER;
            getWindow().setAttributes(layout);
        }
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.rgb(16, 23, 34));
        // Native padding keeps every web control away from a landscape camera cutout,
        // gesture navigation, and temporarily revealed system bars on compact phones.
        frame.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
          @Override public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
            int left = insets.getSystemWindowInsetLeft();
            int top = insets.getSystemWindowInsetTop();
            int right = insets.getSystemWindowInsetRight();
            int bottom = insets.getSystemWindowInsetBottom();
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = safe.left; top = safe.top; right = safe.right; bottom = safe.bottom;
            } else if (Build.VERSION.SDK_INT >= 28) {
                DisplayCutout cutout = insets.getDisplayCutout();
                if (cutout != null) {
                    left = Math.max(left, cutout.getSafeInsetLeft());
                    top = Math.max(top, cutout.getSafeInsetTop());
                    right = Math.max(right, cutout.getSafeInsetRight());
                    bottom = Math.max(bottom, cutout.getSafeInsetBottom());
                }
            }
            if (Build.VERSION.SDK_INT >= 29) {
                android.graphics.Insets gestures = insets.getMandatorySystemGestureInsets();
                left = Math.max(left, gestures.left);
                right = Math.max(right, gestures.right);
                bottom = Math.max(bottom, gestures.bottom);
            }
            view.setPadding(left, top, right, bottom);
            return insets;
          }
        });
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(16, 23, 34));
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // The only mixed network content allowed by our CSP is a ws:// connection.
        // This is necessary for ordinary Foxglove bridge on a trusted, isolated LAN.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                    || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                    recordConsole(message);
                }
                return true; // Keep app diagnostics local; do not forward raw console data to logcat.
            }
        });
        webView.setWebViewClient(new BundledContentClient());
        frame.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(frame);
        frame.requestApplyInsets();
        webView.loadUrl(HOME);
        enterImmersiveMode();
    }

    private void enterImmersiveMode() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }

    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        enterImmersiveMode();
    }

    @Override public void onBackPressed() {
        if (webView == null) { finish(); return; }
        webView.evaluateJavascript(
            "(function(){return !window.dispatchEvent(new Event('androidback',{cancelable:true}));})()",
            new ValueCallback<String>() {
                @Override public void onReceiveValue(String handled) {
                    if (!"true".equals(handled)) MainActivity.this.finish();
                }
            });
    }

    private void lifecycle(String state) {
        if (webView != null) webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('androidlifecycle',{detail:{state:'"
            + state + "'}}));", null);
    }

    @Override protected void onPause() {
        lifecycle("pause");
        foreground = false;
        closeDiagnosticBridge();
        // The page handles socket/timer suspension from this event and visibilitychange.
        // Avoid pauseTimers(), which can race queued evaluateJavascript lifecycle events.
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (webView != null) webView.onResume();
        lifecycle("resume");
        if (pageReady) installDiagnosticBridge();
    }

    @Override protected void onDestroy() {
        foreground = false;
        closeDiagnosticBridge();
        diagnostics.close();
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && ASSET_HOST.equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443)
            && uri.getUserInfo() == null;
    }

    private final class BundledContentClient extends WebViewClient {
        @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
            pageReady = false;
            closeDiagnosticBridge();
        }

        @Override public void onPageFinished(WebView view, String url) {
            pageReady = HOME.equals(url) && HOME.equals(view.getUrl());
            if (pageReady && foreground) installDiagnosticBridge();
        }

        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            pageReady = false;
            closeDiagnosticBridge();
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
            view.destroy();
            if (webView == view) webView = null;
            showRendererFailure(Build.VERSION.SDK_INT >= 26 && detail.didCrash());
            return true;
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Block all external main-frame navigation, including intent:, file: and http:.
            return !request.isForMainFrame() || !HOME.equals(request.getUrl().toString());
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isLocal(uri) || !"GET".equals(request.getMethod())) return error(403, "Forbidden");
            String path = uri.getPath();
            if (path == null || path.equals("/")) path = "/index.html";
            if (path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return error(400, "Bad Request");
            for (String segment : path.split("/")) {
                if (segment.equals(".") || segment.equals("..")) return error(400, "Bad Request");
            }
            try {
                InputStream body = getAssets().open("web" + path);
                String mime = mime(path);
                String encoding = mime.startsWith("text/") || mime.contains("javascript")
                    || mime.contains("json") || mime.contains("svg") ? "UTF-8" : null;
                return new WebResourceResponse(mime, encoding, 200, "OK", headers(), body);
            } catch (IOException missing) {
                // Never fall back to the Internet for a missing local resource.
                return error(404, "Not Found");
            }
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel(); // Never ignore a certificate error.
        }
    }


    private boolean isDiagnosticPage() {
        return foreground && pageReady && webView != null && HOME.equals(webView.getUrl());
    }

    private void closeDiagnosticBridge() {
        pageGeneration++;
        diagnosticRequestId = null;
        diagnostics.cancel();
        if (diagnosticPort != null) {
            diagnosticPort.close();
            diagnosticPort = null;
        }
    }

    private void installDiagnosticBridge() {
        closeDiagnosticBridge();
        if (!isDiagnosticPage()) return;
        final int generation = pageGeneration;
        final String nonce = UUID.randomUUID().toString();
        final String script;
        try (InputStream input = getAssets().open("diagnostics-bootstrap.js")) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[2048];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            script = new String(output.toByteArray(), StandardCharsets.UTF_8)
                .replace("__DIAGNOSTIC_NONCE__", nonce);
        } catch (IOException missing) { return; }
        webView.evaluateJavascript(script, new ValueCallback<String>() {
            @Override public void onReceiveValue(String ignored) {
                if (generation != pageGeneration || !isDiagnosticPage()) return;
                WebMessagePort[] ports = webView.createWebMessageChannel();
                diagnosticPort = ports[0];
                ports[0].setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
                    @Override public void onMessage(WebMessagePort port, WebMessage message) {
                        if (port != diagnosticPort || generation != pageGeneration || !isDiagnosticPage()) return;
                        handleDiagnosticRequest(message.getData(), generation);
                    }
                });
                Map<String, Object> hello = new LinkedHashMap<>();
                hello.put("kind", "ros-native-diagnostics");
                hello.put("nonce", nonce);
                // Only the main frame at this exact origin receives the port. Never use '*'.
                webView.postWebMessage(new WebMessage(new JSONObject(hello).toString(), new WebMessagePort[] {ports[1]}),
                    Uri.parse("https://" + ASSET_HOST));
            }
        });
    }

    private void handleDiagnosticRequest(String raw, final int generation) {
        if (raw == null || raw.length() > 4096) return;
        final String url;
        final String requestId;
        final DiagnosticEndpoint endpoint;
        try {
            JSONObject request = new JSONObject(raw);
            requestId = request.getString("requestId");
            url = request.getString("url");
            if (!requestId.matches("[A-Za-z0-9_-]{1,80}")) return;
        } catch (JSONException invalid) { return; }
        try {
            endpoint = DiagnosticEndpoint.parse(url);
        } catch (IllegalArgumentException invalid) {
            sendDiagnosticError(requestId, "invalid endpoint", invalid.getMessage(), generation);
            return;
        }
        // Read the current field from the trusted top-level document again before any networking.
        webView.evaluateJavascript("(function(){var e=document.getElementById('url');return e?e.value.trim():null;})()",
            new ValueCallback<String>() {
                @Override public void onReceiveValue(String current) {
                    if (generation != pageGeneration || !isDiagnosticPage()) return;
                    Object currentValue;
                    try { currentValue = current == null ? null : new JSONTokener(current).nextValue(); }
                    catch (JSONException malformed) { currentValue = null; }
                    if (!(currentValue instanceof String) || !url.equals(currentValue)) {
                        sendDiagnosticError(requestId, endpoint.target, "地址已更改，请重新点击诊断", generation);
                        return;
                    }
                    if (diagnosticRequestId != null) {
                        sendDiagnosticError(requestId, endpoint.target, "已有诊断正在进行，请等它结束", generation);
                        return;
                    }
                    diagnosticRequestId = requestId;
                    final Map<String, Object> device = deviceMetadata();
                    boolean accepted = diagnostics.start(endpoint, requestId, new NetworkDiagnostics.Listener() {
                        @Override public void onResult(final Map<String, Object> result) {
                            runOnUiThread(new Runnable() {
                                @Override public void run() {
                                    if (generation != pageGeneration || !isDiagnosticPage()
                                        || !requestId.equals(diagnosticRequestId)) return;
                                    result.put("device", device);
                                    result.put("console", new ArrayList<>(consoleEvents));
                                    sendDiagnosticResult(result);
                                    if (!"running".equals(result.get("status"))) diagnosticRequestId = null;
                                }
                            });
                        }
                    });
                    if (!accepted) {
                        diagnosticRequestId = null;
                        sendDiagnosticError(requestId, endpoint.target, "上次网络操作仍在结束，请稍后重试", generation);
                    }
                }
            });
    }

    private void sendDiagnosticError(String requestId, String target, String message, int generation) {
        if (generation != pageGeneration || !isDiagnosticPage()) return;
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("requestId", requestId); result.put("target", target);
        result.put("status", "error"); result.put("message", message);
        sendDiagnosticResult(result);
    }

    private void sendDiagnosticResult(Map<String, Object> result) {
        if (diagnosticPort != null && isDiagnosticPage()) {
            try { diagnosticPort.postMessage(new WebMessage(new JSONObject(result).toString())); }
            catch (IllegalStateException closed) { /* Navigation has revoked this port. */ }
        }
    }

    private Map<String, Object> deviceMetadata() {
        Map<String, Object> device = new LinkedHashMap<>();
        try {
            PackageInfo app = getPackageManager().getPackageInfo(getPackageName(), 0);
            device.put("appVersion", app.versionName + " (" + app.versionCode + ")");
        } catch (android.content.pm.PackageManager.NameNotFoundException missing) {
            device.put("appVersion", "unknown");
        }
        device.put("androidVersion", Build.VERSION.RELEASE);
        device.put("androidApi", Build.VERSION.SDK_INT);
        device.put("manufacturer", Build.MANUFACTURER);
        device.put("model", Build.MODEL);
        if (Build.VERSION.SDK_INT >= 26) {
            PackageInfo provider = WebView.getCurrentWebViewPackage();
            device.put("webViewVersion", provider == null ? "unknown" : provider.packageName + " " + provider.versionName);
        } else {
            // API 24–25 do not provide the public WebView package getter. Extract only its version.
            String ua = WebSettings.getDefaultUserAgent(this);
            Matcher version = Pattern.compile("Chrome/([0-9.]+)").matcher(ua);
            device.put("webViewVersion", version.find() ? "Chromium " + version.group(1) : "unknown (API < 26)");
        }
        return device;
    }

    private void recordConsole(ConsoleMessage event) {
        String raw = event.message() == null ? "" : event.message();
        if (raw.length() > 4096) raw = raw.substring(0, 4096);
        String lower = raw.toLowerCase(Locale.ROOT);
        String summary;
        Matcher network = NETWORK_ERROR.matcher(raw);
        if (network.find()) summary = "WebView network: " + network.group();
        else if (lower.contains("mixed content")) summary = "WebView blocked mixed content";
        else if (lower.contains("private network") || lower.contains("local network")) summary = "WebView local/private network policy warning";
        else if (lower.contains("content security policy")) summary = "WebView content security policy warning";
        else if (lower.contains("webgl") || lower.contains("context lost")) summary = "WebView WebGL/context warning";
        else summary = "WebView console message (text omitted for privacy)";
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("time", System.currentTimeMillis());
        record.put("level", event.messageLevel().name());
        record.put("message", summary);
        if (consoleEvents.size() >= 24) consoleEvents.removeFirst();
        consoleEvents.addLast(record);
    }

    private void showRendererFailure(boolean crashed) {
        final String report = (crashed ? "WebView 渲染进程已崩溃" : "WebView 渲染进程已被系统结束（原因未确定）")
            + "\n" + new JSONObject(deviceMetadata()).toString()
            + "\n" + new org.json.JSONArray(new ArrayList<>(consoleEvents)).toString();
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding, padding, padding);
        panel.setBackgroundColor(Color.rgb(16, 23, 34));
        TextView text = new TextView(this);
        text.setTextColor(Color.WHITE);
        text.setText(report + "\n请复制本地诊断，随后重新打开页面。");
        text.setTextIsSelectable(true);
        panel.addView(text, new LinearLayout.LayoutParams(-1, 0, 1));
        Button copy = new Button(this);
        copy.setText("复制本地诊断");
        copy.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("ROS Viewer diagnostic", report));
            }
        });
        panel.addView(copy);
        Button reload = new Button(this);
        reload.setText("重新打开页面");
        reload.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { recreate(); }
        });
        panel.addView(reload);
        setContentView(panel);
    }

    private static Map<String, String> headers() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            + "font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self' blob:; "
            + "media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Referrer-Policy", "no-referrer");
        headers.put("Cache-Control", "no-cache");
        headers.put("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        return headers;
    }

    private static WebResourceResponse error(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, headers(),
            new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    private static String mime(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }
}
