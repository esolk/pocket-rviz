/** Local-only, versioned display preferences. Never store endpoint credentials or ROS data. */
export type ColorMode = "auto" | "rgb" | "intensity" | "height" | "solid";
export type LayerSettings = {
  colorMode: ColorMode;
  color: string;
  pointSize: number;
  opacity: number;
  pointLimit: number;
};
export function defaultLayerSettings(type = ""): LayerSettings {
  return {
    colorMode: "auto",
    color:
      type === "nav_msgs/Path"
        ? "#4cf0c8"
        : type.includes("Pose") || type.includes("Odometry")
          ? "#ffcb71"
          : "#61eacc",
    pointSize: type === "sensor_msgs/LaserScan" ? 0.085 : 0.06,
    opacity: type === "nav_msgs/OccupancyGrid" ? 0.88 : 1,
    pointLimit: 60000,
  };
}
const bounded = (v: unknown, low: number, high: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(low, Math.min(high, v))
    : fallback;
export function normalizeLayerSettings(
  input: unknown,
  type = "",
): LayerSettings {
  const d = defaultLayerSettings(type);
  const v =
    input && typeof input === "object" ? (input as Partial<LayerSettings>) : {};
  return {
    colorMode: ["auto", "rgb", "intensity", "height", "solid"].includes(
      v.colorMode ?? "",
    )
      ? v.colorMode!
      : d.colorMode,
    color:
      typeof v.color === "string" && /^#[0-9a-f]{6}$/i.test(v.color)
        ? v.color.toLowerCase()
        : d.color,
    pointSize: bounded(v.pointSize, 0.01, 0.5, d.pointSize),
    opacity: bounded(v.opacity, 0, 1, d.opacity),
    pointLimit: Math.round(bounded(v.pointLimit, 1000, 120000, d.pointLimit)),
  };
}
export const topicKey = (topic: string, type: string) =>
  JSON.stringify([topic, type]);
export function serverKey(url: string): string | undefined {
  if (url === "demo") return "demo";
  try {
    const u = new URL(url);
    if (
      !["ws:", "wss:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.href.length > 1024
    )
      return;
    return u.href;
  } catch {
    return;
  }
}
type SavedLayer = { enabled?: boolean; settings: LayerSettings };
type Profile = { server: string; layers: Map<string, SavedLayer> };
const STORAGE_KEY = "pocket-rviz-displays-v1";
const MAX_SERVERS = 12,
  MAX_LAYERS = 256,
  MAX_STORAGE = 1_500_000;
export class DisplayPreferences {
  private profiles = new Map<string, Profile>();
  private current: Profile = { server: "", layers: new Map() };
  private persist = false;
  storageError = false;
  get canPersist() {
    return this.persist;
  }
  constructor(private storage?: Pick<Storage, "getItem" | "setItem">) {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw || raw.length > MAX_STORAGE) return;
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) return;
      for (const p of parsed.profiles.slice(-MAX_SERVERS)) {
        if (
          typeof p?.server !== "string" ||
          serverKey(p.server) !== p.server ||
          !Array.isArray(p.layers)
        )
          continue;
        const layers = new Map<string, SavedLayer>();
        for (const item of p.layers.slice(-MAX_LAYERS)) {
          if (
            typeof item?.topic !== "string" ||
            item.topic.length > 1024 ||
            typeof item?.type !== "string" ||
            item.type.length > 256
          )
            continue;
          layers.set(topicKey(item.topic, item.type), {
            enabled:
              typeof item.enabled === "boolean" ? item.enabled : undefined,
            settings: normalizeLayerSettings(item.settings, item.type),
          });
        }
        this.profiles.set(p.server, { server: p.server, layers });
      }
    } catch {
      this.storageError = true;
    }
  }
  selectServer(url: string) {
    const key = serverKey(url);
    this.persist = !!key;
    this.current = key
      ? (this.profiles.get(key) ?? { server: key, layers: new Map() })
      : { server: "", layers: new Map() };
    if (key) {
      this.profiles.delete(key);
      this.profiles.set(key, this.current);
      while (this.profiles.size > MAX_SERVERS)
        this.profiles.delete(this.profiles.keys().next().value!);
    }
  }
  get(topic: string, type: string): SavedLayer | undefined {
    const item = this.current.layers.get(topicKey(topic, type));
    return item ? { ...item, settings: { ...item.settings } } : undefined;
  }
  set(
    topic: string,
    type: string,
    update: { enabled?: boolean; settings?: LayerSettings },
  ) {
    if (topic.length > 1024 || type.length > 256) return;
    const key = topicKey(topic, type);
    const previous = this.current.layers.get(key);
    this.current.layers.delete(key);
    this.current.layers.set(key, {
      enabled: update.enabled ?? previous?.enabled,
      settings: normalizeLayerSettings(
        update.settings ?? previous?.settings,
        type,
      ),
    });
    while (this.current.layers.size > MAX_LAYERS)
      this.current.layers.delete(this.current.layers.keys().next().value!);
    this.save();
  }
  private save() {
    if (!this.persist || !this.storage) return;
    try {
      const serialize = () =>
        JSON.stringify({
          version: 1,
          profiles: [...this.profiles.values()].map((p) => ({
            server: p.server,
            layers: [...p.layers].map(([key, value]) => {
              const [topic, type] = JSON.parse(key);
              return { topic, type, ...value };
            }),
          })),
        });
      let data = serialize();
      // The writer and reader share the same byte-character budget. Evict the
      // least recently selected server first, preserving the active profile.
      while (data.length > MAX_STORAGE) {
        if (this.profiles.size > 1)
          this.profiles.delete(this.profiles.keys().next().value!);
        else if (this.current.layers.size)
          this.current.layers.delete(this.current.layers.keys().next().value!);
        else break;
        data = serialize();
      }
      this.storage.setItem(STORAGE_KEY, data);
      this.storageError = false;
    } catch {
      this.storageError = true;
    }
  }
}
