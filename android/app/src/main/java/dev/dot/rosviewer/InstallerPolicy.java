package dev.dot.rosviewer;


/** Small, testable input and command boundary. Never interpolate connection fields into a shell. */
public final class InstallerPolicy {
    private InstallerPolicy() {}
    public static String host(String value) {
        String s = value.trim();
        if (s.length() == 0 || s.length() > 253 || s.startsWith("-")
            || !s.matches("[A-Za-z0-9][A-Za-z0-9.:-]*") || s.contains(".."))
            throw new IllegalArgumentException("请输入主机 IP 或域名，不要填写 URL、用户名或命令");
        return s;
    }
    public static String user(String value) {
        String s = value.trim();
        if (!s.matches("[A-Za-z_][A-Za-z0-9_.-]{0,63}") || "root".equals(s))
            throw new IllegalArgumentException("请使用非 root 的普通 Linux 用户");
        return s;
    }
    public static int port(String value) {
        try { int p = Integer.parseInt(value.trim()); if (p > 0 && p <= 65535) return p; }
        catch (NumberFormatException ignored) {}
        throw new IllegalArgumentException("SSH 端口应为 1–65535");
    }
    public static String command(String encodedScript, String mode, String token) {
        if (!encodedScript.matches("[A-Za-z0-9+/=]+") ||
            !("probe".equals(mode) || "plan".equals(mode) || "install".equals(mode) || "start".equals(mode)))
            throw new IllegalArgumentException("Invalid installer command");
        if (!"probe".equals(mode) && (token==null || !token.matches("[a-f0-9]{32}")))
            throw new IllegalArgumentException("Invalid installer token");
        return "bash -c \"$(printf %s '" + encodedScript + "' | base64 -d)\" -- " + mode
            + ("probe".equals(mode) ? "" : " " + token);
    }
    public static String cleanLog(String input) {
        return input.replaceAll("\\x1b\\[[0-9;?]*[ -/]*[@-~]", "")
            .replaceAll("[\\x00-\\x08\\x0b-\\x1f\\x7f]", "");
    }
}
