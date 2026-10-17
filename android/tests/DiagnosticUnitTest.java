package dev.dot.rosviewer;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;

public final class DiagnosticUnitTest {
    private static int tests;
    private static void equal(Object expected, Object actual) {
        tests++;
        if (!expected.equals(actual)) throw new AssertionError(expected + " != " + actual);
    }
    private static void reject(String input) {
        tests++;
        try { DiagnosticEndpoint.parse(input); throw new AssertionError("Accepted unsafe URL: " + input); }
        catch (IllegalArgumentException expected) { }
    }
    public static void main(String[] args) {
        DiagnosticEndpoint target = DiagnosticEndpoint.parse("ws://192.0.2.1:8765");
        equal("192.0.2.1", target.host); equal(8765, target.port); equal("ws://192.0.2.1:8765", target.target);
        equal(443, DiagnosticEndpoint.parse("wss://example.com/path?secret=omitted").port);
        equal("wss://example.com:443", DiagnosticEndpoint.parse("wss://example.com/path?secret=omitted").target);
        equal("::1", DiagnosticEndpoint.parse("ws://[::1]:8765").host);
        equal("ws://[::1]:8765", DiagnosticEndpoint.parse("ws://[::1]:8765").target);
        equal(80, DiagnosticEndpoint.parse("ws://host.local").port);
        for (String input : new String[] {"", "http://host:8765", "https://host", "file:///etc/passwd", "javascript:alert(1)",
            "ws:host", "ws:///host", "ws://user:password@host", "wss://user@host", "ws://host#fragment", "ws://host:0", "ws://host:65536",
            "ws://host:-1", "ws://-c:8765", "ws://host;reboot", "ws://host/`whoami`", "ws://host\\evil", " ws://host", "ws://host\n",
            "ws://host\u0000", "ws://[fe80::1%eth0]:8765", "ws://[fe80::1%25eth0]:8765", "ws://host name", "ws://%31%30.0.0.1"}) reject(input);
        equal("TIMEOUT", NetworkDiagnostics.failureCode(new SocketTimeoutException("No route should not be inferred")));
        equal("NO_ROUTE", NetworkDiagnostics.failureCode(new NoRouteToHostException()));
        equal("CONNECTION_REFUSED", NetworkDiagnostics.failureCode(new ConnectException("failed: ECONNREFUSED (Connection refused)")));
        equal("NETWORK_UNREACHABLE", NetworkDiagnostics.failureCode(new ConnectException("ENETUNREACH")));
        equal("NO_ROUTE", NetworkDiagnostics.failureCode(new ConnectException("EHOSTUNREACH")));
        equal("TIMEOUT", NetworkDiagnostics.failureCode(new ConnectException("ETIMEDOUT")));
        equal("CONNECT_ERROR", NetworkDiagnostics.failureCode(new ConnectException("unknown failure")));
        equal("IO_ERROR", NetworkDiagnostics.failureCode(new IOException("unknown failure")));
        equal("TIMEOUT", NetworkDiagnostics.step("failure", "TIMEOUT", "safe", 123).get("code"));
        System.out.println("Android diagnostic Java checks passed: " + tests + " (no network requests)");
    }
}
