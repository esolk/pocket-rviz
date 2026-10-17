import "./style.css";
import { DiagnosticPanel, diagnosticDialog } from "./diagnostic-panel";
import { connectionSummary } from "./diagnostics";
import { inspectCompressedImageDimensions } from "./image-dimensions";
import { RosConnection, isTF, type Topic, type Packet } from "./client";
import { ViewerScene } from "./scene";
import { Demo } from "./demo";
import { bytes, decodeImage } from "./data";
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div id="viewport" aria-label="ROS 三维视图"></div>
  <header class="topbar"><button id="drawer-toggle" class="icon" aria-label="展开或收起图层">☷</button><div class="brand">掌上 RViz <span>ROS1</span></div><span id="mode-badge" class="badge">只读</span><div class="connection-state"><i id="status-dot"></i><span id="status">未连接</span></div><button id="connection-settings" class="small-button">连接</button><button id="diagnostics-open" class="small-button">诊断</button><button id="help" class="icon" aria-label="帮助">?</button></header>
  <aside id="drawer" class="drawer"><div class="drawer-heading"><div><small>DISPLAY</small><h2>图层与话题</h2></div><button id="drawer-close" class="icon" aria-label="关闭图层">×</button></div><div class="frame-control"><label for="fixed-frame">固定坐标系</label><input id="fixed-frame" value="map" list="frames" spellcheck="false"/><datalist id="frames"></datalist></div><div class="display-settings"><label><input id="show-tf" type="checkbox"/> TF 坐标轴</label><select id="point-limit" aria-label="每帧点云上限"><option value="20000">2 万点 / 帧</option><option value="60000" selected>6 万点 / 帧</option><option value="120000">12 万点 / 帧</option></select></div><div id="topic-list"></div><p id="topics-empty" class="quiet">连接后自动发现话题。<br/>勾选图层即可订阅，最多 32 个。</p><div class="drawer-footer"><span id="topic-count">0 个话题</span><span>Foxglove WebSocket</span></div></aside>
  <section id="welcome" class="welcome"><div class="welcome-orb">⌖</div><h1>把机器人现场<br/>带到手边。</h1><p>连接同一网络上的 ROS1 Foxglove bridge。<br/>三维场景、地图、点云与图像，触手可及。</p><button id="welcome-connect" class="primary">连接机器人</button><button id="demo" class="secondary">体验离线演示</button><small>只读可视化 · 不发布话题或调用服务</small></section>
  <div id="demo-banner" hidden>离线演示 · 全部为生成数据<button id="leave-demo">退出演示</button></div>
  <section id="image-card" hidden><div><span id="image-label">图像</span><button id="image-close" aria-label="隐藏图像">×</button></div><canvas id="image-canvas" width="320" height="180"></canvas><span id="image-error"></span></section>
  <div id="scene-hint" hidden>单指旋转 · 双指缩放 / 平移</div>
  <nav class="tools" aria-label="视图操作"><button id="orbit" class="active"><span>↻</span>旋转</button><button id="pan"><span>✥</span>平移</button><b></b><button id="zoom-in" aria-label="放大"><span>＋</span>放大</button><button id="zoom-out" aria-label="缩小"><span>−</span>缩小</button><b></b><button id="top"><span>▱</span>俯视</button><button id="reset"><span>⌂</span>复位</button><button id="follow"><span>◎</span>跟随</button><button id="image-toggle"><span>▧</span>图像</button></nav>
  <footer class="statusbar"><span id="notice">等待连接</span><span id="performance">0 FPS · 0 点</span></footer>
  <dialog id="connect-dialog"><form id="connect-form"><div class="dialog-heading"><h2>连接 ROS1</h2><button class="icon" type="button" id="close-connect" aria-label="关闭">×</button></div><p>输入机器人上的 Foxglove bridge 地址。手机与机器人需在同一网络或 VPN。</p><label for="url">WebSocket 地址</label><input id="url" type="url" value="ws://192.0.2.1:8765" placeholder="ws://机器人IP:8765" autocapitalize="off" spellcheck="false" required/><p class="warning">ws:// 不加密，请仅在可信网络使用。此应用只订阅消息，不发送控制指令。</p><div class="dialog-actions"><button id="disconnect" type="button" class="secondary">断开</button><button id="connect" type="submit" class="primary">连接</button></div><p class="subtle">需要 ROS1 foxglove_bridge，默认端口 8765。rosbridge 的 9090 / JSON 协议不兼容。</p></form></dialog>
  ${diagnosticDialog}
  <dialog id="inspect-dialog"><div class="dialog-heading"><h2 id="inspect-title">消息检查</h2><button id="inspect-close" class="icon" aria-label="关闭">×</button></div><p id="inspect-meta" class="subtle"></p><pre id="inspect">尚未收到消息</pre></dialog>
  <dialog id="help-dialog"><div class="dialog-heading"><h2>为 7 英寸手机横屏设计</h2><button id="help-close" class="icon" aria-label="关闭">×</button></div><ul><li>旋转模式：单指旋转，双指缩放和平移。</li><li>平移模式：单指平移，双指缩放。</li><li>图层勾选即订阅；取消勾选停止该订阅。</li><li>固定坐标系需要与消息坐标系间有可用的 TF。缺失变换时隐藏数据并提示。</li><li>跟随默认使用 base_link；可在下方更改。</li><li>后台自动断开连接；回到前台重新连接。</li></ul><label for="follow-frame">跟随坐标系</label><input id="follow-frame" value="base_link" list="frames"/><p class="warning">这是轻量只读查看器。暂不支持 RViz 插件、URDF / 网格资源、交互标记、导航目标发布、ROS2、rosbag。Marker 线宽受 WebGL 限制。请勿用于安全关键控制。</p><p class="subtle">点云按上限采样，显示保留最新帧；TF 缓存有界。原始图像：RGB/BGR/RGBA/BGRA、mono8/16；压缩图像：JPEG/PNG。</p></dialog>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const dialog = (id: string) => el<HTMLDialogElement>(id);
let viewer: ViewerScene;
try {
  viewer = new ViewerScene(el("viewport"));
} catch (e) {
  app.innerHTML =
    '<main class="gpu-error" role="alert"><div class="welcome-orb">!</div><h1>无法启动三维视图</h1><p>此 WebView 未能创建 WebGL 2 图形环境。</p><p>请更新 Android System WebView / Chrome，确认设备支持 GPU 硬件加速，然后重新打开应用。远程浏览器或禁用 GPU 的环境也可能出现此问题。</p><button id="gpu-retry" class="primary">重试三维视图</button><section class="gpu-network"><h2>连接诊断仍可使用</h2><label for="url">Foxglove WebSocket 地址</label><input id="url" type="url" value="ws://192.0.2.1:8765" autocapitalize="off" spellcheck="false"/><div class="diagnostic-actions"><button id="gpu-connect" class="primary">连接并诊断</button><button id="diagnostics-open" class="secondary">打开诊断 / Ping</button></div><p id="gpu-network-notice" role="status">只读检测连接，不显示三维数据。</p></section><details><summary>兼容性说明</summary><p>需要支持 WebGL 2 的现代 Android WebView。所有三维数据都在设备本地渲染；如果设备不支持 WebGL 2，此版本无法显示 3D 场景。可使用较新的手机或平板测试。</p></details></main>';
  app.insertAdjacentHTML("beforeend", diagnosticDialog);
  el("gpu-retry").onclick = () => location.reload();
  const fallbackClient = new RosConnection();
  let desired = false;
  const connect = () => {
    try {
      fallbackClient.connect(el<HTMLInputElement>("url").value.trim());
      desired = true;
    } catch (error) {
      el("gpu-network-notice").textContent = String(error);
    }
  };
  const fallbackPanel = new DiagnosticPanel(fallbackClient, {
    retry: connect,
    stop: () => {
      desired = false;
      fallbackClient.disconnect();
    },
  });
  el("gpu-connect").onclick = () => {
    connect();
    fallbackPanel.open();
  };
  fallbackClient.onDiagnostics = () => {
    fallbackPanel.refresh();
    el("gpu-network-notice").textContent = connectionSummary(
      fallbackClient.diagnostics,
    );
  };
  fallbackClient.onError = (message) => {
    el("gpu-network-notice").textContent = message;
  };
  fallbackClient.addDiagnostic(
    "gpu.unavailable",
    "WebGL 2 不可用；进入只读网络诊断模式，不显示三维数据",
    "warn",
  );
  // The diagnostic-only fallback does not automatically subscribe to any ROS topic.
  fallbackClient.autoSubscribe = false;
  setInterval(() => {
    if (!document.hidden) fallbackPanel.refresh();
  }, 1000);
  let paused = false;
  const pause = (value: boolean) => {
    if (paused === value) return;
    paused = value;
    if (!desired) return;
    if (paused) fallbackClient.suspend();
    else fallbackClient.resume();
  };
  document.addEventListener("visibilitychange", () => pause(document.hidden));
  window.addEventListener("androidlifecycle", (event) =>
    pause((event as CustomEvent).detail?.state === "pause"),
  );
  window.addEventListener("androidback", (event) => {
    if (dialog("diagnostics-dialog").open) {
      dialog("diagnostics-dialog").close();
      event.preventDefault();
    }
  });
  (window as any).viewerDiagnostics = () => ({
    mode: "unavailable",
    error: "WebGL 2 unavailable",
    connection: fallbackClient.state,
    network: fallbackClient.diagnostics,
    diagnosticLog: fallbackClient.diagnosticLog.map((entry) => ({ ...entry })),
    networkProbe: fallbackPanel.networkProbe,
  });
  throw e;
}
const client = new RosConnection();
let demo: Demo | undefined;
let mode: "idle" | "live" | "demo" = "idle";
let liveDesired = false,
  lifecyclePaused = false;
let imageHidden = false,
  selectedImage = -1,
  inspectId = -1;
let lastUi = 0,
  lastFlush = 0,
  lastRender = 0;
const latest = new Map<number, any>();
const latestSizes = new Map<number, number>();
let imageEpoch = 0,
  imageBusy = false;
let imageQueued: { t: Topic; m: any; epoch: number } | undefined;
const imageSerial = new Map<number, number>();
const rows = new Map<
  number,
  { row: HTMLElement; status: HTMLElement; check: HTMLInputElement }
>();
const topics = () => demo?.topics ?? client.topics;
function notice(s: string) {
  el("notice").textContent = s;
}
function setStatus(s: string) {
  if (mode === "live") notice(connectionSummary(client.diagnostics));
  el("status").textContent = s;
  el("status-dot").className =
    s === "已连接" ? "online" : mode === "demo" ? "demo" : "";
}
function setMode(m: typeof mode) {
  mode = m;
  el("mode-badge").textContent = m === "demo" ? "演示" : "只读";
  el("demo-banner").hidden = m !== "demo";
  el("welcome").hidden = m !== "idle";
  el("scene-hint").hidden = m === "idle";
  el("app").classList.toggle("is-demo", m === "demo");
}
function resetData() {
  imageEpoch++;
  imageQueued = undefined;
  viewer.clear();
  latest.clear();
  latestSizes.clear();
  rows.clear();
  el("topic-list").replaceChildren();
  selectedImage = -1;
  imageSerial.clear();
  el("image-card").hidden = true;
  el("image-error").textContent = "";
}
function syncTopics() {
  const active = new Set(topics().keys());
  for (const [id, row] of rows) {
    if (!active.has(id)) {
      row.row.remove();
      rows.delete(id);
      viewer.removeTopic(id);
      latest.delete(id);
    }
  }
  for (const t of topics().values()) {
    const layer = viewer.addTopic(t);
    layer.enabled = t.enabled;
    let row = rows.get(t.id);
    if (!row) {
      const wrapper = document.createElement("div");
      wrapper.className = "topic-row";
      wrapper.dataset.topic = t.topic;
      const check = document.createElement("input");
      check.type = "checkbox";
      check.setAttribute("aria-label", `显示 ${t.topic}`);
      const label = document.createElement("div");
      label.className = "topic-label";
      const title = document.createElement("strong");
      title.textContent = t.topic;
      const type = document.createElement("small");
      type.textContent = t.schemaName.replace(/.*\//, "");
      const status = document.createElement("span");
      status.className = "topic-status";
      label.append(title, type, status);
      const inspect = document.createElement("button");
      inspect.className = "inspect-button";
      inspect.textContent = "⋯";
      inspect.setAttribute("aria-label", `检查 ${t.topic}`);
      inspect.onclick = () => openInspect(t.id);
      label.onclick = () => {
        if (!check.disabled) check.click();
      };
      check.onchange = () => {
        if (demo) {
          t.enabled = check.checked;
          viewer.addTopic(t).enabled = t.enabled;
          if (t.enabled) {
            demo.init(performance.now());
            notice("演示重新开始");
          }
        } else client.toggle(t.id, check.checked);
        if (!t.enabled && t.id === selectedImage)
          el("image-card").hidden = true;
        syncTopics();
      };
      wrapper.append(check, label, inspect);
      el("topic-list").append(wrapper);
      row = { row: wrapper, status, check };
      rows.set(t.id, row);
    }
    row.check.checked = t.enabled;
    row.check.disabled = mode === "live" && !t.reader;
    row.row.classList.toggle("disabled", !t.enabled);
    row.status.textContent = t.error ?? layer.status;
  }
  el("topics-empty").hidden = topics().size > 0;
  el("topics-empty").textContent =
    mode === "live"
      ? connectionSummary(client.diagnostics)
      : "连接后自动发现话题。勾选图层即可订阅，最多 32 个。";
  el("topic-count").textContent =
    `${topics().size} 个话题 · ${[...topics().values()].filter((t) => t.enabled).length} 已订阅`;
}
function requestImage(t: Topic, m: any) {
  if (imageHidden || !t.enabled) return;
  const active = topics().get(selectedImage);
  if (selectedImage !== t.id && active?.enabled) return;
  const job = { t, m, epoch: imageEpoch };
  if (imageBusy) {
    imageQueued = job;
    return;
  }
  imageBusy = true;
  void showImage(t, m, job.epoch).finally(() => {
    imageBusy = false;
    const next = imageQueued;
    imageQueued = undefined;
    if (next && next.epoch === imageEpoch) requestImage(next.t, next.m);
  });
}
async function showImage(t: Topic, m: any, epoch: number) {
  if (imageHidden || !t.enabled || epoch !== imageEpoch) return;
  const old = topics().get(selectedImage);
  if (selectedImage !== t.id && old?.enabled) return;
  selectedImage = t.id;
  const serial = (imageSerial.get(t.id) ?? 0) + 1;
  imageSerial.set(t.id, serial);
  const canvas = el<HTMLCanvasElement>("image-canvas"),
    ctx = canvas.getContext("2d")!;
  try {
    if (t.schemaName === "sensor_msgs/Image") {
      const img = decodeImage(m);
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
        0,
        0,
      );
    } else {
      const format = String(m.format ?? "").toLowerCase();
      if (
        !format.includes("jpeg") &&
        !format.includes("jpg") &&
        !format.includes("png")
      )
        throw Error(`暂不支持压缩格式 ${format}`);
      if (format.includes("compresseddepth"))
        throw Error("暂不支持 compressedDepth");
      const data = bytes(m.data);
      if (data.byteLength > 16 * 1024 * 1024)
        throw Error("压缩图像超出 16 MiB");
      const dimensions = inspectCompressedImageDimensions(data, format);
      if (dimensions.width * dimensions.height > 8_294_400)
        throw Error("图像超出 8M 像素");
      const blob = new Blob([new Uint8Array(data)], {
        type: format.includes("png") ? "image/png" : "image/jpeg",
      });
      const bitmap = await createImageBitmap(blob);
      if (
        epoch !== imageEpoch ||
        imageSerial.get(t.id) !== serial ||
        selectedImage !== t.id ||
        !t.enabled ||
        imageHidden
      ) {
        bitmap.close();
        return;
      }
      if (bitmap.width * bitmap.height > 8_294_400) {
        bitmap.close();
        throw Error("图像超出 8M 像素");
      }
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    }
    el("image-error").textContent = "";
    el("image-label").textContent = t.topic;
    el("image-card").hidden = false;
  } catch (e) {
    if (epoch !== imageEpoch || imageHidden || !t.enabled) return;
    el("image-error").textContent = String(e).slice(0, 100);
    el("image-card").hidden = false;
  }
}
function packet(p: Packet) {
  latest.delete(p.topic.id);
  latestSizes.delete(p.topic.id);
  const size = p.size ?? 0;
  latest.set(p.topic.id, p.message);
  latestSizes.set(p.topic.id, size);
  let total = [...latestSizes.values()].reduce((a, b) => a + b, 0);
  while (total > 32 * 1024 * 1024 && latest.size > 1) {
    const id = latest.keys().next().value!;
    total -= latestSizes.get(id) ?? 0;
    latestSizes.delete(id);
    latest.delete(id);
  }
  viewer.ingest(p.topic, p.message);
  if (
    p.topic.schemaName === "sensor_msgs/Image" ||
    p.topic.schemaName === "sensor_msgs/CompressedImage"
  )
    requestImage(p.topic, p.message);
}
client.onPacket = packet;
client.onState = setStatus;
client.onReset = resetData;
client.onTopics = syncTopics;
client.onError = notice;
let clock = 0n;
client.onClock = (t) => {
  if (clock && t < clock) {
    client.discardPending();
    viewer.clear(true);
    latest.clear();
    latestSizes.clear();
    imageEpoch++;
    imageQueued = undefined;
    el("image-card").hidden = true;
    syncTopics();
    notice("ROS 时间回退，已清空显示与 TF 缓存");
  }
  clock = t;
};
function startLive(url: string) {
  try {
    client.connect(url);
    demo = undefined;
    setMode("live");
    liveDesired = true;
    imageHidden = false;
    clock = 0n;
    resetData();
    syncTopics();
    dialog("connect-dialog").close();
    el("drawer").classList.remove("open");
    notice(connectionSummary(client.diagnostics));
    try {
      // Avoid persisting token-like URL query values in Android WebView storage.
      if (new URL(url).search) localStorage.removeItem("ros-tablet-url");
      else localStorage.setItem("ros-tablet-url", url);
    } catch {}
  } catch (e) {
    notice(String(e));
  }
}
function stop() {
  client.disconnect();
  liveDesired = false;
  demo = undefined;
  setMode("idle");
  resetData();
  syncTopics();
  notice("已断开，显示数据已清空");
}
const diagnostics = new DiagnosticPanel(client, {
  retry: () => startLive(el<HTMLInputElement>("url").value.trim()),
  stop,
});
client.onDiagnostics = () => {
  diagnostics.refresh();
  if (mode === "live") notice(connectionSummary(client.diagnostics));
};
el("connect-form").addEventListener("submit", (e) => {
  e.preventDefault();
  startLive(el<HTMLInputElement>("url").value.trim());
});
el("disconnect").onclick = () => {
  stop();
  dialog("connect-dialog").close();
};
try {
  const saved = localStorage.getItem("ros-tablet-url");
  if (saved) el<HTMLInputElement>("url").value = saved;
} catch {}
for (const id of ["connection-settings", "welcome-connect"])
  el(id).onclick = () => dialog("connect-dialog").showModal();
el("close-connect").onclick = () => dialog("connect-dialog").close();
el("demo").onclick = () => {
  client.disconnect();
  liveDesired = false;
  resetData();
  setMode("demo");
  imageHidden = false;
  demo = new Demo(packet);
  syncTopics();
  demo.init(performance.now());
  setStatus("离线演示");
  notice("生成数据 · 不连接机器人");
  el("drawer").classList.remove("open");
};
el("leave-demo").onclick = stop;
el("drawer-toggle").onclick = () => el("drawer").classList.toggle("open");
el("drawer-close").onclick = () => el("drawer").classList.remove("open");
el("orbit").onclick = () => {
  viewer.mode(false);
  el("orbit").classList.add("active");
  el("pan").classList.remove("active");
  el("scene-hint").textContent = "单指旋转 · 双指缩放 / 平移";
};
el("pan").onclick = () => {
  viewer.mode(true);
  el("pan").classList.add("active");
  el("orbit").classList.remove("active");
  el("scene-hint").textContent = "单指平移 · 双指缩放";
};
el("zoom-in").onclick = () => viewer.zoom(0.75);
el("zoom-out").onclick = () => viewer.zoom(1.33);
el("top").onclick = () => viewer.top();
el("reset").onclick = () => {
  viewer.followFrame = "";
  el("follow").classList.remove("active");
  viewer.resetCamera();
};
el("follow").onclick = () => {
  viewer.followFrame = viewer.followFrame
    ? ""
    : el<HTMLInputElement>("follow-frame").value.trim();
  el("follow").classList.toggle("active", !!viewer.followFrame);
  if (
    viewer.followFrame &&
    !viewer.tf.lookup(viewer.fixedFrame, viewer.followFrame, 0n)
  )
    notice(`等待跟随坐标系 TF: ${viewer.followFrame}`);
};
el("fixed-frame").onchange = () =>
  viewer.setFrame(el<HTMLInputElement>("fixed-frame").value.trim());
el("show-tf").onchange = () =>
  (viewer.showTf = el<HTMLInputElement>("show-tf").checked);
el("point-limit").onchange = () =>
  (viewer.maxPoints = Number(el<HTMLSelectElement>("point-limit").value));
el("help").onclick = () => dialog("help-dialog").showModal();
el("help-close").onclick = () => dialog("help-dialog").close();
el("follow-frame").onchange = () => {
  if (viewer.followFrame)
    viewer.followFrame = el<HTMLInputElement>("follow-frame").value.trim();
};
function toggleImage(hidden: boolean) {
  imageEpoch++;
  imageQueued = undefined;
  imageHidden = hidden;
  el("image-card").hidden = hidden;
  if (!hidden) {
    selectedImage = -1;
    const t = [...topics().values()].find(
      (t) => t.enabled && t.schemaName.includes("Image") && latest.has(t.id),
    );
    if (t) requestImage(t, latest.get(t.id));
    else {
      el("image-card").hidden = true;
      notice("请订阅一个 Image 或 CompressedImage 话题");
    }
  }
}
el("image-close").onclick = () => toggleImage(true);
el("image-toggle").onclick = () =>
  toggleImage(!imageHidden && !el("image-card").hidden);
function openInspect(id: number) {
  inspectId = id;
  const t = topics().get(id);
  if (!t) return;
  el("inspect-title").textContent = t.topic;
  refreshInspect();
  dialog("inspect-dialog").showModal();
}
el("inspect-close").onclick = () => dialog("inspect-dialog").close();
function refreshInspect() {
  const t = topics().get(inspectId);
  if (!t) return;
  el("inspect-meta").textContent =
    `${t.schemaName} · ${t.received} 条消息 · 数组仅显示前 16 项`;
  const m = latest.get(inspectId);
  let text = m
    ? JSON.stringify(
        m,
        (_key, value) => {
          if (typeof value === "bigint") return value.toString();
          if (ArrayBuffer.isView(value))
            return [
              ...Array.from(
                {
                  length: Math.min(
                    16,
                    (value as unknown as ArrayLike<number>).length,
                  ),
                },
                (_, i) => (value as unknown as ArrayLike<number>)[i],
              ),
              `… ${(value as unknown as ArrayLike<number>).length} 项`,
            ];
          if (Array.isArray(value) && value.length > 16)
            return [...value.slice(0, 16), `… ${value.length} 项`];
          if (typeof value === "string" && value.length > 1000)
            return value.slice(0, 1000) + "…";
          return value;
        },
        2,
      )
    : "尚未收到消息。请先勾选此话题。";
  el("inspect").textContent = text.slice(0, 18000);
}
function lifecycle(paused: boolean) {
  if (lifecyclePaused === paused) return;
  lifecyclePaused = paused;
  viewer.pause(paused);
  if (paused) {
    if (mode === "live" && liveDesired) client.suspend();
  } else if (mode === "live" && liveDesired) {
    client.resume();
    notice("从后台恢复，重新连接…");
  }
}
document.addEventListener("visibilitychange", () => lifecycle(document.hidden));
window.addEventListener("androidlifecycle", (e) =>
  lifecycle((e as CustomEvent).detail?.state === "pause"),
);
function animate(now: number) {
  requestAnimationFrame(animate);
  if (lifecyclePaused) return;
  if (now - lastFlush >= 66) {
    client.flush();
    demo?.tick(now);
    lastFlush = now;
  }
  if (now - lastRender >= 32) {
    viewer.render(now);
    lastRender = now;
  }
  if (now - lastUi >= 650) {
    syncTopics();
    el("performance").textContent =
      `${viewer.fps} FPS · ${viewer.renderer.info.render.points.toLocaleString()} 点`;
    const frames = viewer.tf.frames();
    el("frames").replaceChildren(
      ...frames.map((f) => {
        const option = document.createElement("option");
        option.value = f;
        return option;
      }),
    );
    if (dialog("inspect-dialog").open) refreshInspect();
    diagnostics.refresh();
    lastUi = now;
  }
}
viewer.renderer.domElement.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  viewer.pause(true);
  notice("GPU 上下文丢失，正在等待系统恢复。若持续无画面请重新打开应用。");
});
viewer.renderer.domElement.addEventListener("webglcontextrestored", () => {
  viewer.pause(lifecyclePaused);
  notice("GPU 已恢复");
});
requestAnimationFrame(animate);
(window as any).viewerDiagnostics = () => ({
  mode,
  connection: client.state,
  network: client.diagnostics,
  diagnosticLog: client.diagnosticLog.map((e) => ({ ...e })),
  networkProbe: diagnostics.networkProbe,
  fixedFrame: viewer.fixedFrame,
  bytesReceived: client.bytesReceived,
  topics: [...topics().values()].map(
    ({ id, topic, schemaName, enabled, error, received, bytes }) => ({
      id,
      topic,
      schemaName,
      enabled,
      error,
      received,
      bytes,
    }),
  ),
  ...viewer.diagnostics(),
});

function dismissOverlay(): boolean {
  const open = [
    ...document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
  ];
  const top = open[open.length - 1];
  if (top) {
    top.close();
    return true;
  } else if (el("drawer").classList.contains("open")) {
    el("drawer").classList.remove("open");
    return true;
  }
  return false;
}
window.addEventListener("androidback", (event) => {
  if (dismissOverlay()) event.preventDefault();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dismissOverlay()) event.preventDefault();
});
