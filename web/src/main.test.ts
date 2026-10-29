import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Topic } from "./client";
import { defaultLayerSettings } from "./display-settings";
// Small DOM/event harness: exercises real main.ts wiring, not browser layout or WebGL.
const harness = vi.hoisted(() => ({
  client: null as any,
  viewer: null as any,
}));
vi.mock("./scene", () => ({
  ViewerScene: class {
    layers = new Map();
    fixedFrame = "map";
    fps = 0;
    showTf = false;
    followFrame = "";
    tf = { frames: () => [], lookup: () => true };
    renderer = {
      domElement: { addEventListener() {} },
      info: { render: { points: 0 } },
    };
    constructor() {
      harness.viewer = this;
    }
    addTopic(t: Topic) {
      if (!this.layers.has(t.id))
        this.layers.set(t.id, {
          enabled: t.enabled,
          status: "等待消息",
          settings: defaultLayerSettings(t.schemaName),
        });
      return this.layers.get(t.id);
    }
    configureTopic(t: Topic, c: any) {
      this.addTopic(t).settings = c;
    }
    removeTopic(id: number) {
      this.layers.delete(id);
    }
    clear() {
      this.layers.clear();
    }
    ingest = vi.fn();
    pause() {}
    render() {}
    diagnostics() {
      return {};
    }
    mode() {}
    zoom() {}
    top() {}
    resetCamera() {}
    setFrame(s: string) {
      this.fixedFrame = s;
    }
  },
}));
vi.mock("./diagnostic-panel", () => ({
  diagnosticDialog: '<dialog id="diagnostics-dialog"></dialog>',
  DiagnosticPanel: class {
    constructor() {}
    refresh() {}
    open() {}
  },
}));
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    RosConnection: class {
      topics = new Map<number, Topic>();
      diagnostics = {
        phase: "idle",
        advertised: 0,
        eligible: 0,
        subscribed: 0,
      };
      diagnosticLog = [];
      state = "未连接";
      onTopics = () => {};
      onReset = () => {};
      selectionForTopic: any;
      constructor() {
        harness.client = this;
      }
      connect() {
        this.topics.clear();
        this.onReset();
      }
      disconnect() {}
      flush() {}
      discardPending() {}
      resume() {}
      suspend() {}
      toggle(id: number, on: boolean) {
        this.topics.get(id)!.enabled = on;
        this.onTopics();
      }
    },
  };
});
class Element {
  id = "";
  tagName = "";
  textContent = "";
  title = "";
  value = "";
  type = "";
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  children: Element[] = [];
  parent?: Element;
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  events: Record<string, Function> = {};
  onchange?: Function;
  oninput?: Function;
  onclick?: Function;
  classes = new Set<string>();
  classList = {
    add: (s: string) => this.classes.add(s),
    remove: (s: string) => this.classes.delete(s),
    contains: (s: string) => this.classes.has(s),
    toggle: (s: string, on?: boolean) => {
      const yes = on ?? !this.classes.has(s);
      yes ? this.classes.add(s) : this.classes.delete(s);
      return yes;
    },
  };
  set className(s: string) {
    this.classes = new Set(s.split(" "));
  }
  get className() {
    return [...this.classes].join(" ");
  }
  set innerHTML(html: string) {
    for (const m of html.matchAll(
      /<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g,
    )) {
      const e = new Element();
      e.id = m[3];
      e.tagName = m[1];
      for (const a of m[2].matchAll(/([a-z-]+)="([^"]*)"/g))
        e.attrs[a[1]] = a[2];
      e.value = e.attrs.value ?? "";
      e.type = e.attrs.type ?? "";
      e.className = e.attrs.class ?? "";
      e.hidden = /\bhidden\b/.test(m[2]);
      elements.set(e.id, e);
    }
    elements.get("topic-filter")!.value = "all";
    const limit = elements.get("layer-point-limit")!;
    for (const n of [20000, 60000, 120000]) {
      const o = new Element();
      o.value = String(n);
      limit.append(o);
    }
  }
  append(...es: Element[]) {
    for (const e of es) {
      e.parent = this;
      this.children.push(e);
    }
  }
  replaceChildren(...es: Element[]) {
    this.children = [];
    this.append(...es);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((e) => e !== this);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k];
  }
  addEventListener(k: string, f: Function) {
    this.events[k] = f;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  click() {
    if (this.disabled) return;
    if (this.type === "checkbox") {
      this.checked = !this.checked;
      this.onchange?.();
    } else this.onclick?.();
  }
  get options() {
    return this.children;
  }
  add(e: Element) {
    this.append(e);
  }
  querySelector(s: string) {
    return s === "[data-custom]"
      ? this.children.find((c) => c.dataset.custom)
      : undefined;
  }
  checkValidity() {
    return (
      this.type !== "number" ||
      (this.value !== "" &&
        Number(this.value) >= Number(this.attrs.min) &&
        Number(this.value) <= Number(this.attrs.max))
    );
  }
  reportValidity() {}
}
let elements: Map<string, Element>,
  listeners: Map<string, Function>,
  storage: Map<string, string>;
const e = (id: string) => elements.get(id)!;
const topic = (
  id = 1,
  name = "/cloud",
  type = "sensor_msgs/PointCloud2",
): Topic => ({
  id,
  topic: name,
  schemaName: type,
  schema: "uint32 value",
  encoding: "ros1",
  enabled: false,
  supported: true,
  received: 0,
  bytes: 0,
  lastAt: 0,
  reader: {} as any,
});
async function start() {
  await import("./main");
  e("url").value = "ws://robot:8765";
  e("connect-form").events.submit({ preventDefault() {} });
}
function advertise(ts: Topic[]) {
  for (const t of ts) {
    t.enabled = harness.client.selectionForTopic(t);
    harness.client.topics.set(t.id, t);
  }
  harness.client.onTopics();
}
function row(name = "/cloud") {
  return e("topic-list").children.find((r) => r.dataset.topic === name)!;
}
beforeEach(() => {
  vi.resetModules();
  elements = new Map();
  listeners = new Map();
  storage = new Map();
  const app = new Element();
  elements.set("app", app);
  vi.stubGlobal("document", {
    querySelector: () => app,
    getElementById: (id: string) => elements.get(id),
    createElement: (tag: string) => {
      const el = new Element();
      el.tagName = tag;
      return el;
    },
    querySelectorAll: () =>
      [...elements.values()].filter((x) => x.tagName === "dialog" && x.open),
    addEventListener() {},
    hidden: false,
  });
  vi.stubGlobal("window", {
    addEventListener: (s: string, f: Function) => listeners.set(s, f),
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal(
    "Option",
    class extends Element {
      constructor(text: string, value: string) {
        super();
        this.textContent = text;
        this.value = value;
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
it("search and category filters preserve choices and do not subscribe hidden streams", async () => {
  await start();
  advertise([
    topic(),
    topic(2, "/camera", "sensor_msgs/Image"),
    topic(3, "/tf", "tf2_msgs/TFMessage"),
  ]);
  expect(
    [...harness.client.topics.values()].filter((t: any) => t.enabled),
  ).toHaveLength(1);
  e("topic-search").value = "pointcloud2";
  e("topic-search").oninput!();
  expect(row().hidden).toBe(false);
  expect(row("/camera").hidden).toBe(true);
  row().children[0].click();
  expect(harness.client.topics.get(1).enabled).toBe(true);
  e("topic-search").value = "";
  e("topic-filter").value = "selected";
  e("topic-filter").onchange!();
  expect(row().hidden).toBe(false);
  expect(row("/camera").hidden).toBe(true);
  e("topic-filter").value = "all";
  e("topic-filter").onchange!();
  expect(row("/camera").children[0].checked).toBe(false);
});
it("configures only the chosen layer without subscribing, validates and resets", async () => {
  await start();
  advertise([topic(), topic(2, "/cloud2")]);
  row().children[2].click();
  expect(e("layer-dialog").open).toBe(true);
  e("layer-color-mode").value = "solid";
  e("layer-color-mode").onchange!();
  expect(harness.viewer.layers.get(1).settings.colorMode).toBe("solid");
  expect(harness.viewer.layers.get(2).settings.colorMode).toBe("auto");
  expect(harness.client.topics.get(1).enabled).toBe(false);
  e("layer-point-size").value = "-8";
  e("layer-point-size").onchange!();
  expect(harness.viewer.layers.get(1).settings.pointSize).toBe(0.06);
  e("layer-point-size").value = "0.2";
  e("layer-point-size").onchange!();
  expect(harness.viewer.layers.get(1).settings.pointSize).toBe(0.2);
  expect([...storage.values()].join("")).toContain('"pointSize":0.2');
  e("layer-reset").click();
  expect(harness.viewer.layers.get(1).settings).toEqual(defaultLayerSettings());
});
it("closes stale panels on replaced channel IDs and restores by topic name", async () => {
  await start();
  advertise([topic()]);
  row().children[0].click();
  row().children[2].click();
  e("layer-color-mode").value = "solid";
  e("layer-color-mode").onchange!();
  advertise([topic(1, "/other")]);
  expect(e("layer-dialog").open).toBe(false);
  expect(harness.viewer.layers.get(1).settings.colorMode).toBe("auto");
  advertise([topic(8, "/cloud")]);
  expect(harness.viewer.layers.get(8).settings.colorMode).toBe("solid");
  expect(harness.client.topics.get(8).enabled).toBe(true);
});
it("repeated close and Back dismiss overlays before drawer without changing subscriptions", async () => {
  await start();
  advertise([topic()]);
  e("drawer-toggle").click();
  row().children[2].click();
  const prevented = vi.fn();
  listeners.get("androidback")!({ preventDefault: prevented });
  expect(e("layer-dialog").open).toBe(false);
  expect(e("drawer").classList.contains("open")).toBe(true);
  row().children[2].click();
  e("layer-close").click();
  e("layer-close").click();
  listeners.get("androidback")!({ preventDefault: prevented });
  expect(e("drawer").classList.contains("open")).toBe(false);
  expect(harness.client.topics.get(1).enabled).toBe(false);
});
it("clears old geometry rather than claiming uncached cloud recoloring is applied", async () => {
  await start();
  advertise([topic()]);
  harness.viewer.layers.get(1).status = "old geometry";
  row().children[2].click();
  e("layer-color-mode").value = "intensity";
  e("layer-color-mode").onchange!();
  expect(harness.viewer.layers.get(1).status).toBe("等待消息");
  expect(e("layer-feedback").textContent).toContain("等待新消息");
});
