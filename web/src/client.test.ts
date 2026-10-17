import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { RosConnection } from "./client";
import {
  connectionSummary,
  DIAGNOSTIC_LIMIT,
  redactDiagnosticText,
  redactUrl,
  validateSocketUrl,
} from "./diagnostics";
class FakeSocket {
  readyState = 0;
  binaryType = "";
  protocol = "foxglove.websocket.v1";
  onopen: any;
  onclose: any;
  onmessage: any;
  onerror: any;
  sent: any[] = [];
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  json(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  binary(sub: number, value: number, time = 123n) {
    const data = new ArrayBuffer(17),
      v = new DataView(data);
    v.setUint8(0, 1);
    v.setUint32(1, sub, true);
    v.setBigUint64(5, time, true);
    v.setUint32(13, value, true);
    this.onmessage?.({ data });
  }
}
const channel = (
  id = 1,
  type = "sensor_msgs/PointCloud2",
  encoding = "ros1",
) => ({
  id,
  topic: "/fixture" + id,
  schemaName: type,
  encoding,
  schema: "uint32 value",
});
describe("read-only Foxglove ROS1 connection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function setup() {
    const sockets: FakeSocket[] = [];
    const client = new RosConnection(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const packets: any[] = [];
    client.onPacket = (p) => packets.push(p);
    client.connect("ws://localhost:8765");
    sockets[0].open();
    return { client, sockets, ws: sockets[0], packets };
  }
  it("subscribes advertised ROS1 channels and decodes the actual binary envelope", () => {
    const { client, ws, packets } = setup();
    ws.json({ op: "advertise", channels: [channel()] });
    expect(ws.binaryType).toBe("arraybuffer");
    expect(ws.sent).toEqual([
      { op: "subscribe", subscriptions: [{ id: 0, channelId: 1 }] },
    ]);
    ws.binary(0, 42, 1234567890123n);
    expect(packets).toHaveLength(0);
    client.flush();
    expect(packets[0].message.value).toBe(42);
    expect(packets[0].time).toBe(1234567890123n);
    expect(client.bytesReceived).toBe(4);
  });
  it("coalesces bounded latest display packets", () => {
    const { client, ws, packets } = setup();
    ws.json({ op: "advertise", channels: [channel()] });
    ws.binary(0, 1);
    ws.binary(0, 2);
    client.flush();
    expect(packets).toHaveLength(1);
    expect(packets[0].message.value).toBe(2);
    expect(client.topics.get(1)?.received).toBe(2);
  });
  it("never coalesces TF fragments or Marker actions", () => {
    const { ws, packets } = setup();
    ws.json({
      op: "advertise",
      channels: [
        channel(1, "tf2_msgs/TFMessage"),
        channel(2, "visualization_msgs/Marker"),
      ],
    });
    ws.binary(0, 1);
    ws.binary(0, 2);
    ws.binary(1, 3);
    ws.binary(1, 4);
    expect(packets.map((p) => p.message.value)).toEqual([1, 2, 3, 4]);
  });
  it("unsubscribes and does not process stale subscription messages", () => {
    const { client, ws, packets } = setup();
    ws.json({ op: "advertise", channels: [channel()] });
    client.toggle(1, false);
    ws.binary(0, 3);
    client.flush();
    expect(packets).toHaveLength(0);
    expect(ws.sent[1]).toEqual({ op: "unsubscribe", subscriptionIds: [0] });
    client.toggle(1, true);
    expect(ws.sent[2]).toEqual({
      op: "subscribe",
      subscriptions: [{ id: 1, channelId: 1 }],
    });
  });
  it("reports incompatible encodings without pretending to connect topic data", () => {
    const { client, ws } = setup();
    ws.json({
      op: "advertise",
      channels: [channel(1, "sensor_msgs/PointCloud2", "cdr")],
    });
    expect(client.topics.get(1)?.error).toContain("仅支持 ROS1");
    expect(ws.sent).toHaveLength(0);
  });
  it("allows explicit generic message inspection subscriptions", () => {
    const { client, ws, packets } = setup();
    ws.json({ op: "advertise", channels: [channel(1, "custom/Status")] });
    expect(ws.sent).toHaveLength(0);
    client.toggle(1, true);
    ws.binary(0, 88);
    client.flush();
    expect(packets[0].message.value).toBe(88);
  });
  it("removes unadvertised topics", () => {
    const { client, ws } = setup();
    ws.json({ op: "advertise", channels: [channel()] });
    ws.json({ op: "unadvertise", channelIds: [1] });
    expect(client.topics.size).toBe(0);
    expect(ws.sent[1].op).toBe("unsubscribe");
  });
  it("reconnects after transport loss and rebuilds subscriptions", () => {
    const { client, sockets, ws } = setup();
    ws.json({ op: "advertise", channels: [channel()] });
    ws.close();
    expect(client.state).toContain("重试");
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(2);
    expect(client.topics.size).toBe(0);
    sockets[1].open();
    sockets[1].json({ op: "advertise", channels: [channel()] });
    expect(sockets[1].sent[0].op).toBe("subscribe");
  });
  it("manual disconnect cancels reconnect and ignores old callbacks", () => {
    const { client, sockets, ws } = setup();
    client.disconnect();
    ws.json({ op: "advertise", channels: [channel()] });
    vi.advanceTimersByTime(60000);
    expect(sockets.length).toBe(1);
    expect(client.topics.size).toBe(0);
    expect(client.state).toBe("未连接");
  });
  it("only emits subscribe and unsubscribe operations", () => {
    const { client, ws } = setup();
    ws.json({
      op: "serverInfo",
      name: "fixture",
      capabilities: ["clientPublish", "services", "parameters"],
    });
    ws.json({ op: "advertise", channels: [channel()] });
    client.toggle(1, false);
    expect(
      ws.sent.every((x) => ["subscribe", "unsubscribe"].includes(x.op)),
    ).toBe(true);
  });
  it("rejects other URL protocols and embedded credentials", () => {
    const c = new RosConnection();
    expect(() => c.connect("https://robot")).toThrow();
    expect(() => c.connect("ws://user:secret@robot")).toThrow();
  });
  it("keeps serverInfo without advertise separate from network failure", () => {
    const { client, ws, sockets } = setup();
    ws.json({ op: "serverInfo", name: "robot-bridge", capabilities: ["time"] });
    vi.advanceTimersByTime(30000);
    expect(client.diagnostics.phase).toBe("open");
    expect(client.diagnostics.protocol).toBe("foxglove.websocket.v1");
    expect(client.diagnostics.serverName).toBe("robot-bridge");
    expect(client.diagnostics.firstAdvertiseAt).toBeUndefined();
    expect(connectionSummary(client.diagnostics)).toContain("尚未收到话题广播");
    expect(sockets).toHaveLength(1);
  });
  it("does not turn an open socket waiting for serverInfo into a transport timeout", () => {
    const { client, sockets } = setup();
    vi.advanceTimersByTime(30000);
    expect(client.diagnostics.phase).toBe("open");
    expect(connectionSummary(client.diagnostics)).toContain("等待 Foxglove");
    expect(sockets).toHaveLength(1);
  });
  it("records a normal zero-topic advertise without reconnecting", () => {
    const { client, ws, sockets } = setup();
    ws.json({ op: "advertise", channels: [] });
    vi.advanceTimersByTime(30000);
    expect(client.diagnostics.firstAdvertiseAt).toBeDefined();
    expect(client.diagnostics.advertised).toBe(0);
    expect(connectionSummary(client.diagnostics)).toContain("空话题列表");
    expect(client.diagnostics.phase).toBe("open");
    expect(sockets).toHaveLength(1);
  });
  it("retains handshake interruption evidence and schedules one retry", () => {
    const socket = new FakeSocket();
    const client = new RosConnection(() => socket as unknown as WebSocket);
    client.connect("ws://robot:8765");
    socket.onerror?.({});
    socket.readyState = 3;
    socket.onclose?.({ code: 1006, reason: "", wasClean: false });
    expect(client.state).toContain("连接失败");
    expect(client.diagnostics.openedAt).toBeUndefined();
    expect(client.diagnostics.close?.code).toBe(1006);
    expect(client.diagnostics.error).toContain("未暴露");
    expect(client.diagnostics.retryDelayMs).toBe(1000);
    expect(
      client.diagnosticLog.some(
        (e) => e.event === "ws.close" && e.detail.includes("握手未完成"),
      ),
    ).toBe(true);
    client.disconnect();
  });
  it("preserves close code, clean flag and sanitized server reason", () => {
    const { client, ws } = setup();
    ws.onclose?.({
      code: 1008,
      reason: "token=secret password=hidden Authorization: Bearer credential",
      wasClean: true,
    });
    expect(client.diagnostics.close).toMatchObject({
      code: 1008,
      wasClean: true,
    });
    const evidence = JSON.stringify([client.diagnostics, client.diagnosticLog]);
    expect(evidence).not.toContain("secret");
    expect(evidence).not.toContain("hidden");
    expect(evidence).not.toContain("credential");
    expect(evidence).toContain("[redacted]");
  });
  it("marks first binary and keeps any-message time distinct from subscribed data", () => {
    const { client, ws } = setup();
    ws.json({ op: "advertise", channels: [channel()] });
    ws.binary(0, 3);
    const dataAt = client.diagnostics.lastDataAt;
    vi.advanceTimersByTime(11000);
    ws.json({ op: "serverInfo", name: "bridge", capabilities: [] });
    expect(client.diagnostics.firstBinaryAt).toBeDefined();
    expect(client.diagnostics.lastDataAt).toBe(dataAt);
    expect(client.diagnostics.lastMessageAt).toBeGreaterThan(dataAt!);
    expect(connectionSummary(client.diagnostics)).toContain("不能据此判定断网");
    expect(client.diagnostics.phase).toBe("open");
  });
  it("backs off brief repeated handshakes rather than resetting every socket open", () => {
    const { client, ws, sockets } = setup();
    ws.close();
    vi.advanceTimersByTime(1000);
    sockets[1].open();
    sockets[1].close();
    expect(client.diagnostics.retryDelayMs).toBe(2000);
    vi.advanceTimersByTime(2000);
    sockets[2].open();
    sockets[2].close();
    expect(client.diagnostics.retryDelayMs).toBe(4000);
  });
  it("retries synchronous browser socket-constructor errors safely", () => {
    let attempts = 0;
    const client = new RosConnection(() => {
      attempts++;
      throw new Error("Browser policy rejected WebSocket");
    });
    expect(() => client.connect("ws://robot:8765")).not.toThrow();
    expect(client.diagnostics.phase).toBe("error");
    expect(client.diagnostics.retryDelayMs).toBe(1000);
    vi.advanceTimersByTime(1000);
    expect(attempts).toBe(2);
    client.disconnect();
    vi.advanceTimersByTime(30000);
    expect(attempts).toBe(2);
  });
  it("retains diagnostic history through scene resets, pause and reconnect", () => {
    const { client, ws, sockets } = setup();
    ws.json({ op: "serverInfo", name: "keep-me", capabilities: [] });
    client.suspend();
    expect(client.diagnostics.phase).toBe("paused");
    expect(client.diagnostics.serverName).toBe("keep-me");
    client.resume();
    client.resume();
    expect(sockets).toHaveLength(2);
    expect(
      client.diagnosticLog.some(
        (e) => e.event === "serverInfo" && e.detail.includes("keep-me"),
      ),
    ).toBe(true);
    expect(client.diagnostics.attempt).toBe(2);
  });
  it("bounds log entries and retains connection state when clearing logs", () => {
    const { client } = setup();
    for (let i = 0; i < 300; i++)
      client.addDiagnostic("test", "x".repeat(2000));
    expect(client.diagnosticLog).toHaveLength(DIAGNOSTIC_LIMIT);
    expect(client.diagnosticLog.every((e) => e.detail.length <= 1200)).toBe(
      true,
    );
    client.clearDiagnostics();
    expect(client.diagnosticLog).toHaveLength(1);
    expect(client.diagnostics.phase).toBe("open");
  });
  it("redacts every URL query value, userinfo and auth schemes", () => {
    const result = redactDiagnosticText(
      "Authorization: Basic YTpi Bearer unknown-token ws://name:pass@robot:8765/path?custom=secret&token=another#fragment",
    );
    for (const secret of [
      "YTpi",
      "unknown-token",
      "name:pass",
      "secret",
      "another",
      "fragment",
    ])
      expect(result).not.toContain(secret);
    expect(redactUrl("not a valid URL password123")).not.toContain(
      "password123",
    );
    expect(redactUrl("ws://robot?token=first&token=second")).not.toMatch(
      /first|second/,
    );
  });
  it("redacts known endpoint token echoed without a label in server text", () => {
    const socket = new FakeSocket();
    const client = new RosConnection(() => socket as unknown as WebSocket);
    client.connect("ws://robot?token=echoed-secret");
    socket.open();
    socket.json({
      op: "serverInfo",
      name: "echoed-secret denied",
      capabilities: [],
    });
    socket.onclose?.({
      code: 1008,
      reason: "echoed-secret denied",
      wasClean: true,
    });
    expect(
      JSON.stringify([client.diagnostics, client.diagnosticLog]),
    ).not.toContain("echoed-secret");
    client.disconnect();
  });
  it("rejects fragments and invalid input without disconnecting a healthy session", () => {
    const { client } = setup();
    expect(() => validateSocketUrl("ws://robot#bad")).toThrow();
    expect(() => client.connect("not-a-url-password-123")).toThrow();
    expect(client.diagnostics.phase).toBe("open");
    expect(JSON.stringify(client.diagnosticLog)).not.toContain("password-123");
  });
  it("supports a WebGL-unavailable diagnostic connection without auto subscriptions", () => {
    const { client, ws } = setup();
    client.autoSubscribe = false;
    ws.json({
      op: "advertise",
      channels: [channel(), channel(2, "tf2_msgs/TFMessage")],
    });
    expect(client.diagnostics).toMatchObject({
      phase: "open",
      advertised: 2,
      eligible: 2,
      subscribed: 0,
    });
    expect(ws.sent).toHaveLength(0);
    expect(connectionSummary(client.diagnostics)).toContain("网络诊断模式");
    expect(connectionSummary(client.diagnostics)).not.toContain("图层");
  });
});
