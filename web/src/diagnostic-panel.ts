import type { RosConnection } from "./client";
import {
  APP_VERSION,
  connectionSummary,
  redactDiagnosticText,
  redactUrl,
  STALE_AFTER_MS,
  validateSocketUrl,
} from "./diagnostics";

export const diagnosticDialog = `
<dialog id="diagnostics-dialog" aria-labelledby="diagnostic-title">
  <div class="dialog-heading"><div><small>ROS1 · v${APP_VERSION}</small><h2 id="diagnostic-title">连接诊断</h2></div><button id="diagnostic-close" class="icon" aria-label="关闭诊断">×</button></div>
  <p id="diagnostic-summary" role="status"></p>
  <dl id="diagnostic-facts"></dl>
  <div class="diagnostic-actions"><button id="diagnostic-retry" class="primary">立即重试</button><button id="diagnostic-stop" class="secondary">停止重试 / 断开</button><button id="network-probe" class="secondary">检测 TCP / Ping</button></div>
  <p id="network-probe-result" class="diagnostic-note">网络检测只在点击时运行，目标为连接窗口中的地址。</p>
  <p class="diagnostic-note">浏览器不会提供 WebSocket 失败的底层原因或 HTTP 状态。TCP 成功仅代表端口可达；Ping 失败可能是 ICMP 被禁，不能证明服务不可达。10 秒无数据只作提醒，静态 / 低频话题可能正常。</p>
  <details id="diagnostic-details" open><summary>时间线 · 最近 160 条（UTC）</summary><pre id="diagnostic-log" tabindex="0"></pre></details>
  <div class="diagnostic-actions"><button id="diagnostic-copy" class="secondary">复制诊断</button><button id="diagnostic-export" class="secondary">导出文本</button><button id="diagnostic-clear" class="secondary">清空日志</button></div>
  <p id="diagnostic-feedback" role="status" class="diagnostic-note">地址中的凭据、查询参数值会隐藏。报告含服务器地址、名称和设备信息，分享前请检查。</p>
  <section id="diagnostic-export-box" hidden><label for="diagnostic-report">诊断报告（可长按全选复制）</label><textarea id="diagnostic-report" readonly rows="8" spellcheck="false"></textarea><button id="diagnostic-download" class="secondary">下载 .txt（浏览器）</button></section>
</dialog>`;

type NativeCheck = {
  status: string;
  code?: string;
  port?: number;
  addressCount?: number;
  testedAddressCount?: number;
  attempts?: {
    address: string;
    port?: number;
    status: string;
    code: string;
    durationMs?: number;
    message: string;
  }[];
  durationMs?: number;
  addresses?: string[];
  address?: string;
  message?: string;
};
type NativeResult = {
  requestId: string;
  target: string;
  status: string;
  startedAt?: unknown;
  completedAt?: unknown;
  dns?: NativeCheck;
  tcp?: NativeCheck;
  ping?: NativeCheck;
  device?: {
    appVersion?: string;
    androidVersion?: string;
    webViewVersion?: string;
    androidApi?: string;
    manufacturer?: string;
    model?: string;
  };
  console?: { time: string; level: string; message: string }[];
  message?: string;
};
type NativeBridge = {
  requestNetworkDiagnostics: (url: string, requestId: string) => void;
};
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const stamp = (n?: number) =>
  n === undefined ? "未收到" : new Date(n).toISOString();
const since = (n?: number) =>
  n === undefined
    ? "尚未收到"
    : `${Math.max(0, Math.floor((Date.now() - n) / 1000))} 秒前 (${stamp(n)})`;

export class DiagnosticPanel {
  private pendingId?: string;
  private timeout?: ReturnType<typeof setTimeout>;
  private result?: NativeResult;
  private nativeMessage = "";
  private sequence = 0;
  private lastLogText = "";
  constructor(
    private client: RosConnection,
    private actions: { retry: () => void; stop: () => void },
  ) {
    element("diagnostics-open").onclick = () => this.open();
    element("diagnostic-close").onclick = () =>
      element<HTMLDialogElement>("diagnostics-dialog").close();
    element("diagnostic-retry").onclick = () => {
      this.actions.retry();
      this.refresh();
    };
    element("diagnostic-stop").onclick = () => {
      this.actions.stop();
      this.refresh();
    };
    element("diagnostic-clear").onclick = () => {
      this.client.clearDiagnostics();
      this.refresh();
    };
    element("diagnostic-copy").onclick = () => {
      void this.copy();
    };
    element("diagnostic-export").onclick = () => this.exportText();
    element("diagnostic-download").onclick = () => this.download();
    element("network-probe").onclick = () => this.probe();
    const cancelProbe = () => {
      if (!this.pendingId) return;
      this.pendingId = undefined;
      clearTimeout(this.timeout);
      this.nativeMessage =
        "应用进入后台，网络检测已取消。返回后可再次点击检测。";
      this.client.addDiagnostic("network.cancel", this.nativeMessage);
      this.refresh();
    };
    window.addEventListener("androidlifecycle", (event) => {
      if ((event as CustomEvent).detail?.state === "pause") cancelProbe();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancelProbe();
    });
    window.addEventListener("androiddiagnosticsready", () => this.refresh());
    window.addEventListener("androidnetworkdiagnostics", (event) =>
      this.receive((event as CustomEvent).detail),
    );
  }
  get networkProbe() {
    return this.result ? JSON.parse(JSON.stringify(this.result)) : undefined;
  }
  open() {
    this.render();
    element<HTMLDialogElement>("diagnostics-dialog").showModal();
  }
  refresh() {
    if (
      !element<HTMLDialogElement>("diagnostics-dialog").open &&
      !this.pendingId
    )
      return;
    this.render();
  }
  private render() {
    const d = this.client.diagnostics;
    element("diagnostic-summary").textContent = connectionSummary(d);
    element("diagnostic-summary").dataset.phase = d.phase;
    const facts: [string, string][] = [
      ["本次连接目标", d.url || "尚未连接"],
      [
        "检测按钮目标",
        redactUrl(element<HTMLInputElement>("url").value.trim()),
      ],
      ["阶段 / 连接尝试", `${d.phase} / #${d.attempt} · ${stamp(d.attemptAt)}`],
      [
        "WebSocket / 子协议",
        `${stamp(d.openedAt)} / ${d.protocol || "尚未协商"}`,
      ],
      [
        "serverInfo",
        d.serverInfoAt
          ? `${d.serverName} · ${stamp(d.serverInfoAt)}`
          : "尚未收到",
      ],
      [
        "服务器能力（只读客户端）",
        d.capabilities?.join(", ") || "无 / 尚未提供",
      ],
      ["首次 advertise", stamp(d.firstAdvertiseAt)],
      [
        "话题数",
        `${d.advertised} 广告 / ${d.eligible} 可解析 / ${d.subscribed} 已订阅`,
      ],
      ["首帧二进制", stamp(d.firstBinaryAt)],
      ["最后任意消息", since(d.lastMessageAt)],
      [
        "最后订阅数据",
        `${since(d.lastDataAt)}${d.phase === "open" && d.lastDataAt && Date.now() - d.lastDataAt > STALE_AFTER_MS ? " · 数据未更新提醒" : ""}`,
      ],
      [
        "重试",
        d.retryAt
          ? `${Math.max(0, Math.ceil((d.retryAt - Date.now()) / 1000))} 秒后（退避 ${d.retryDelayMs! / 1000} 秒）`
          : "未安排",
      ],
      [
        "最后关闭事件",
        d.close
          ? `code=${d.close.code} · wasClean=${d.close.wasClean} · ${d.close.reason} · ${stamp(d.close.at)}`
          : "未收到（手动关闭见时间线）",
      ],
      ["最后错误", d.error || "无"],
      [
        "应用 / 设备",
        `Web v${APP_VERSION} · ${redactDiagnosticText(navigator.userAgent)}`,
      ],
    ];
    const list = element("diagnostic-facts");
    list.replaceChildren(
      ...facts.flatMap(([name, value]) => {
        const dt = document.createElement("dt");
        dt.textContent = name;
        const dd = document.createElement("dd");
        dd.textContent = value;
        return [dt, dd];
      }),
    );
    const logText = this.logText();
    if (logText !== this.lastLogText) {
      const log = element("diagnostic-log");
      const bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.textContent = logText || "暂无记录。点击连接或网络检测开始。";
      if (bottom) log.scrollTop = log.scrollHeight;
      this.lastLogText = logText;
    }
    const bridge = (window as Window & { AndroidDiagnostics?: NativeBridge })
      .AndroidDiagnostics;
    element<HTMLButtonElement>("network-probe").disabled = !!this.pendingId;
    element("network-probe").textContent = this.pendingId
      ? "正在检测…"
      : "检测 TCP / Ping";
    element("network-probe-result").textContent =
      this.nativeMessage ||
      (bridge
        ? "点击后由 Android 检测连接窗口中的主机及端口；只读，不扫描其它地址。"
        : "当前浏览器不能直接发起 TCP / ICMP 检测；请在 v0.1.1 Android 应用中使用此按钮。WebSocket 诊断仍可使用。");
  }
  private logText() {
    return this.client.diagnosticLog
      .map(
        (e) =>
          `${stamp(e.at)} #${e.attempt} [${e.level}] ${e.event} ${e.detail}`,
      )
      .join("\n");
  }
  private report() {
    return [
      `掌上 RViz 连接诊断 · v${APP_VERSION}`,
      `生成时间: ${new Date().toISOString()}`,
      `设备 UA: ${redactDiagnosticText(navigator.userAgent)}`,
      `页面源: ${location.origin}`,
      `连接摘要: ${connectionSummary(this.client.diagnostics)}`,
      "凭据及 URL 查询参数值已隐藏；报告仍含服务器地址和设备信息。",
      "浏览器无法给出 WebSocket 底层失败根因。TCP 成功不等于 Foxglove 握手成功，Ping 失败不等于 TCP 不可达。",
      "\n连接状态:\n" + JSON.stringify(this.client.diagnostics, null, 2),
      "\nAndroid 网络检测:\n" +
        (this.result
          ? JSON.stringify(this.result, null, 2)
          : this.nativeMessage || "尚未检测"),
      "\n时间线 (UTC):\n" + this.logText(),
    ].join("\n");
  }
  private exportText() {
    element("diagnostic-export-box").hidden = false;
    const text = element<HTMLTextAreaElement>("diagnostic-report");
    text.value = this.report();
    text.focus();
    text.select();
    element("diagnostic-feedback").textContent =
      "已生成脱敏文本。可长按全选复制；普通浏览器也可下载 .txt。";
  }
  private async copy() {
    const text = this.report();
    try {
      if (!navigator.clipboard?.writeText)
        throw Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      element("diagnostic-feedback").textContent =
        "诊断已复制。报告含服务器地址和设备信息，分享前请检查。";
    } catch {
      this.exportText();
      try {
        if (!document.execCommand("copy")) throw Error("Copy unavailable");
        element("diagnostic-feedback").textContent = "诊断已复制。";
      } catch {
        element("diagnostic-feedback").textContent =
          "系统未允许自动复制。已选中文本，请长按复制。";
      }
    }
  }
  private download() {
    const url = URL.createObjectURL(
      new Blob([this.report()], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `ros-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
    element("diagnostic-feedback").textContent =
      "已请求浏览器下载；如 Android 没有保存提示，请使用上方文本复制。";
  }
  private probe() {
    const bridge = (window as Window & { AndroidDiagnostics?: NativeBridge })
      .AndroidDiagnostics;
    if (!bridge) {
      this.nativeMessage =
        "此浏览器没有 Android 网络检测接口；网页无法直接 Ping 或打开 TCP socket。请使用 v0.1.1 Android 应用。";
      this.render();
      return;
    }
    let url: URL;
    try {
      url = validateSocketUrl(element<HTMLInputElement>("url").value.trim());
    } catch (e) {
      this.nativeMessage = e instanceof Error ? e.message : "地址无效";
      this.render();
      return;
    }
    const id = `probe-${Date.now()}-${++this.sequence}`;
    this.pendingId = id;
    this.result = undefined;
    this.nativeMessage = `正在检测 ${redactUrl(url.href)}。DNS、TCP、Ping 是不同检查。`;
    this.client.addDiagnostic(
      "network.request",
      `用户点击网络检测：${redactUrl(url.href)}`,
    );
    this.timeout = setTimeout(() => {
      if (this.pendingId !== id) return;
      this.pendingId = undefined;
      this.nativeMessage =
        "30 秒内没有收到完整的 Android 检测结果；原因未知，可重新检测。";
      this.client.addDiagnostic("network.timeout", this.nativeMessage, "warn");
      this.render();
    }, 30_000);
    try {
      // Native requires the exact endpoint captured from this trusted click.
      bridge.requestNetworkDiagnostics(
        element<HTMLInputElement>("url").value.trim(),
        id,
      );
    } catch (e) {
      clearTimeout(this.timeout);
      this.pendingId = undefined;
      this.nativeMessage =
        "无法启动 Android 网络检测：" + redactDiagnosticText(e);
      this.client.addDiagnostic("network.error", this.nativeMessage, "error");
    }
    this.render();
  }
  private receive(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const value = raw as Record<string, any>;
    if (!this.pendingId || value.requestId !== this.pendingId) return;
    if (!["running", "complete", "error"].includes(value.status)) return;
    const check = (value: any): NativeCheck | undefined =>
      value && typeof value === "object"
        ? {
            status: redactDiagnosticText(value.status),
            code: value.code ? redactDiagnosticText(value.code) : undefined,
            address: value.address
              ? redactDiagnosticText(value.address)
              : undefined,
            port: Number.isInteger(value.port) ? value.port : undefined,
            addressCount: Number.isInteger(value.addressCount)
              ? value.addressCount
              : undefined,
            testedAddressCount: Number.isInteger(value.testedAddressCount)
              ? value.testedAddressCount
              : undefined,
            attempts: Array.isArray(value.attempts)
              ? value.attempts.slice(0, 4).map((attempt: any) => ({
                  address: redactDiagnosticText(attempt?.address),
                  port: Number.isInteger(attempt?.port)
                    ? attempt.port
                    : undefined,
                  status: redactDiagnosticText(attempt?.status),
                  code: redactDiagnosticText(attempt?.code),
                  durationMs:
                    typeof attempt?.durationMs === "number" &&
                    Number.isFinite(attempt.durationMs)
                      ? attempt.durationMs
                      : undefined,
                  message: redactDiagnosticText(attempt?.message),
                }))
              : undefined,
            durationMs:
              typeof value.durationMs === "number" &&
              Number.isFinite(value.durationMs)
                ? value.durationMs
                : undefined,
            addresses: Array.isArray(value.addresses)
              ? value.addresses.slice(0, 8).map(redactDiagnosticText)
              : undefined,
            message: value.message
              ? redactDiagnosticText(value.message)
              : undefined,
          }
        : undefined;
    this.result = {
      requestId: this.pendingId,
      target: redactUrl(String(value.target ?? "")),
      status: value.status,
      startedAt: redactDiagnosticText(value.startedAt),
      completedAt: redactDiagnosticText(value.completedAt),
      dns: check(value.dns),
      tcp: check(value.tcp),
      ping: check(value.ping),
      device:
        value.device && typeof value.device === "object"
          ? {
              appVersion: redactDiagnosticText(value.device.appVersion),
              androidVersion: redactDiagnosticText(value.device.androidVersion),
              webViewVersion: redactDiagnosticText(value.device.webViewVersion),
              androidApi: redactDiagnosticText(value.device.androidApi),
              manufacturer: redactDiagnosticText(value.device.manufacturer),
              model: redactDiagnosticText(value.device.model),
            }
          : undefined,
      console: Array.isArray(value.console)
        ? value.console.slice(-40).map((entry: any) => ({
            time: redactDiagnosticText(entry?.time),
            level: redactDiagnosticText(entry?.level),
            message: redactDiagnosticText(entry?.message),
          }))
        : undefined,
      message: value.message ? redactDiagnosticText(value.message) : undefined,
    };
    const status = (key: "dns" | "tcp" | "ping") => {
      const c = this.result![key];
      return c
        ? `${key.toUpperCase()}: ${c.status}${c.code ? ` / ${c.code}` : ""}${c.durationMs === undefined ? "" : ` (${c.durationMs} ms)`}${c.address ? ` · ${c.address}` : ""}${c.addresses?.length ? ` · ${c.addresses.join(", ")}` : ""}${c.message ? ` · ${c.message}` : ""}${c.attempts?.length ? `\n  ${c.attempts.map((a) => `${a.address}:${a.port ?? "?"} ${a.status} ${a.code}`).join("; ")}` : ""}`
        : `${key.toUpperCase()}: 未执行`;
    };
    this.nativeMessage = [
      `目标 ${this.result.target}`,
      status("dns"),
      status("tcp"),
      status("ping"),
      this.result.message || "",
    ]
      .filter(Boolean)
      .join("\n");
    this.client.addDiagnostic(
      `network.${this.result.status}`,
      this.nativeMessage,
      this.result.status === "error" ? "error" : "info",
    );
    if (value.status !== "running") {
      this.pendingId = undefined;
      clearTimeout(this.timeout);
    }
    this.render();
  }
}
