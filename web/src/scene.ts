import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  TfTree,
  cleanFrame,
  stampNs,
  decodePointCloud,
  decodeLaserScan,
} from "./data";
import type { Topic } from "./client";
import { defaultLayerSettings, normalizeLayerSettings, type LayerSettings } from "./display-settings";
export type Layer = {
  id: number;
  topic: string;
  type: string;
  root: THREE.Group;
  frame: string;
  stamp: bigint;
  enabled: boolean;
  status: string;
  count: number;
  latest: any;
  markers: Map<string, MarkerEntry>;
  history: THREE.Vector3[];
  transform?: THREE.Matrix4;
  settings: LayerSettings;
  warning?: string;
};
type MarkerEntry = {
  object: THREE.Object3D;
  frame: string;
  stamp: bigint;
  locked: boolean;
  expires: number;
  resolved?: THREE.Matrix4;
  cost: number;
  text: boolean;
};
const coordinate = (n: unknown, fallback = 0): number => {
  const value = n === undefined ? fallback : Number(n);
  if (!Number.isFinite(value)) throw Error("非有限坐标或旋转");
  return value;
};
const vec = (v: any) =>
  new THREE.Vector3(coordinate(v?.x), coordinate(v?.y), coordinate(v?.z));
const quat = (v: any) =>
  new THREE.Quaternion(
    coordinate(v?.x),
    coordinate(v?.y),
    coordinate(v?.z),
    coordinate(v?.w, 1),
  ).normalize();
function poseMatrix(p: any) {
  return new THREE.Matrix4().compose(
    vec(p?.position),
    quat(p?.orientation),
    new THREE.Vector3(1, 1, 1),
  );
}
function dispose(object: THREE.Object3D) {
  object.traverse((o) => {
    const r = o as THREE.Mesh;
    if ((r as THREE.InstancedMesh).isInstancedMesh)
      (r as THREE.InstancedMesh).dispose();
    r.geometry?.dispose();
    const mats = r.material
      ? Array.isArray(r.material)
        ? r.material
        : [r.material]
      : [];
    for (const mat of mats) {
      const m = mat as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
    }
  });
  object.removeFromParent();
}
const color = (c: any, defaultColor = 0x49d8c5) =>
  c
    ? new THREE.Color().setRGB(c.r ?? 1, c.g ?? 1, c.b ?? 1)
    : new THREE.Color(defaultColor);
function material(c: any) {
  return new THREE.MeshStandardMaterial({
    color: color(c),
    opacity: c?.a ?? 1,
    transparent: (c?.a ?? 1) < 1,
    roughness: 0.8,
    side: THREE.DoubleSide,
  });
}
export class ViewerScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.03, 5000);
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly tf = new TfTree();
  readonly layers = new Map<number, Layer>();
  readonly tfVisual = new THREE.Group();
  fixedFrame = "map";
  followFrame = "";
  showTf = false;
  maxPoints = 60000;
  fps = 0;
  private frames = 0;
  private frameStart = performance.now();
  private markerCount = 0;
  private markerVertices = 0;
  private markerTexts = 0;
  private axisObjects = new Map<string, THREE.AxesHelper>();
  private originalAppearance = new WeakMap<THREE.Material, { opacity: number; transparent: boolean; depthWrite: boolean }>();
  private stopped = false;
  constructor(public container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: window.devicePixelRatio < 2,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.setClearColor(0x09121c);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.append(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 2000;
    this.controls.screenSpacePanning = true;
    this.controls.touches.ONE = THREE.TOUCH.ROTATE;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    const grid = new THREE.GridHelper(60, 60, 0x263e51, 0x172938);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.035;
    this.scene.add(grid, new THREE.AxesHelper(1.5));
    this.scene.add(new THREE.AmbientLight(0xcfeaff, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(3, -4, 12);
    this.scene.add(light, this.tfVisual);
    this.resetCamera();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }
  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
  resetCamera() {
    this.camera.position.set(12, -15, 14);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }
  top() {
    const target = this.controls.target.clone();
    const d = Math.max(5, this.camera.position.distanceTo(target));
    this.camera.position.copy(target).add(new THREE.Vector3(0, -0.001, d));
    this.controls.update();
  }
  zoom(factor: number) {
    this.camera.position
      .sub(this.controls.target)
      .multiplyScalar(factor)
      .add(this.controls.target);
    this.controls.update();
  }
  mode(pan: boolean) {
    this.controls.touches.ONE = pan ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    this.controls.mouseButtons.LEFT = pan
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;
  }
  pause(value: boolean) {
    this.stopped = value;
  }
  setFrame(frame: string) {
    this.fixedFrame = cleanFrame(frame) || "map";
    for (const l of this.layers.values()) {
      l.transform = undefined;
      for (const marker of l.markers.values()) marker.resolved = undefined;
      if (l.type === "nav_msgs/Path" && l.latest) this.path(l, l.latest);
    }
  }
  addTopic(t: Topic) {
    let l = this.layers.get(t.id);
    // Bridge channel IDs may be reused after an unadvertise/reconnect.
    if (l && (l.topic !== t.topic || l.type !== t.schemaName)) {
      this.removeTopic(t.id);
      l = undefined;
    }
    if (!l) {
      const root = new THREE.Group();
      this.scene.add(root);
      l = {
        id: t.id,
        topic: t.topic,
        type: t.schemaName,
        root,
        frame: "",
        stamp: 0n,
        enabled: t.enabled,
        status: "等待消息",
        count: 0,
        latest: undefined,
        markers: new Map(),
        history: [],
        settings: defaultLayerSettings(t.schemaName),
      };
      this.layers.set(t.id, l);
    }
    l.enabled = t.enabled;
    return l;
  }
  /** Appearance changes are immediate; callers may replay bounded cached cloud/scan
   * messages with ingest(..., true) when changing color mode or point budget. */
  configureTopic(t: Topic, settings: LayerSettings) {
    const l = this.addTopic(t);
    l.settings = normalizeLayerSettings(settings, l.type);
    this.applyAppearance(l);
    return l;
  }
  private applyAppearance(l: Layer, root: THREE.Object3D = l.root) {
    const markerLayer = l.type.startsWith("visualization_msgs/");
    const pointsLayer = l.type === "sensor_msgs/PointCloud2" || l.type === "sensor_msgs/LaserScan";
    const colorLayer = l.type === "nav_msgs/Path" || l.type === "nav_msgs/Odometry" || l.type === "geometry_msgs/PoseStamped";
    if (!markerLayer && !pointsLayer && !colorLayer && l.type !== "nav_msgs/OccupancyGrid") return;
    root.traverse((object) => {
      const drawable = object as THREE.Mesh;
      const materials = drawable.material ? (Array.isArray(drawable.material) ? drawable.material : [drawable.material]) : [];
      for (const material of materials) {
        let original = this.originalAppearance.get(material);
        if (!original) {
          original = { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
          this.originalAppearance.set(material, original);
        }
        material.opacity = l.settings.opacity * (markerLayer ? original.opacity : 1);
        const transparent = (markerLayer && original.transparent) || material.opacity < 1;
        if (material.transparent !== transparent) material.needsUpdate = true;
        material.transparent = transparent;
        material.depthWrite = original.depthWrite && material.opacity === 1;
        const colored = material as THREE.PointsMaterial;
        if (pointsLayer) {
          colored.size = l.settings.pointSize;
          const solid = l.type === "sensor_msgs/LaserScan" || l.settings.colorMode === "solid" || drawable.geometry?.userData.colorMode === "solid";
          const vertexColors = !solid && !!drawable.geometry?.getAttribute("color");
          if (colored.vertexColors !== vertexColors) colored.needsUpdate = true;
          colored.vertexColors = vertexColors;
          colored.color.set(vertexColors ? 0xffffff : l.settings.color);
          if (vertexColors && drawable.geometry.userData.solidIndices) {
            // Retain only bounded vertex indices for invalid scalar samples, so
            // their fallback color can change without caching a raw ROS message.
            const colors = drawable.geometry.getAttribute("color");
            const fallback = new THREE.Color(l.settings.color);
            for (const index of drawable.geometry.userData.solidIndices as Uint32Array)
              colors.setXYZ(index, fallback.r, fallback.g, fallback.b);
            colors.needsUpdate = true;
          }
        } else if (colorLayer && !colored.vertexColors) {
          // Preserve the red/green/blue axes beside a pose arrow.
          colored.color?.set(l.settings.color);
        }
      }
    });
  }
  removeTopic(id: number) {
    const l = this.layers.get(id);
    if (l) {
      this.clearLayer(l);
      dispose(l.root);
      this.layers.delete(id);
    }
  }
  clear(preserveStatic = false) {
    for (const id of [...this.layers.keys()]) this.removeTopic(id);
    preserveStatic ? this.tf.clearDynamic() : this.tf.clear();
    for (const a of this.axisObjects.values()) dispose(a);
    this.axisObjects.clear();
    this.markerCount = 0;
    this.markerVertices = 0;
    this.markerTexts = 0;
  }
  private clearLayer(l: Layer) {
    for (const c of [...l.root.children]) dispose(c);
    this.markerCount -= l.markers.size;
    for (const m of l.markers.values()) {
      this.markerVertices -= m.cost;
      this.markerTexts -= m.text ? 1 : 0;
    }
    l.markers.clear();
  }
  ingest(t: Topic, m: any, preserveTransform = false) {
    if (
      t.schemaName === "tf2_msgs/TFMessage" ||
      t.schemaName === "tf/tfMessage"
    ) {
      this.tf.update(m.transforms, t.topic.endsWith("tf_static"));
      const l = this.addTopic(t);
      l.status = `${m.transforms?.length ?? 0} 个变换`;
      l.count = this.tf.frames().length;
      return;
    }
    const l = this.addTopic(t);
    l.latest = l.type === "nav_msgs/Path" ? m : undefined;
    const frame = cleanFrame(m.header?.frame_id) || this.fixedFrame;
    const stamp = stampNs(m.header?.stamp);
    if (!preserveTransform || frame !== l.frame || stamp !== l.stamp) l.transform = undefined;
    l.frame = frame;
    l.stamp = stamp;
    l.warning = undefined;
    try {
      switch (l.type) {
        case "sensor_msgs/PointCloud2":
        case "sensor_msgs/LaserScan": {
          const decoded =
            l.type === "sensor_msgs/PointCloud2"
              ? decodePointCloud(m, l.settings.pointLimit, l.settings)
              : decodeLaserScan(m, l.settings.pointLimit);
          const geo = new THREE.BufferGeometry();
          geo.userData.colorMode = decoded.colorMode;
          geo.userData.solidIndices = decoded.solidIndices;
          geo.setAttribute(
            "position",
            new THREE.BufferAttribute(decoded.positions, 3),
          );
          if (decoded.colors)
            geo.setAttribute(
              "color",
              new THREE.BufferAttribute(decoded.colors, 3),
            );
          this.replace(
            l,
            new THREE.Points(
              geo,
              new THREE.PointsMaterial({
                color: decoded.colors ? 0xffffff : 0x61eacc,
                size: l.type.endsWith("LaserScan") ? 0.085 : 0.06,
                sizeAttenuation: true,
                vertexColors: !!decoded.colors,
              }),
            ),
          );
          l.count = decoded.count;
          l.warning = decoded.warning;
          l.status = `${l.count.toLocaleString()} 点${l.warning ? ` · ⚠ ${l.warning}` : ""}`;
          break;
        }
        case "nav_msgs/OccupancyGrid":
          this.map(l, m);
          break;
        case "nav_msgs/Path":
          this.path(l, m);
          break;
        case "nav_msgs/Odometry":
        case "geometry_msgs/PoseStamped":
          this.robotPose(l, m);
          break;
        case "visualization_msgs/Marker":
          this.marker(l, m);
          break;
        case "visualization_msgs/MarkerArray":
          for (const marker of m.markers ?? []) this.marker(l, marker);
          break;
        case "sensor_msgs/Image":
        case "sensor_msgs/CompressedImage":
          l.status = "图像面板";
          break;
        default:
          l.status = "可检查消息；无 3D 显示器";
      }
    } catch (e) {
      // Rejected metadata must never relocate the previous valid geometry.
      if (!l.type.startsWith("visualization_msgs/")) {
        this.clearLayer(l);
        l.count = 0;
      }
      l.status = `显示错误: ${String(e).slice(0, 100)}`;
    }
  }
  private replace(l: Layer, obj: THREE.Object3D) {
    this.clearLayer(l);
    l.root.add(obj);
    this.applyAppearance(l, obj);
  }
  private map(l: Layer, m: any) {
    const w = m.info?.width,
      h = m.info?.height,
      res = m.info?.resolution;
    if (
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      w < 1 ||
      h < 1 ||
      w * h > 4_194_304 ||
      !(res > 0) ||
      !Number.isFinite(res) ||
      m.data?.length < w * h
    )
      throw Error("地图尺寸、分辨率或数据无效（最多 4M 单元）");
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = m.data[i];
      const shade =
        v < 0 || v === 255 ? 62 : Math.round(220 - Math.min(100, v) * 1.9);
      rgba.set(
        [
          shade,
          shade + Math.min(15, 255 - shade),
          shade + Math.min(22, 255 - shade),
          255,
        ],
        i * 4,
      );
    }
    const texture = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
    texture.needsUpdate = true;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w * res, h * res),
      new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        opacity: 0.88,
        transparent: true,
        depthWrite: false,
      }),
    );
    mesh.position.set((w * res) / 2, (h * res) / 2, -0.012);
    const group = new THREE.Group();
    group.applyMatrix4(poseMatrix(m.info.origin));
    group.add(mesh);
    this.replace(l, group);
    l.count = w * h;
    l.status = `${w} × ${h} · ${res} m/格`;
  }
  private path(l: Layer, m: any) {
    const poses = (m.poses ?? []).slice(-5000),
      positions: number[] = [];
    let missing = 0;
    for (const p of poses) {
      const frame = cleanFrame(p.header?.frame_id) || l.frame,
        stamp = stampNs(p.header?.stamp) || l.stamp;
      const tf = this.tf.lookup(this.fixedFrame, frame, stamp);
      if (!tf) {
        missing++;
        continue;
      }
      const v = vec(p.pose?.position).applyMatrix4(tf);
      positions.push(v.x, v.y, v.z + 0.035);
    }
    // A missing frame must not create a misleading line across gaps.
    if (missing) {
      this.clearLayer(l);
      l.status = `缺少路径 TF（${missing} 个姿态）`;
      l.count = 0;
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    this.replace(
      l,
      new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0x4cf0c8 }),
      ),
    );
    l.root.matrix.identity();
    l.count = poses.length;
    l.status = `${poses.length} 个路径姿态`;
  }
  private robotPose(l: Layer, m: any) {
    const p = m.pose?.pose ?? m.pose;
    if (!p) return;
    const group = new THREE.Group();
    group.applyMatrix4(poseMatrix(p));
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 0.14),
      1.0,
      0xffcb71,
      0.35,
      0.28,
    );
    group.add(arrow, new THREE.AxesHelper(0.35));
    this.replace(l, group);
    l.count = 1;
    l.status = l.type.endsWith("Odometry") ? "里程计姿态" : "姿态";
  }
  private marker(l: Layer, m: any) {
    const key = `${m.ns ?? ""}/${m.id ?? 0}`;
    if (m.action === 3) {
      this.clearLayer(l);
      l.status = "已清除全部标记";
      l.count = 0;
      return;
    }
    const previous = l.markers.get(key);
    if (previous) {
      dispose(previous.object);
      l.markers.delete(key);
      this.markerCount--;
      this.markerVertices -= previous.cost;
      this.markerTexts -= previous.text ? 1 : 0;
    }
    if (m.action === 2) {
      l.count = l.markers.size;
      l.status = `${l.count} 个标记`;
      return;
    }
    if (m.action !== 0 && m.action !== undefined) {
      l.status = `不支持 marker action ${m.action}`;
      return;
    }
    if (this.markerCount >= 1000) {
      l.status = "标记上限 1000";
      return;
    }
    const group = new THREE.Group();
    const shape = new THREE.Group();
    shape.applyMatrix4(poseMatrix(m.pose));
    group.add(shape);
    const s = m.scale ?? { x: 1, y: 1, z: 1 },
      sx = Math.abs(s.x) || 0.01,
      sy = Math.abs(s.y) || 0.01,
      sz = Math.abs(s.z) || 0.01;
    const pts = (m.points ?? []).slice(0, 20000);
    const mat = material(m.color);
    let usedMat = false;
    if ([1, 2, 3].includes(m.type)) {
      const geom =
        m.type === 1
          ? new THREE.BoxGeometry(sx, sy, sz)
          : m.type === 2
            ? new THREE.SphereGeometry(0.5, 16, 10)
            : new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
      const mesh = new THREE.Mesh(geom, mat);
      usedMat = true;
      if (m.type === 2) mesh.scale.set(sx, sy, sz);
      if (m.type === 3) {
        mesh.rotation.x = Math.PI / 2;
        mesh.scale.set(sx, sz, sy);
      }
      shape.add(mesh);
    } else if (m.type === 0) {
      const a = pts.length >= 2 ? vec(pts[0]) : new THREE.Vector3(),
        b = pts.length >= 2 ? vec(pts[1]) : new THREE.Vector3(sx, 0, 0),
        d = b.clone().sub(a),
        len = d.length();
      shape.add(
        new THREE.ArrowHelper(
          d.normalize(),
          a,
          len,
          color(m.color).getHex(),
          Math.min(len * 0.4, pts.length >= 2 ? sz || len * 0.3 : sx * 0.3),
          pts.length >= 2 ? sy : sz,
        ),
      );
    } else if ([4, 5, 8, 11].includes(m.type)) {
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map(vec));
      const perColors = m.colors?.length === pts.length;
      if (perColors) {
        const cs = new Float32Array(pts.length * 3);
        m.colors.forEach((c: any, i: number) => cs.set([c.r, c.g, c.b], i * 3));
        geo.setAttribute("color", new THREE.BufferAttribute(cs, 3));
      }
      const params = {
        color: perColors ? 0xffffff : color(m.color),
        vertexColors: perColors,
        transparent: (m.color?.a ?? 1) < 1,
        opacity: m.color?.a ?? 1,
      };
      if (m.type === 8)
        shape.add(
          new THREE.Points(
            geo,
            new THREE.PointsMaterial({ ...params, size: sx }),
          ),
        );
      else if (m.type === 11) {
        geo.computeVertexNormals();
        shape.add(
          new THREE.Mesh(
            geo,
            new THREE.MeshStandardMaterial({
              ...params,
              side: THREE.DoubleSide,
            }),
          ),
        );
      } else
        shape.add(
          m.type === 4
            ? new THREE.Line(geo, new THREE.LineBasicMaterial(params))
            : new THREE.LineSegments(geo, new THREE.LineBasicMaterial(params)),
        );
    } else if ([6, 7].includes(m.type)) {
      const geom =
        m.type === 6
          ? new THREE.BoxGeometry(sx, sy, sz)
          : new THREE.SphereGeometry(0.5, 10, 6);
      const count = Math.min(pts.length, 3000),
        inst = new THREE.InstancedMesh(geom, mat, count);
      usedMat = true;
      for (let i = 0; i < count; i++) {
        const matrix = new THREE.Matrix4().compose(
          vec(pts[i]),
          new THREE.Quaternion(),
          m.type === 7
            ? new THREE.Vector3(sx, sy, sz)
            : new THREE.Vector3(1, 1, 1),
        );
        inst.setMatrixAt(i, matrix);
        if (m.colors?.[i]) inst.setColorAt(i, color(m.colors[i]));
      }
      shape.add(inst);
    } else if (m.type === 9) {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 128;
      const ctx = canvas.getContext("2d")!;
      ctx.font = "bold 46px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = `#${color(m.color).getHexString()}`;
      ctx.fillText(String(m.text ?? "").slice(0, 80), 256, 80, 500);
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: m.color?.a ?? 1,
        }),
      );
      sprite.scale.set(sz * 4, sz, 1);
      shape.add(sprite);
    } else {
      mat.dispose();
      l.status =
        m.type === 10
          ? "暂不支持 MESH_RESOURCE / URDF"
          : "不支持 marker 类型 " + m.type;
      return;
    }
    if (!usedMat) mat.dispose();
    if (m.type === 0) {
      // ArrowHelper constructs its own materials, outside material(m.color).
      group.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        for (const mat of material ? (Array.isArray(material) ? material : [material]) : []) {
          mat.opacity = m.color?.a ?? 1;
          mat.transparent = mat.opacity < 1;
        }
      });
    }
    let cost = 0;
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      cost +=
        (mesh.geometry?.getAttribute("position")?.count ?? 0) *
        ((mesh as THREE.InstancedMesh).isInstancedMesh
          ? (mesh as THREE.InstancedMesh).count
          : 1);
    });
    if (
      this.markerVertices + cost > 300000 ||
      (m.type === 9 && this.markerTexts >= 64)
    ) {
      dispose(group);
      l.status = "标记总预算已满（30万顶点 / 64文本）";
      return;
    }
    const lifetime = Number(stampNs(m.lifetime)) / 1e6;
    l.root.add(group);
    this.applyAppearance(l, group);
    l.markers.set(key, {
      object: group,
      frame: cleanFrame(m.header?.frame_id) || this.fixedFrame,
      stamp: stampNs(m.header?.stamp),
      locked: !!m.frame_locked,
      expires: lifetime > 0 ? performance.now() + lifetime : Infinity,
      cost,
      text: m.type === 9,
    });
    this.markerCount++;
    this.markerVertices += cost;
    this.markerTexts += m.type === 9 ? 1 : 0;
    l.count = l.markers.size;
    l.status = `${l.count} 个标记`;
  }
  render(now: number) {
    if (this.stopped) return;
    for (const l of this.layers.values()) {
      l.root.visible = l.enabled;
      if (!l.enabled) continue;
      if (l.type.startsWith("visualization_msgs/")) {
        l.root.matrixAutoUpdate = true;
        l.root.position.set(0, 0, 0);
        l.root.quaternion.identity();
        l.root.updateMatrix();
        let missing = 0;
        for (const [key, m] of l.markers) {
          if (now > m.expires) {
            dispose(m.object);
            l.markers.delete(key);
            this.markerCount--;
            this.markerVertices -= m.cost;
            this.markerTexts -= m.text ? 1 : 0;
            continue;
          }
          const tf =
            (!m.locked && m.resolved) ||
            this.tf.lookup(this.fixedFrame, m.frame, m.locked ? 0n : m.stamp);
          m.object.visible = !!tf;
          if (tf) {
            if (!m.locked) m.resolved = tf;
            m.object.matrixAutoUpdate = false;
            m.object.matrix.copy(tf);
          } else missing++;
        }
        l.count = l.markers.size;
        if (missing) l.status = `缺少 TF · ${missing} 个标记隐藏`;
        else if (
          l.status.startsWith("缺少 TF") ||
          /^\d+ 个标记$/.test(l.status)
        )
          l.status = `${l.count} 个标记`;
        continue;
      }
      if (l.type === "nav_msgs/Path") {
        if (l.status.startsWith("缺少路径 TF") && l.latest)
          this.path(l, l.latest);
        continue;
      }
      if (!l.frame) continue;
      const tf =
        l.transform ?? this.tf.lookup(this.fixedFrame, l.frame, l.stamp);
      if (tf) l.transform = tf;
      l.root.visible = l.enabled && !!tf;
      if (tf) {
        l.root.matrixAutoUpdate = false;
        l.root.matrix.copy(tf);
        if (l.status.startsWith("缺少 TF"))
          l.status = `${l.count.toLocaleString()} · TF 正常${l.warning ? ` · ⚠ ${l.warning}` : ""}`;
      } else l.status = `缺少 TF: ${l.frame} → ${this.fixedFrame}${l.warning ? ` · ⚠ ${l.warning}` : ""}`;
    }
    this.tfVisual.visible = this.showTf;
    if (this.showTf) {
      for (const frame of this.tf.frames().slice(0, 100)) {
        let axes = this.axisObjects.get(frame);
        if (!axes) {
          axes = new THREE.AxesHelper(0.5);
          this.axisObjects.set(frame, axes);
          this.tfVisual.add(axes);
        }
        const tf = this.tf.lookup(this.fixedFrame, frame, 0n);
        axes.visible = !!tf;
        if (tf) {
          axes.matrixAutoUpdate = false;
          axes.matrix.copy(tf);
        }
      }
    }
    if (this.followFrame) {
      const t = this.tf.lookup(this.fixedFrame, this.followFrame, 0n);
      if (t) {
        const target = new THREE.Vector3().setFromMatrixPosition(t),
          delta = target.clone().sub(this.controls.target);
        this.camera.position.add(delta);
        this.controls.target.copy(target);
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    if (now - this.frameStart >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.frameStart));
      this.frameStart = now;
      this.frames = 0;
    }
  }
  diagnostics() {
    return {
      fps: this.fps,
      drawCalls: this.renderer.info.render.calls,
      points: this.renderer.info.render.points,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      tfFrames: this.tf.frames(),
      layers: [...this.layers.values()].map((l) => ({
        id: l.id,
        topic: l.topic,
        type: l.type,
        enabled: l.enabled,
        status: l.status,
        count: l.count,
        visible: l.root.visible,
      })),
    };
  }
}
