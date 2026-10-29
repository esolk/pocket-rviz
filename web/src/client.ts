import { FoxgloveClient, type Channel } from "@foxglove/ws-protocol";
import { parse } from "@foxglove/rosmsg";
import { topicKey } from "./display-settings";
import { SafeMessageReader as MessageReader } from "./reader";
import {
  DIAGNOSTIC_LIMIT,
  redactDiagnosticText,
  redactUrl,
  validateSocketUrl,
  type ConnectionDiagnostics,
  type DiagnosticEntry,
} from "./diagnostics";
export type Topic = Channel & {
  enabled: boolean;
  supported: boolean;
  error?: string;
  received: number;
  bytes: number;
  lastAt: number;
  subscription?: number;
  reader?: MessageReader;
};
export type Packet = {
  topic: Topic;
  message: any;
  time: bigint;
  size?: number;
};
export const visualTypes = new Set([
  "sensor_msgs/PointCloud2",
  "sensor_msgs/LaserScan",
  "nav_msgs/OccupancyGrid",
  "nav_msgs/Path",
  "nav_msgs/Odometry",
  "geometry_msgs/PoseStamped",
  "visualization_msgs/Marker",
  "visualization_msgs/MarkerArray",
  "sensor_msgs/Image",
  "sensor_msgs/CompressedImage",
  "tf2_msgs/TFMessage",
  "tf/tfMessage",
]);
export const isTF = (t: Topic) =>
  t.schemaName === "tf2_msgs/TFMessage" || t.schemaName === "tf/tfMessage";
/** Read-only facade: the only outbound protocol operations are subscribe/unsubscribe. */
export class RosConnection {
  topics = new Map<number, Topic>();
  state = "未连接";
  bytesReceived = 0;
  autoSubscribe = true;
  /** Optional app policy. No preference means the existing auto-selection policy. */
  selectionForTopic?: (topic: Topic) => boolean | undefined;
  private client?: FoxgloveClient;
  private socket?: WebSocket;
  private bySubscription = new Map<number, Topic>();
  private pending = new Map<
    number,
    { data: ArrayBufferView; timestamp: bigint }
  >();
  private generation = 0;
  private wanted = false;
  private url = "";
  private retry = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private openTimer?: ReturnType<typeof setTimeout>;
  private remembered = new Map<string, boolean>();
  private autoKinds = new Set<string>();
  private diagnostic: ConnectionDiagnostics = {
    url: "",
    phase: "idle",
    attempt: 0,
    advertised: 0,
    eligible: 0,
    subscribed: 0,
  };
  private secrets = new Set<string>();
  readonly diagnosticLog: DiagnosticEntry[] = [];
  onDiagnostics = () => {};
  get diagnostics(): ConnectionDiagnostics {
    return {
      ...this.diagnostic,
      diagnosticOnly: !this.autoSubscribe,
      capabilities: this.diagnostic.capabilities?.slice(),
      close: this.diagnostic.close ? { ...this.diagnostic.close } : undefined,
    };
  }
  private sanitize(text: unknown): string {
    let result = String(text ?? "");
    for (const secret of this.secrets)
      if (secret) result = result.split(secret).join("[redacted]");
    return redactDiagnosticText(result);
  }
  addDiagnostic(
    event: string,
    detail: unknown,
    level: DiagnosticEntry["level"] = "info",
  ) {
    this.diagnosticLog.push({
      at: Date.now(),
      attempt: this.diagnostic.attempt,
      level,
      event: this.sanitize(event),
      detail: this.sanitize(detail),
    });
    if (this.diagnosticLog.length > DIAGNOSTIC_LIMIT)
      this.diagnosticLog.splice(
        0,
        this.diagnosticLog.length - DIAGNOSTIC_LIMIT,
      );
    this.onDiagnostics();
  }
  clearDiagnostics() {
    this.diagnosticLog.length = 0;
    this.addDiagnostic("log.clear", "日志已清空；连接摘要保留");
  }
  private updateCounts() {
    this.diagnostic.advertised = this.topics.size;
    this.diagnostic.eligible = [...this.topics.values()].filter(
      (t) => !!t.reader,
    ).length;
    this.diagnostic.subscribed = this.bySubscription.size;
    this.onDiagnostics();
  }
  private scheduleRetry() {
    if (!this.wanted) return;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.retry++, 4));
    this.diagnostic.retryAt = Date.now() + delay;
    this.diagnostic.retryDelayMs = delay;
    this.status(
      `${this.diagnostic.openedAt ? "连接中断" : "连接失败"} · ${delay / 1000}秒后重试`,
    );
    this.addDiagnostic("retry.scheduled", `${delay} ms 后重试`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
  onTopics = () => {};
  onState = (_state: string) => {};
  onPacket = (_packet: Packet) => {};
  onReset = () => {};
  onClock = (_time: bigint) => {};
  onError = (_error: string) => {};
  constructor(
    private socketFactory = (url: string) =>
      new WebSocket(url, [FoxgloveClient.SUPPORTED_SUBPROTOCOL]),
  ) {}
  connect(url: string) {
    let u: URL;
    try {
      const parsed = new URL(url.trim());
      for (const value of [
        parsed.username,
        parsed.password,
        ...parsed.searchParams.values(),
        parsed.hash.slice(1),
      ]) {
        if (value) this.secrets.add(value);
      }
      u = validateSocketUrl(url);
    } catch (e) {
      this.addDiagnostic(
        "url.invalid",
        e instanceof Error && !(e instanceof TypeError)
          ? e.message
          : "地址无效，原始输入已隐藏",
        "error",
      );
      throw e instanceof TypeError
        ? Error("地址无效，请输入完整的 ws:// 或 wss:// 地址")
        : e;
    }
    this.disconnect();
    this.url = u.href;
    this.diagnostic.url = redactUrl(u.href);
    this.wanted = true;
    this.retry = 0;
    this.remembered.clear();
    this.addDiagnostic(
      "url.valid",
      `URL 格式有效：${redactUrl(u.href)} （尚未验证网络）`,
    );
    this.open();
  }
  private status(s: string) {
    this.state = s;
    this.onState(s);
  }
  private open() {
    if (!this.wanted) return;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimer);
    const gen = ++this.generation;
    this.diagnostic = {
      url: redactUrl(this.url),
      phase: "opening",
      attempt: this.diagnostic.attempt + 1,
      attemptAt: Date.now(),
      advertised: 0,
      eligible: 0,
      subscribed: 0,
    };
    this.topics.clear();
    this.bySubscription.clear();
    this.pending.clear();
    this.autoKinds.clear();
    this.bytesReceived = 0;
    this.onReset();
    this.onTopics();
    this.status(this.retry ? "正在重连…" : "正在连接…");
    this.addDiagnostic(
      "ws.opening",
      `第 ${this.diagnostic.attempt} 次连接：${redactUrl(this.url)} ；请求子协议 ${FoxgloveClient.SUPPORTED_SUBPROTOCOL}`,
    );
    let ws: WebSocket;
    try {
      ws = this.socketFactory(this.url);
    } catch (e) {
      this.diagnostic.phase = "error";
      this.diagnostic.error = this.sanitize(e instanceof Error ? e.message : e);
      this.addDiagnostic(
        "ws.constructor.error",
        this.diagnostic.error,
        "error",
      );
      this.onError(this.diagnostic.error);
      this.scheduleRetry();
      return;
    }
    this.socket = ws;
    const client = new FoxgloveClient({ ws });
    this.client = client;
    const current = () => gen === this.generation;
    const handleMessage = ws.onmessage;
    ws.onmessage = (event) => {
      if (!current()) return;
      this.diagnostic.lastMessageAt = Date.now();
      if (
        (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) &&
        !this.diagnostic.firstBinaryAt
      ) {
        this.diagnostic.firstBinaryAt = Date.now();
        this.addDiagnostic(
          "binary.first",
          `收到第一帧二进制：${event.data.byteLength} bytes（不等于已解码的订阅数据）`,
        );
      }
      try {
        handleMessage?.call(ws, event);
      } catch (e) {
        this.diagnostic.error = this.sanitize(
          e instanceof Error ? e.message : e,
        );
        this.addDiagnostic("protocol.error", this.diagnostic.error, "error");
        this.onError(`协议消息异常：${this.diagnostic.error}`);
      }
    };
    this.openTimer = setTimeout(() => {
      if (current() && this.diagnostic.phase === "opening") {
        this.diagnostic.error = "10 秒内未完成 WebSocket 握手";
        this.addDiagnostic("ws.timeout", this.diagnostic.error, "warn");
        this.onError(
          "WebSocket 握手超时；尚不能确认是网络、端口还是服务端问题",
        );
        ws.close();
      }
    }, 10000);
    client.on("open", () => {
      if (!current()) return;
      clearTimeout(this.openTimer);
      this.diagnostic.phase = "open";
      this.diagnostic.openedAt = Date.now();
      this.diagnostic.protocol = ws.protocol || "（未协商）";
      this.status("已连接");
      this.addDiagnostic(
        "ws.open",
        `握手成功；协商子协议：${this.diagnostic.protocol}`,
      );
      if (ws.protocol !== FoxgloveClient.SUPPORTED_SUBPROTOCOL)
        this.addDiagnostic(
          "ws.subprotocol",
          `期望 ${FoxgloveClient.SUPPORTED_SUBPROTOCOL}；请检查 bridge 的 Foxglove 协议支持`,
          "warn",
        );
    });
    client.on("serverInfo", (info) => {
      if (!current()) return;
      this.diagnostic.serverInfoAt = Date.now();
      this.diagnostic.serverName = this.sanitize(info.name || "（未提供名称）");
      this.diagnostic.capabilities = Array.isArray(info.capabilities)
        ? info.capabilities.slice(0, 64).map((c) => this.sanitize(c))
        : [];
      this.addDiagnostic(
        "serverInfo",
        `${this.diagnostic.serverName}；能力：${this.diagnostic.capabilities.join(", ") || "无 / 未提供"}；客户端始终只读`,
      );
    });
    client.on("status", (s) => {
      if (current()) {
        this.addDiagnostic(
          "server.status",
          `level=${s.level} ${s.message}`,
          "warn",
        );
        this.onError(`服务器: ${this.sanitize(s.message)}`);
      }
    });
    client.on("time", (s) => {
      if (current()) this.onClock(s.timestamp);
    });
    client.on("error", (e) => {
      if (!current()) return;
      this.diagnostic.error =
        e.message === "WebSocket error"
          ? "浏览器报告 WebSocket error；未暴露 HTTP 状态、DNS/TCP/TLS 根因。请查看关闭事件并运行网络检测。"
          : this.sanitize(e.message);
      this.addDiagnostic("ws.error", this.diagnostic.error, "error");
      this.onError(this.diagnostic.error);
    });
    client.on("close", (event) => {
      if (!current() || this.diagnostic.phase === "closed") return;
      clearTimeout(this.openTimer);
      this.pending.clear();
      this.bySubscription.clear();
      for (const t of this.topics.values()) t.subscription = undefined;
      this.diagnostic.phase = "closed";
      this.diagnostic.subscribed = 0;
      this.diagnostic.close = {
        at: Date.now(),
        code: event.code,
        reason: this.sanitize(event.reason || "（服务端未提供）"),
        wasClean: event.wasClean === true,
      };
      this.addDiagnostic(
        "ws.close",
        `code=${event.code} reason=${this.diagnostic.close.reason} wasClean=${this.diagnostic.close.wasClean}；${this.diagnostic.openedAt ? "握手后关闭" : "握手未完成"}`,
        "warn",
      );
      if (
        this.diagnostic.openedAt &&
        Date.now() - this.diagnostic.openedAt >= 10_000
      )
        this.retry = 0;
      if (this.wanted) this.scheduleRetry();
      else this.status("已断开");
    });
    client.on("advertise", (channels) => {
      if (!current()) return;
      if (!Array.isArray(channels))
        throw Error("advertise.channels 必须为数组");
      if (!this.diagnostic.firstAdvertiseAt) {
        this.diagnostic.firstAdvertiseAt = Date.now();
        this.addDiagnostic(
          "advertise.first",
          `首次话题广播：${channels.length} 个频道${channels.length === 0 ? "（空列表，非网络失败）" : ""}`,
        );
      }
      for (const c of channels) {
        if (this.topics.size >= 256 && !this.topics.has(c.id)) {
          this.onError("频道上限 256；请在 bridge 过滤不需要的 topic");
          break;
        }
        const previous = this.topics.get(c.id);
        if (previous) this.disable(previous);
        const topic: Topic = {
          ...c,
          enabled: false,
          supported: visualTypes.has(c.schemaName),
          received: 0,
          bytes: 0,
          lastAt: 0,
        };
        try {
          if (c.encoding !== "ros1")
            throw Error(`仅支持 ROS1，收到 ${c.encoding}`);
          if (c.schemaEncoding && c.schemaEncoding !== "ros1msg")
            throw Error(`不支持 schemaEncoding: ${c.schemaEncoding}`);
          if (!c.schema || c.schema.length > 2_000_000)
            throw Error("消息 schema 缺失或超限");
          topic.reader = new MessageReader(parse(c.schema));
        } catch (e) {
          topic.error = String(e);
        }
        this.topics.set(c.id, topic);
        const auto =
          this.autoSubscribe &&
          (isTF(topic) ||
            (!this.autoKinds.has(c.schemaName) &&
              topic.supported &&
              this.autoKinds.size < 10));
        const enabled =
          this.remembered.get(topicKey(c.topic, c.schemaName)) ??
          this.selectionForTopic?.(topic) ??
          auto;
        if (enabled && topic.reader) {
          this.autoKinds.add(c.schemaName);
          this.enable(topic);
        }
      }
      this.updateCounts();
      this.addDiagnostic(
        "topics.count",
        `广告 ${this.diagnostic.advertised} / 可解析 ${this.diagnostic.eligible} / 已订阅 ${this.diagnostic.subscribed}`,
      );
      this.onTopics();
    });
    client.on("unadvertise", (ids) => {
      if (!current()) return;
      for (const id of ids) {
        const t = this.topics.get(id);
        if (t) this.disable(t);
        this.topics.delete(id);
      }
      this.updateCounts();
      this.addDiagnostic(
        "unadvertise",
        `移除 ${ids.length} 个频道；剩余 ${this.topics.size}`,
      );
      this.onTopics();
    });
    client.on("message", (event) => {
      if (!current()) return;
      const t = this.bySubscription.get(event.subscriptionId);
      if (!t || !t.enabled) return;
      const firstData = !this.diagnostic.lastDataAt;
      this.diagnostic.lastDataAt = Date.now();
      if (firstData)
        this.addDiagnostic(
          "data.first",
          `收到第一条已订阅话题数据：${t.topic}；${event.data.byteLength} bytes`,
        );
      t.received++;
      t.bytes += event.data.byteLength;
      t.lastAt = performance.now();
      this.bytesReceived += event.data.byteLength;
      if (event.data.byteLength > 32 * 1024 * 1024) {
        t.error = "消息大于 32 MiB，已跳过";
        return;
      }
      if (isTF(t) || t.schemaName.startsWith("visualization_msgs/"))
        this.decode(t, event.data, event.timestamp); // Preserve marker actions and static TF fragments.
      else {
        this.pending.delete(t.id);
        this.pending.set(t.id, event);
        let total = 0;
        for (const p of this.pending.values()) total += p.data.byteLength;
        while (total > 64 * 1024 * 1024 && this.pending.size) {
          const key = this.pending.keys().next().value!;
          total -= this.pending.get(key)!.data.byteLength;
          this.pending.delete(key);
        }
      }
    });
  }
  private decode(t: Topic, data: ArrayBufferView, time: bigint) {
    try {
      const message = t.reader!.readMessage(data);
      t.error = undefined;
      this.onPacket({ topic: t, message, time, size: data.byteLength });
    } catch (e) {
      t.error = `解码失败: ${String(e).slice(0, 160)}`;
    }
  }
  discardPending() {
    this.pending.clear();
  }
  flush() {
    for (const [id, p] of this.pending) {
      const t = this.topics.get(id);
      if (t?.enabled) this.decode(t, p.data, p.timestamp);
    }
    this.pending.clear();
  }
  toggle(id: number, enabled: boolean) {
    const t = this.topics.get(id);
    if (!t) return;
    const key = topicKey(t.topic, t.schemaName);
    this.remembered.delete(key);
    this.remembered.set(key, enabled);
    while (this.remembered.size > 256)
      this.remembered.delete(this.remembered.keys().next().value!);
    enabled ? this.enable(t) : this.disable(t);
    this.updateCounts();
    this.addDiagnostic(
      "subscription.change",
      `${t.topic}：${enabled ? "请求订阅" : "取消订阅"}；当前 ${this.bySubscription.size} 个订阅`,
    );
    this.onTopics();
  }
  private enable(t: Topic) {
    if (!t.reader || t.enabled || !this.client || this.socket?.readyState !== 1)
      return;
    if (this.bySubscription.size >= 32) {
      t.error = "最多同时订阅 32 个 topic";
      return;
    }
    if (t.error === "最多同时订阅 32 个 topic") t.error = undefined;
    t.subscription = this.client.subscribe(t.id);
    t.enabled = true;
    this.bySubscription.set(t.subscription, t);
  }
  private disable(t: Topic) {
    if (t.subscription !== undefined) {
      if (this.socket?.readyState === 1)
        this.client?.unsubscribe(t.subscription);
      this.bySubscription.delete(t.subscription);
    }
    t.enabled = false;
    t.subscription = undefined;
    this.pending.delete(t.id);
  }
  disconnect() {
    this.wanted = false;
    ++this.generation;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimer);
    const wasActive = this.socket || this.reconnectTimer;
    this.client?.close();
    this.reconnectTimer = undefined;
    this.client = undefined;
    this.socket = undefined;
    this.pending.clear();
    this.bySubscription.clear();
    for (const t of this.topics.values()) {
      t.enabled = false;
      t.subscription = undefined;
    }
    this.diagnostic.phase = "idle";
    this.diagnostic.subscribed = 0;
    this.diagnostic.retryAt = undefined;
    this.diagnostic.retryDelayMs = undefined;
    if (wasActive)
      this.addDiagnostic(
        "disconnect.manual",
        "已停止连接与自动重试；历史诊断保留",
      );
    this.status("未连接");
    this.onDiagnostics();
  }
  suspend() {
    if (!this.wanted) return;
    this.disconnect();
    this.diagnostic.phase = "paused";
    this.addDiagnostic("lifecycle.pause", "进入后台；主动断开，等待前台恢复");
    this.status("后台已暂停");
  }
  resume() {
    if (
      this.url &&
      this.socket?.readyState !== 0 &&
      this.socket?.readyState !== 1
    ) {
      this.wanted = true;
      this.retry = 0;
      this.open();
    }
  }
}
