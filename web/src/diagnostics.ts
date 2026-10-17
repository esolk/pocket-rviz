export const APP_VERSION = "0.1.1";
export const DIAGNOSTIC_LIMIT = 160;
export const STALE_AFTER_MS = 10_000;

/** Never put an unparsed URL or credentials into diagnostic output. */
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "redacted";
    }
    for (const key of new Set(url.searchParams.keys()))
      url.searchParams.set(key, "[redacted]");
    if (url.hash) url.hash = "[redacted]";
    return url.href;
  } catch {
    return "（无效 URL，原文已隐藏）";
  }
}

export function redactDiagnosticText(input: unknown): string {
  return String(input ?? "")
    .replace(
      /\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9_+./=:-]+/gi, "[redacted]")
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, redactUrl)
    .replace(
      /\b((?:access[_-]?|refresh[_-]?)?token|api[_-]?key|password|authorization|secret)(\s*[:=]\s*)[^\s,;]+/gi,
      "$1$2[redacted]",
    )
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, 1200);
}

export function validateSocketUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw Error("地址无效，请输入完整的 ws:// 或 wss:// 地址");
  }
  if (!["ws:", "wss:"].includes(url.protocol))
    throw Error("请输入 ws:// 或 wss:// 地址");
  if (url.username || url.password) throw Error("不支持 URL 中携带凭据");
  if (url.hash) throw Error("WebSocket 地址不能包含 # 片段");
  return url;
}

export type DiagnosticEntry = {
  at: number;
  attempt: number;
  level: "info" | "warn" | "error";
  event: string;
  detail: string;
};
export type ConnectionDiagnostics = {
  url: string;
  phase: "idle" | "opening" | "open" | "closed" | "error" | "paused";
  attempt: number;
  attemptAt?: number;
  openedAt?: number;
  protocol?: string;
  serverInfoAt?: number;
  serverName?: string;
  capabilities?: string[];
  firstAdvertiseAt?: number;
  firstBinaryAt?: number;
  lastMessageAt?: number;
  lastDataAt?: number;
  advertised: number;
  eligible: number;
  subscribed: number;
  diagnosticOnly?: boolean;
  close?: { at: number; code: number; reason: string; wasClean: boolean };
  error?: string;
  retryAt?: number;
  retryDelayMs?: number;
};

export function connectionSummary(
  d: ConnectionDiagnostics,
  now = Date.now(),
): string {
  if (d.phase === "idle") return "未连接。填写地址后连接，或单独运行网络检测。";
  if (d.phase === "paused")
    return "应用在后台，连接已暂停；回到前台后重新连接。";
  if (d.phase === "opening")
    return "正在建立 WebSocket 连接，尚未收到握手成功通知。";
  if (d.phase === "closed" || d.phase === "error") {
    const retry = d.retryAt
      ? `；${Math.max(0, Math.ceil((d.retryAt - now) / 1000))} 秒后重试`
      : "";
    return `${d.openedAt ? "WebSocket 连接已关闭" : "WebSocket 未建立成功"}${retry}。查看关闭码和日志；零话题不是断网证据。`;
  }
  if (!d.serverInfoAt && !d.firstAdvertiseAt)
    return "WebSocket 已打开；等待 Foxglove serverInfo / advertise。尚不能确认服务端协议正常。";
  if (!d.firstAdvertiseAt)
    return "已收到 serverInfo；尚未收到话题广播。WebSocket 仍打开，请检查 bridge 的 ROS master、话题过滤与发布节点。";
  if (!d.advertised)
    return "已收到空话题列表（0 个）。WebSocket 仍打开，请检查 ROS master、话题过滤与发布节点。";
  if (!d.eligible)
    return `已发现 ${d.advertised} 个话题，但没有可解析的 ROS1 schema。请检查编码与 schema。`;
  if (!d.subscribed && d.diagnosticOnly)
    return `发现 ${d.advertised} 个话题，其中 ${d.eligible} 个可解析。当前为网络诊断模式，不订阅数据；三维视图不可用。`;
  if (!d.subscribed)
    return `发现 ${d.advertised} 个话题，其中 ${d.eligible} 个可解析；尚未订阅，请在图层中勾选。`;
  if (!d.lastDataAt)
    return `已订阅 ${d.subscribed} 个话题，等待第一条订阅数据；发布频率可能为零或仅锁存。`;
  if (now - d.lastDataAt > STALE_AFTER_MS)
    return `已订阅 ${d.subscribed} 个话题；${Math.floor((now - d.lastDataAt) / 1000)} 秒未收到订阅数据。低频/静态话题可能正常，不能据此判定断网。`;
  return `已连接：${d.advertised} 个话题 / ${d.eligible} 个可解析 / ${d.subscribed} 个已订阅，正在接收数据。`;
}
