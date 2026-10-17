package dev.dot.rosviewer;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Strict, side-effect-free parsing. Only the selected WebSocket host and port are probed. */
final class DiagnosticEndpoint {
    final String host;
    final int port;
    final String target;

    private DiagnosticEndpoint(String host, int port, String scheme) {
        this.host = host;
        this.port = port;
        this.target = scheme + "://" + (host.indexOf(':') >= 0 ? "[" + host + "]" : host) + ":" + port;
    }

    static DiagnosticEndpoint parse(String input) {
        if (input == null || input.length() > 2048 || input.length() == 0 || !input.equals(input.trim())) {
            throw new IllegalArgumentException("请输入有效的 ws:// 或 wss:// 地址");
        }
        // Forbid ambiguous browser/URI parsing and IPv6 interface-zone syntax.
        if (input.indexOf('\\') >= 0 || input.matches(".*[\\x00-\\x20\\x7f].*")) {
            throw new IllegalArgumentException("地址含空白或无效字符");
        }
        try {
            URI uri = new URI(input);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("ws") && !scheme.equals("wss")) throw new IllegalArgumentException("只支持 ws:// 或 wss://");
            if (uri.isOpaque() || uri.getRawUserInfo() != null || uri.getRawFragment() != null) {
                throw new IllegalArgumentException("地址不能包含用户名、密码或片段");
            }
            String host = uri.getHost();
            if (host == null || host.length() > 253 || host.startsWith("-")) {
                throw new IllegalArgumentException("主机名或 IP 地址无效");
            }
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
            if (host.indexOf('%') >= 0 || !host.matches("[A-Za-z0-9.:-]+")) {
                throw new IllegalArgumentException("主机名或 IP 地址无效；不支持 IPv6 区域标识");
            }
            int port = uri.getPort();
            if (port == -1) port = scheme.equals("wss") ? 443 : 80;
            if (port < 1 || port > 65535) throw new IllegalArgumentException("端口必须在 1–65535 之间");
            return new DiagnosticEndpoint(host, port, scheme);
        } catch (URISyntaxException malformed) {
            throw new IllegalArgumentException("WebSocket 地址格式无效");
        }
    }
}
