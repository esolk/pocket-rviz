import { describe, expect, it } from "vitest";
import {
  DisplayPreferences,
  defaultLayerSettings,
  normalizeLayerSettings,
  serverKey,
  topicKey,
} from "./display-settings";
const type = "sensor_msgs/PointCloud2";
function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
}
describe("bounded local display preferences", () => {
  it("normalizes hostile and nonfinite settings without invalid rendering values", () => {
    expect(
      normalizeLayerSettings(
        {
          colorMode: "bad",
          color: "url(x)",
          opacity: NaN,
          pointSize: Infinity,
          pointLimit: -20,
        },
        type,
      ),
    ).toEqual({ ...defaultLayerSettings(type), pointLimit: 1000 });
    expect(
      normalizeLayerSettings({
        opacity: 12,
        pointSize: -1,
        pointLimit: 1e20,
        color: "#FF0000",
      }),
    ).toMatchObject({
      opacity: 1,
      pointSize: 0.01,
      pointLimit: 120000,
      color: "#ff0000",
    });
  });
  it("persists independent settings and selections by normalized endpoint/topic/type", () => {
    const storage = memory();
    const p = new DisplayPreferences(storage);
    p.selectServer("ws://robot:8765");
    p.set("/cloud", type, {
      enabled: false,
      settings: {
        ...defaultLayerSettings(type),
        colorMode: "solid",
        color: "#ff0088",
      },
    });
    p.set("/cloud", "other/Type", { enabled: true });
    p.selectServer("ws://other:8765");
    expect(p.get("/cloud", type)).toBeUndefined();
    p.set("/cloud", type, { enabled: true });
    const restored = new DisplayPreferences(storage);
    restored.selectServer("ws://robot:8765/");
    expect(restored.get("/cloud", type)).toMatchObject({
      enabled: false,
      settings: { colorMode: "solid", color: "#ff0088" },
    });
    expect(restored.get("/cloud", "other/Type")?.enabled).toBe(true);
    const copy = restored.get("/cloud", type)!;
    copy.settings.color = "#000000";
    expect(restored.get("/cloud", type)?.settings.color).toBe("#ff0088");
  });
  it("does not persist credential-like URL data or mix demo with live settings", () => {
    const storage = memory();
    const p = new DisplayPreferences(storage);
    p.selectServer("ws://robot:8765?token=secret");
    p.set("/cloud", type, { enabled: true });
    expect(storage.values.size).toBe(0);
    expect(p.get("/cloud", type)?.enabled).toBe(true);
    p.selectServer("demo");
    expect(p.get("/cloud", type)).toBeUndefined();
    p.set("/cloud", type, { enabled: false });
    expect([...storage.values.values()].join("")).not.toContain("secret");
    expect(serverKey("ws://user:pass@robot")).toBeUndefined();
    expect(serverKey("ws://robot#secret")).toBeUndefined();
    expect(serverKey("https://robot")).toBeUndefined();
  });
  it("survives corrupt, unknown-version, blocked and full storage", () => {
    for (const raw of [
      "{",
      '{"version":2,"profiles":[]}',
      "null",
      '{"version":1,"profiles":[{"server":"ws://robot/?token=x","layers":[]}]}',
    ]) {
      const p = new DisplayPreferences({
        getItem: () => raw,
        setItem: () => {
          throw Error("full");
        },
      });
      p.selectServer("ws://robot");
      p.set("/cloud", type, { enabled: true });
      expect(p.get("/cloud", type)?.enabled).toBe(true);
      expect(p.storageError).toBe(true);
    }
    expect(
      () =>
        new DisplayPreferences({
          getItem: () => {
            throw Error("denied");
          },
          setItem: () => {},
        }),
    ).not.toThrow();
  });
  it("bounds both servers and topics and resists prototype-shaped topic names", () => {
    const storage = memory();
    const p = new DisplayPreferences(storage);
    for (let s = 0; s < 15; s++) {
      p.selectServer(`ws://robot${s}`);
      p.set("/__proto__", type, { enabled: true });
    }
    for (let i = 0; i < 300; i++)
      p.set(`/topic${i}`, type, { enabled: i % 2 === 0 });
    const saved = JSON.parse([...storage.values.values()][0]);
    expect(saved.profiles).toHaveLength(12);
    expect(saved.profiles.at(-1).layers).toHaveLength(256);
    expect(topicKey("ab", "c")).not.toBe(topicKey("a", "bc"));
    const restored = new DisplayPreferences(storage);
    restored.selectServer("ws://robot14");
    expect(restored.get("/topic299", type)?.enabled).toBe(false);
  });
  it("round-trips long valid topic names within the serialized storage budget", () => {
    const storage = memory(),
      prefs = new DisplayPreferences(storage);
    for (let server = 0; server < 7; server++) {
      prefs.selectServer(`ws://robot${server}:8765`);
      for (let id = 0; id < 256; id++)
        prefs.set(`/${"x".repeat(990)}${id}`, type, { enabled: true });
    }
    expect([...storage.values.values()][0].length).toBeLessThanOrEqual(
      1_500_000,
    );
    expect(prefs.storageError).toBe(false);
    const restored = new DisplayPreferences(storage);
    restored.selectServer("ws://robot6:8765");
    expect(restored.get(`/${"x".repeat(990)}255`, type)?.enabled).toBe(true);
  });
});
