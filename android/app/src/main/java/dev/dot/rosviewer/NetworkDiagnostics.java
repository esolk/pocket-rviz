package dev.dot.rosviewer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NoRouteToHostException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** One foreground, read-only network check. Never sends application data or TLS credentials. */
final class NetworkDiagnostics {
    interface Listener { void onResult(Map<String, Object> result); }
    private static final int DNS_TIMEOUT_MS = 3000;
    private static final int TCP_TOTAL_MS = 5000;
    private static final int TCP_EACH_MS = 2500;
    private final ThreadPoolExecutor worker = executor("ros-diagnostics");
    // A resolver that ignores interruption cannot create an unbounded number of threads.
    private final ThreadPoolExecutor resolver = executor("ros-dns");
    private volatile Run active;

    private static ThreadPoolExecutor executor(final String name) {
        return new ThreadPoolExecutor(0, 1, 10, TimeUnit.SECONDS,
            new SynchronousQueue<Runnable>(), new ThreadFactory() {
                @Override public Thread newThread(Runnable task) {
                    Thread thread = new Thread(task, name);
                    thread.setDaemon(true);
                    return thread;
                }
            }, new ThreadPoolExecutor.AbortPolicy());
    }

    synchronized boolean start(final DiagnosticEndpoint endpoint, final String requestId, final Listener listener) {
        if (active != null) return false;
        final Run run = new Run(endpoint, requestId, listener);
        active = run;
        try {
            worker.execute(new Runnable() {
                @Override public void run() {
                    try { run.execute(); }
                    finally { synchronized (NetworkDiagnostics.this) { if (active == run) active = null; } }
                }
            });
            return true;
        } catch (RejectedExecutionException unavailable) {
            active = null;
            return false;
        }
    }

    synchronized void cancel() { if (active != null) active.cancel(); }
    synchronized void close() {
        cancel();
        worker.shutdownNow();
        resolver.shutdownNow();
    }

    private final class Run {
        final DiagnosticEndpoint endpoint;
        final String requestId;
        final Listener listener;
        final Map<String, Object> report = new LinkedHashMap<>();
        volatile boolean cancelled;
        volatile Socket socket;
        volatile Process process;
        volatile Future<InetAddress[]> lookup;
        final long start = System.nanoTime();

        Run(DiagnosticEndpoint endpoint, String requestId, Listener listener) {
            this.endpoint = endpoint; this.requestId = requestId; this.listener = listener;
            report.put("requestId", requestId);
            report.put("target", endpoint.target); // Deliberately excludes path/query/credentials.
            report.put("startedAt", System.currentTimeMillis());
        }

        void cancel() {
            cancelled = true;
            Future<InetAddress[]> pending = lookup;
            if (pending != null) pending.cancel(true);
            Socket current = socket;
            if (current != null) try { current.close(); } catch (IOException ignored) { }
            Process running = process;
            if (running != null) running.destroy();
        }

        void execute() {
            try {
                emit("running");
                InetAddress[] addresses = resolve();
                if (cancelled) return;
                if (addresses == null || addresses.length == 0) {
                    report.put("tcp", step("skipped", "DNS_UNAVAILABLE", "未获得目标 IP，未测试 TCP", 0));
                    report.put("ping", step("skipped", "DNS_UNAVAILABLE", "未获得目标 IP，未测试 ICMP", 0));
                } else {
                    testTcp(addresses);
                    if (cancelled) return;
                    emit("running");
                    Map<String, Object> pingResult = ping(addresses[0]);
                    pingResult.put("address", addresses[0].getHostAddress());
                    report.put("ping", pingResult);
                }
                if (!cancelled) {
                    report.put("durationMs", elapsed(start));
                    report.put("completedAt", System.currentTimeMillis());
                    report.put("message", "TCP 成功仅表示端口接受连接；Foxglove 协议和话题状态请看应用连接日志。ICMP 失败不能证明服务不可用。");
                    emit("complete");
                }
            } catch (RuntimeException unexpected) {
                if (!cancelled) {
                    report.put("message", "诊断未完成（" + unexpected.getClass().getSimpleName() + "），请重试");
                    report.put("completedAt", System.currentTimeMillis());
                    emit("error");
                }
            } finally { cancel(); }
        }

        InetAddress[] resolve() {
            long begin = System.nanoTime();
            try {
                lookup = resolver.submit(new Callable<InetAddress[]>() {
                    @Override public InetAddress[] call() throws UnknownHostException {
                        return InetAddress.getAllByName(endpoint.host);
                    }
                });
                InetAddress[] addresses = lookup.get(DNS_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                Map<String, Object> result = step("success", "RESOLVED", "目标地址已解析", elapsed(begin));
                List<String> ips = new ArrayList<>();
                for (int i = 0; i < addresses.length && i < 8; i++) ips.add(addresses[i].getHostAddress());
                result.put("addresses", ips);
                report.put("dns", result);
                return addresses;
            } catch (TimeoutException timeout) {
                if (lookup != null) lookup.cancel(true);
                report.put("dns", step("failure", "TIMEOUT", "地址解析超过 3000 ms；尚不能判断 TCP 端口", elapsed(begin)));
            } catch (ExecutionException failed) {
                report.put("dns", step("failure", "DNS_ERROR", "系统无法解析主机名；请检查地址、DNS 或 VPN", elapsed(begin)));
            } catch (RejectedExecutionException busy) {
                report.put("dns", step("skipped", "RESOLVER_BUSY", "上次系统解析仍未结束，请稍后重试", elapsed(begin)));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                cancelled = true;
            } catch (java.util.concurrent.CancellationException stopped) {
                cancelled = true;
            }
            return null;
        }

        void testTcp(InetAddress[] addresses) {
            long begin = System.nanoTime();
            List<Map<String, Object>> attempts = new ArrayList<>();
            boolean success = false;
            String lastCode = "IO_ERROR";
            for (int i = 0; i < addresses.length && i < 4 && !cancelled; i++) {
                int remaining = TCP_TOTAL_MS - (int) elapsed(begin);
                if (remaining <= 0) break;
                long attemptBegin = System.nanoTime();
                Map<String, Object> attempt;
                Socket current = new Socket();
                socket = current;
                try {
                    if (cancelled) return;
                    current.connect(new InetSocketAddress(addresses[i], endpoint.port), Math.min(remaining, TCP_EACH_MS));
                    attempt = step("success", "CONNECTED", "TCP 端口接受连接；未验证 TLS 或 Foxglove", elapsed(attemptBegin));
                    success = true;
                } catch (IOException failed) {
                    lastCode = failureCode(failed);
                    attempt = step("failure", lastCode, failureMessage(lastCode), elapsed(attemptBegin));
                } catch (SecurityException denied) {
                    lastCode = "SECURITY_DENIED";
                    attempt = step("failure", lastCode, "系统拒绝网络操作", elapsed(attemptBegin));
                } finally {
                    try { current.close(); } catch (IOException ignored) { }
                    if (socket == current) socket = null;
                }
                attempt.put("address", addresses[i].getHostAddress());
                attempt.put("port", endpoint.port);
                attempts.add(attempt);
                if (success) break;
            }
            Map<String, Object> result = step(success ? "success" : "failure", success ? "CONNECTED" : lastCode,
                success ? "TCP 端口接受连接；未验证 TLS 或 Foxglove" : failureMessage(lastCode), elapsed(begin));
            result.put("attempts", attempts);
            result.put("port", endpoint.port);
            result.put("addressCount", addresses.length);
            result.put("testedAddressCount", attempts.size());
            report.put("tcp", result);
        }

        Map<String, Object> ping(InetAddress address) {
            long begin = System.nanoTime();
            String numeric = address.getHostAddress();
            // Numeric addresses only. No shell, shell interpolation, URL paths or hostname arguments.
            if (numeric == null || !numeric.matches("[0-9a-fA-F:.]+")) {
                return step("skipped", "UNSUPPORTED_ADDRESS", "此地址形式不支持 ICMP 检查", 0);
            }
            String executable = numeric.indexOf(':') >= 0 ? "/system/bin/ping6" : "/system/bin/ping";
            if (!new File(executable).canExecute()) {
                return step("skipped", "UNSUPPORTED", "此 Android 系统没有可用的 ping；以 TCP 和协议检查为准", 0);
            }
            try {
                if (cancelled) return step("skipped", "CANCELLED", "诊断已取消", 0);
                Process current = new ProcessBuilder(executable, "-n", "-c", "1", "-W", "2", numeric)
                    .redirectErrorStream(true).start();
                process = current;
                long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(3000);
                Integer exit = null;
                while (!cancelled && System.nanoTime() < deadline) {
                    try { exit = current.exitValue(); break; }
                    catch (IllegalThreadStateException running) { Thread.sleep(40); }
                }
                if (cancelled) return step("skipped", "CANCELLED", "诊断已取消", elapsed(begin));
                if (exit == null) {
                    current.destroy();
                    return step("failure", "TIMEOUT", "ICMP 检查超时；可能被禁用或丢包，不代表 TCP 不通", elapsed(begin));
                }
                String output = boundedOutput(current.getInputStream());
                if (exit == 0) return step("success", "REPLY", "收到 1 次 ICMP 回应（耗时为整个检查时长，并非精确 RTT）", elapsed(begin));
                if (exit != 1 || output.contains("not permitted") || output.contains("permission denied")
                    || output.contains("invalid option") || output.contains("unknown option")) {
                    return step("skipped", "UNSUPPORTED", "系统 ping 无法执行（退出码 " + exit + "）；不能据此判断服务器", elapsed(begin));
                }
                return step("failure", "NO_REPLY", "未收到 ICMP 回应；可能被禁用或丢包，不代表 TCP 不通", elapsed(begin));
            } catch (IOException | SecurityException unsupported) {
                return step("skipped", "UNSUPPORTED", "系统不允许执行 ICMP 检查；以 TCP 和协议检查为准", elapsed(begin));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                cancelled = true;
                return step("skipped", "CANCELLED", "诊断已取消", elapsed(begin));
            } finally {
                Process current = process;
                if (current != null) {
                    current.destroy();
                    try { current.getInputStream().close(); } catch (IOException ignored) { }
                    try { current.getErrorStream().close(); } catch (IOException ignored) { }
                    try { current.getOutputStream().close(); } catch (IOException ignored) { }
                    process = null;
                }
            }
        }

        void emit(String status) {
            report.put("status", status);
            listener.onResult(new LinkedHashMap<>(report));
        }
    }

    private static String boundedOutput(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[512];
        while (output.size() < 4096) {
            int read = input.read(buffer, 0, Math.min(buffer.length, 4096 - output.size()));
            if (read < 0) break;
            output.write(buffer, 0, read);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
    }

    static String failureCode(IOException failure) {
        if (failure instanceof SocketTimeoutException) return "TIMEOUT";
        if (failure instanceof NoRouteToHostException) return "NO_ROUTE";
        // Android/libcore often retains errno symbols in ConnectException's message.
        String message = String.valueOf(failure.getMessage()).toUpperCase(Locale.ROOT);
        if (message.contains("ENETUNREACH") || message.contains("NETWORK IS UNREACHABLE")) return "NETWORK_UNREACHABLE";
        if (message.contains("EHOSTUNREACH") || message.contains("NO ROUTE TO HOST")) return "NO_ROUTE";
        if (message.contains("ECONNREFUSED") || message.contains("CONNECTION REFUSED")) return "CONNECTION_REFUSED";
        if (message.contains("ETIMEDOUT")) return "TIMEOUT";
        if (failure instanceof ConnectException) return "CONNECT_ERROR";
        return "IO_ERROR";
    }

    private static String failureMessage(String code) {
        if (code.equals("TIMEOUT")) return "TCP 连接超时；可能为丢包、防火墙或路径问题，不能仅据此判定无路由";
        if (code.equals("CONNECTION_REFUSED")) return "TCP 连接被拒绝；目标端口未接受连接或被主动拒绝";
        if (code.equals("NO_ROUTE")) return "系统报告无主机路由（EHOSTUNREACH / NoRouteToHost）";
        if (code.equals("NETWORK_UNREACHABLE")) return "系统报告网络不可达（ENETUNREACH）";
        if (code.equals("SECURITY_DENIED")) return "系统拒绝网络操作";
        return "TCP 连接失败；系统未给出可安全确定的更具体原因";
    }

    static Map<String, Object> step(String status, String code, String message, long durationMs) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", status); result.put("code", code);
        result.put("durationMs", durationMs); result.put("message", message);
        return result;
    }
    private static long elapsed(long start) { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start); }
}
