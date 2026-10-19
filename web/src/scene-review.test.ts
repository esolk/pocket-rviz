import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Topic } from './client';

// Exercise real Three geometry and viewer scene state without claiming GPU/device QA.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class HeadlessRenderer {
    domElement = {};
    info = { render: { calls: 0, points: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } };
    setPixelRatio() {} setClearColor() {} setSize() {}
    render(scene: import('three').Scene) { scene.updateMatrixWorld(true); }
  }
  return { ...actual, WebGLRenderer: HeadlessRenderer };
});
vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three');
  return { OrbitControls: class {
    target = new Vector3(); touches = {}; mouseButtons = {};
    update() {}
  } };
});
import { ViewerScene } from './scene';
import { Color, Vector3 } from 'three';
import type { Mesh, Points, PointsMaterial, Line, LineBasicMaterial, MeshBasicMaterial } from 'three';
import { defaultLayerSettings } from './display-settings';

const topic = (schemaName: string, id = 1): Topic => ({
  id, topic: `/fixture/${id}`, schemaName, encoding: 'ros1', schema: '',
  enabled: true, supported: true, received: 0, bytes: 0, lastAt: 0,
});
const stamp = (sec: number) => ({ sec, nsec: 0 });
const pose = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
const transform = (sec: number, x: number, parent = 'map', child = 'base') => ({
  header: { frame_id: parent, stamp: stamp(sec) }, child_frame_id: child,
  transform: { translation: { x, y: 0, z: 0 }, rotation: pose.orientation },
});
const marker = (options: Record<string, unknown> = {}) => ({
  header: { frame_id: 'base', stamp: stamp(1) }, ns: 'fixture', id: 1,
  action: 0, type: 1, pose, scale: { x: 1, y: 1, z: 1 },
  color: { r: 1, g: 0, b: 0, a: 1 }, frame_locked: false,
  lifetime: stamp(0), ...options,
});
function viewer() {
  return new ViewerScene({ clientWidth: 800, clientHeight: 360, append() {} } as unknown as HTMLElement);
}
function firstMarker(v: ViewerScene) { return [...v.layers.get(1)!.markers.values()][0]; }
function xOf(object: import('three').Object3D) { return new Vector3().setFromMatrixPosition(object.matrix).x; }
function pointCloud(count = 1, frame = 'map', sec = 1) {
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) data[i * 3] = i;
  return { header: { frame_id: frame, stamp: stamp(sec) }, width: count, height: 1,
    fields: ['x', 'y', 'z'].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 })),
    point_step: 12, row_step: data.byteLength, data: new Uint8Array(data.buffer), is_bigendian: false };
}
const settings = (type = '', overrides = {}) => ({ ...defaultLayerSettings(type), ...overrides });
function points(v: ViewerScene, id = 1) { return v.layers.get(id)!.root.children[0] as Points<import('three').BufferGeometry, PointsMaterial>; }

describe('independent scene correctness regression review', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal('ResizeObserver', class { observe() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retains a resolved permanent unlocked Marker after its timestamp leaves TF history', () => {
    const v = viewer();
    v.tf.update([transform(1, 10)]);
    v.ingest(topic('visualization_msgs/Marker'), marker());
    v.render(0);
    expect(xOf(firstMarker(v).object)).toBe(10);
    v.tf.update([transform(20, 99)]);
    expect(v.tf.lookup('map', 'base', 1_000_000_000n)).toBeUndefined();
    v.render(1);
    expect(firstMarker(v).object.visible).toBe(true);
    expect(xOf(firstMarker(v).object)).toBe(10);
    expect(v.layers.get(1)!.status).not.toContain('缺少 TF');
  });

  it('freezes unlocked zero-stamp Marker, while frame_locked Marker follows latest TF', () => {
    const v = viewer();
    v.tf.update([transform(1, 10)]);
    const t = topic('visualization_msgs/MarkerArray');
    v.ingest(t, { markers: [marker({ header: { frame_id: 'base', stamp: stamp(0) } }), marker({ id: 2, frame_locked: true })] });
    v.render(0);
    v.tf.update([transform(2, 20)]);
    v.render(1);
    const [frozen, locked] = [...v.layers.get(1)!.markers.values()];
    expect(xOf(frozen.object)).toBe(10);
    expect(xOf(locked.object)).toBe(20);
  });

  it('retries a Marker transform that arrives after the Marker', () => {
    const v = viewer();
    v.ingest(topic('visualization_msgs/Marker'), marker());
    v.render(0);
    expect(firstMarker(v).object.visible).toBe(false);
    v.tf.update([transform(1, 10)]);
    v.render(1);
    expect(firstMarker(v).object.visible).toBe(true);
    expect(xOf(firstMarker(v).object)).toBe(10);
  });

  it('invalidates cached Marker transforms when the fixed frame changes', () => {
    const v = viewer();
    v.tf.update([transform(1, 10)]);
    v.tf.update([transform(0, 100, 'world', 'map')], true);
    v.ingest(topic('visualization_msgs/Marker'), marker());
    v.render(0);
    v.setFrame('world');
    v.render(1);
    expect(xOf(firstMarker(v).object)).toBe(110);
  });

  it('retains a stamped pose after TF expiry, and recomputes on the next message', () => {
    const v = viewer(), t = topic('geometry_msgs/PoseStamped');
    v.tf.update([transform(1, 10)]);
    v.ingest(t, { header: { frame_id: 'base', stamp: stamp(1) }, pose });
    v.render(0);
    v.tf.update([transform(20, 99)]);
    v.render(1);
    expect(v.layers.get(1)!.root.visible).toBe(true);
    expect(xOf(v.layers.get(1)!.root)).toBe(10);
    v.ingest(t, { header: { frame_id: 'base', stamp: stamp(20) }, pose });
    v.render(2);
    expect(xOf(v.layers.get(1)!.root)).toBe(99);
  });

  it('applies Marker DELETE, namespace+ID replacement, and DELETEALL within a layer', () => {
    const v = viewer(), t = topic('visualization_msgs/MarkerArray');
    v.ingest(t, { markers: [marker(), marker({ id: 2 }), marker({ ns: 'other' })] });
    expect(v.layers.get(1)!.markers.size).toBe(3);
    v.ingest(t, { markers: [marker({ action: 2 })] });
    expect(v.layers.get(1)!.markers.size).toBe(2);
    v.ingest(t, { markers: [marker({ id: 2 })] });
    expect(v.layers.get(1)!.markers.size).toBe(2);
    v.ingest(t, { markers: [marker({ action: 3 })] });
    expect(v.layers.get(1)!.markers.size).toBe(0);
    expect(v.layers.get(1)!.root.children.length).toBe(0);
  });

  it('expires a finite-lifetime Marker and releases its layer geometry', () => {
    const v = viewer();
    v.ingest(topic('visualization_msgs/Marker'), marker({ lifetime: stamp(1) }));
    const expires = firstMarker(v).expires;
    v.render(expires + 1);
    expect(v.layers.get(1)!.markers.size).toBe(0);
    expect(v.layers.get(1)!.root.children.length).toBe(0);
  });

  it('disposes instance attributes when a list Marker is replaced or deleted', () => {
    const v = viewer(), t = topic('visualization_msgs/Marker');
    const list = marker({ type: 6, points: [{ x: 0, y: 0, z: 0 }] });
    v.ingest(t, list);
    const instanced = firstMarker(v).object.children[0].children[0];
    const released = vi.fn();
    // Three's WebGLObjects removes instanceMatrix/instanceColor only on this event.
    instanced.addEventListener('dispose' as never, released);
    v.ingest(t, marker({ action: 2 }));
    expect(released).toHaveBeenCalledOnce();
    expect(v.layers.get(1)!.markers.size).toBe(0);
  });

  it('caps aggregate Marker vertices and releases the budget on deletion', () => {
    const v = viewer(), t = topic('visualization_msgs/Marker');
    const points = Array.from({ length: 20000 }, () => ({ x: 0, y: 0, z: 0 }));
    for (let id = 0; id < 16; id++) v.ingest(t, marker({ type: 8, id, points }));
    expect(v.layers.get(1)!.markers.size).toBe(15);
    expect(v.layers.get(1)!.status).toContain('预算');
    v.ingest(t, marker({ id: 0, action: 2 }));
    v.ingest(t, marker({ type: 8, id: 15, points }));
    expect(v.layers.get(1)!.markers.size).toBe(15);
    expect(v.layers.get(1)!.markers.has('fixture/15')).toBe(true);
  });

  it('keeps latched static TF but removes dynamic TF on ROS-clock rollback reset', () => {
    const v = viewer();
    v.tf.update([transform(1, 10)]);
    v.tf.update([transform(0, 2, 'base', 'lidar')], true);
    v.ingest(topic('visualization_msgs/Marker'), marker());
    v.clear(true);
    expect(v.layers.size).toBe(0);
    expect(v.tf.lookup('base', 'lidar', 1n)).toBeDefined();
    expect(v.tf.lookup('map', 'base')).toBeUndefined();
  });

  it('does not relocate old cloud geometry using a rejected packet header', () => {
    const v = viewer(), t = topic('sensor_msgs/PointCloud2');
    v.tf.update([transform(1, 10), transform(2, 20)]);
    const cloud = {
      header: { frame_id: 'base', stamp: stamp(1) }, width: 1, height: 1,
      fields: ['x', 'y', 'z'].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 })),
      point_step: 12, row_step: 12, data: new Uint8Array(12), is_bigendian: false,
    };
    v.ingest(t, cloud); v.render(0);
    expect(xOf(v.layers.get(1)!.root)).toBe(10);
    v.ingest(t, { ...cloud, point_step: 0, header: { frame_id: 'base', stamp: stamp(2) } });
    v.render(1);
    const layer = v.layers.get(1)!;
    expect(layer.status).toContain('显示错误');
    // Either clear rejected geometry or retain it with its old transform.
    expect(layer.root.children.length === 0 || xOf(layer.root) === 10).toBe(true);
  });

  it('changes point materials immediately and independently without rebuilding or retaining raw clouds', () => {
    const v = viewer(), first = topic('sensor_msgs/PointCloud2'), second = topic('sensor_msgs/PointCloud2', 2);
    v.configureTopic(first, settings(first.schemaName, { colorMode: 'solid', color: '#ff0000', pointSize: 0.12, opacity: 0.4 }));
    v.ingest(first, pointCloud()); v.ingest(second, pointCloud());
    const object = points(v), geometry = object.geometry, mat = object.material;
    expect(mat.color.getHexString()).toBe('ff0000');
    expect(mat.size).toBe(0.12); expect(mat.opacity).toBe(0.4);
    expect(mat.vertexColors).toBe(false); expect(mat.transparent).toBe(true); expect(mat.depthWrite).toBe(false);
    v.configureTopic(first, settings(first.schemaName, { colorMode: 'solid', color: '#804020', pointSize: 0.2, opacity: 1 }));
    expect(points(v)).toBe(object); expect(points(v).geometry).toBe(geometry); expect(points(v).material).toBe(mat);
    expect(mat.color.getHexString()).toBe('804020'); expect(mat.size).toBe(0.2);
    expect(mat.opacity).toBe(1); expect(mat.transparent).toBe(false); expect(mat.depthWrite).toBe(true);
    expect(points(v, 2).material.size).toBe(0.06);
    expect(points(v, 2).material.opacity).toBe(1);
    expect(points(v, 2).material.vertexColors).toBe(true);
    expect(v.layers.get(1)!.latest).toBeUndefined();
  });

  it('bounds each cloud separately and disposes replaced geometry and material on settings replay', () => {
    const v = viewer(), t = topic('sensor_msgs/PointCloud2'), other = topic('sensor_msgs/PointCloud2', 2), cloud = pointCloud(6000);
    v.configureTopic(t, settings(t.schemaName, { pointLimit: 1000 }));
    v.configureTopic(other, settings(other.schemaName, { pointLimit: 2000 }));
    v.ingest(t, cloud); v.ingest(other, cloud);
    expect(v.layers.get(1)!.count).toBe(1000); expect(v.layers.get(2)!.count).toBe(2000);
    const geometryDisposed = vi.fn(), materialDisposed = vi.fn();
    points(v).geometry.addEventListener('dispose', geometryDisposed);
    points(v).material.addEventListener('dispose', materialDisposed);
    v.configureTopic(t, settings(t.schemaName, { pointLimit: 3000, colorMode: 'height' }));
    v.ingest(t, cloud, true);
    expect(v.layers.get(1)!.count).toBe(3000); expect(v.layers.get(2)!.count).toBe(2000);
    expect(geometryDisposed).toHaveBeenCalledOnce(); expect(materialDisposed).toHaveBeenCalledOnce();
    expect(v.layers.get(1)!.root.children).toHaveLength(1);
  });

  it.each([0, 1])('keeps resolved cloud TF during a display replay at stamp %i after history has expired', (sec) => {
    const v = viewer(), t = topic('sensor_msgs/PointCloud2'), cloud = pointCloud(3, 'base', sec);
    v.tf.update([transform(1, 10)]);
    v.ingest(t, cloud); v.render(0);
    v.tf.update([transform(20, 99)]);
    v.configureTopic(t, settings(t.schemaName, { colorMode: 'solid' }));
    v.ingest(t, cloud, true); v.render(1);
    expect(v.layers.get(1)!.root.visible).toBe(true);
    expect(xOf(v.layers.get(1)!.root)).toBe(10);
    v.ingest(t, pointCloud(3, 'base', sec ? 20 : 0)); v.render(2);
    expect(xOf(v.layers.get(1)!.root)).toBe(99);
  });

  it('does not keep a previous TF when replay metadata changes or the fixed frame changes', () => {
    const v = viewer(), t = topic('sensor_msgs/PointCloud2');
    v.tf.update([transform(1, 10), transform(2, 20)]);
    v.tf.update([transform(0, 100, 'world', 'map')], true);
    v.ingest(t, pointCloud(1, 'base', 1)); v.render(0);
    v.ingest(t, pointCloud(1, 'base', 2), true); v.render(1);
    expect(xOf(v.layers.get(1)!.root)).toBe(20);
    v.setFrame('world'); v.ingest(t, pointCloud(1, 'base', 2), true); v.render(2);
    expect(xOf(v.layers.get(1)!.root)).toBe(120);
  });

  it('shows explicit color-mode fallback through TF resolution and recolors it immediately', () => {
    const v = viewer(), t = topic('sensor_msgs/PointCloud2');
    v.configureTopic(t, settings(t.schemaName, { colorMode: 'rgb', color: '#ff0000' }));
    v.ingest(t, pointCloud(1, 'base', 1));
    expect(v.layers.get(1)!.status).toContain('RGB');
    expect(points(v).material.vertexColors).toBe(false);
    expect(points(v).material.color.getHexString()).toBe('ff0000');
    v.render(0); expect(v.layers.get(1)!.status).toContain('RGB');
    v.tf.update([transform(1, 10)]); v.render(1);
    expect(v.layers.get(1)!.status).toContain('RGB');
    v.configureTopic(t, settings(t.schemaName, { colorMode: 'rgb', color: '#0000ff' }));
    expect(points(v).material.color.getHexString()).toBe('0000ff');
  });

  it('updates only invalid-intensity fallback vertices when the solid color changes', () => {
    const v = viewer(), t = topic('sensor_msgs/PointCloud2');
    const data = new Float32Array([0, 0, 0, 0, 1, 0, 0, NaN, 2, 0, 0, 100]);
    v.configureTopic(t, settings(t.schemaName, { colorMode: 'intensity', color: '#ff0000' }));
    v.ingest(t, { ...pointCloud(3), point_step: 16, row_step: data.byteLength, data: new Uint8Array(data.buffer),
      fields: [...pointCloud().fields, { name: 'intensity', offset: 12, datatype: 7, count: 1 }] });
    const geometry = points(v).geometry, colors = geometry.getAttribute('color');
    expect([colors.getX(1), colors.getY(1), colors.getZ(1)]).toEqual([1, 0, 0]);
    v.configureTopic(t, settings(t.schemaName, { colorMode: 'intensity', color: '#0000ff' }));
    expect(points(v).geometry).toBe(geometry);
    expect([colors.getX(1), colors.getY(1), colors.getZ(1)]).toEqual([0, 0, 1]);
    expect(colors.getX(0)).toBeCloseTo(0.2); expect(colors.getX(2)).toBe(1);
  });

  it('restores normalized settings after clear and parent reconfiguration', () => {
    const v = viewer(), t = topic('sensor_msgs/PointCloud2');
    const saved = settings(t.schemaName, { colorMode: 'solid' as const, color: '#ff00ff', opacity: 0.5, pointSize: 0.3 });
    v.configureTopic(t, saved); v.ingest(t, pointCloud());
    v.clear(); v.addTopic(t); v.configureTopic(t, saved); v.ingest(t, pointCloud());
    expect(v.layers.get(1)!.settings).toEqual(saved);
    expect(points(v).material.color.getHexString()).toBe('ff00ff');
    expect(points(v).material.opacity).toBe(0.5);
    expect(points(v).material.size).toBe(0.3);
    saved.color = '#000000';
    expect(v.layers.get(1)!.settings.color).toBe('#ff00ff');
  });

  it.each(['topic', 'type'])('replaces the old layer when a channel ID is reused for another %s', (change) => {
    const v = viewer(), t = topic('sensor_msgs/PointCloud2');
    v.configureTopic(t, settings(t.schemaName, { color: '#ff0000', pointSize: 0.3 })); v.ingest(t, pointCloud());
    const old = v.layers.get(1)!, geometryDisposed = vi.fn(), materialDisposed = vi.fn();
    points(v).geometry.addEventListener('dispose', geometryDisposed); points(v).material.addEventListener('dispose', materialDisposed);
    const next = change === 'topic' ? { ...t, topic: '/replacement' } : { ...t, schemaName: 'sensor_msgs/LaserScan' };
    const layer = v.addTopic(next);
    expect(layer).not.toBe(old); expect(old.root.parent).toBeNull();
    expect(layer.root.children).toHaveLength(0); expect(layer.settings).toEqual(defaultLayerSettings(next.schemaName));
    expect(geometryDisposed).toHaveBeenCalledOnce(); expect(materialDisposed).toHaveBeenCalledOnce();
  });

  it('applies LaserScan solid color, opacity, size and per-layer point limits', () => {
    const v = viewer(), t = topic('sensor_msgs/LaserScan');
    v.configureTopic(t, settings(t.schemaName, { color: '#123456', pointSize: 0.18, opacity: 0.6, pointLimit: 1000 }));
    v.ingest(t, { header: { frame_id: 'map' }, angle_min: 0, angle_increment: 0.001, range_min: 0, range_max: 10,
      ranges: new Float32Array(3000).fill(1), intensities: new Float32Array(3000).fill(5) });
    expect(v.layers.get(1)!.count).toBe(1000);
    expect(points(v).material.size).toBe(0.18); expect(points(v).material.opacity).toBe(0.6);
    expect(points(v).material.vertexColors).toBe(false); expect(points(v).material.color.getHexString()).toBe('123456');
    v.configureTopic(t, settings(t.schemaName, { color: '#abcdef', opacity: 0.2 }));
    expect(points(v).material.color.getHexString()).toBe('abcdef'); expect(points(v).material.opacity).toBe(0.2);
  });

  it('updates Path and Pose color/opacity without requiring another message or TF lookup', () => {
    const v = viewer(), pathTopic = topic('nav_msgs/Path'), poseTopic = topic('geometry_msgs/PoseStamped', 2);
    v.tf.update([transform(1, 10)]);
    v.ingest(pathTopic, { header: { frame_id: 'base', stamp: stamp(1) }, poses: [{ pose }] });
    v.ingest(poseTopic, { header: { frame_id: 'base', stamp: stamp(1) }, pose }); v.render(0);
    const line = v.layers.get(1)!.root.children[0] as Line<import('three').BufferGeometry, LineBasicMaterial>;
    const group = v.layers.get(2)!.root.children[0], arrow = group.children[0];
    v.tf.update([transform(20, 99)]);
    v.configureTopic(pathTopic, settings(pathTopic.schemaName, { color: '#ff0000', opacity: 0.2 }));
    v.configureTopic(poseTopic, settings(poseTopic.schemaName, { color: '#0000ff', opacity: 0.4 })); v.render(1);
    expect(v.layers.get(1)!.root.children[0]).toBe(line);
    expect(line.material.color.getHexString()).toBe('ff0000'); expect(line.material.opacity).toBe(0.2);
    expect(xOf(v.layers.get(2)!.root)).toBe(10);
    for (const child of arrow.children) {
      const material = (child as Mesh).material as MeshBasicMaterial;
      expect(material.color.getHexString()).toBe('0000ff'); expect(material.opacity).toBe(0.4);
    }
    const axisMaterial = (group.children[1] as Line).material as LineBasicMaterial;
    expect(axisMaterial.vertexColors).toBe(true); expect(axisMaterial.opacity).toBe(0.4);
  });

  it('updates map opacity immediately and disposes its texture when removed', () => {
    const v = viewer(), t = topic('nav_msgs/OccupancyGrid');
    v.ingest(t, { header: { frame_id: 'map' }, info: { width: 1, height: 1, resolution: 1, origin: pose }, data: [0] });
    const mesh = v.layers.get(1)!.root.children[0].children[0] as Mesh<import('three').BufferGeometry, MeshBasicMaterial>;
    expect(mesh.material.opacity).toBe(0.88);
    v.configureTopic(t, settings(t.schemaName, { opacity: 0.3 }));
    expect(mesh.material.opacity).toBe(0.3); expect(mesh.material.depthWrite).toBe(false);
    v.configureTopic(t, settings(t.schemaName, { opacity: 1 }));
    expect(mesh.material.opacity).toBe(1); expect(mesh.material.depthWrite).toBe(false);
    const disposed = vi.fn(); mesh.material.map!.addEventListener('dispose', disposed);
    v.removeTopic(t.id); expect(disposed).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 4, 6, 8])('multiplies Marker type %i alpha from its original value without accumulating', (type) => {
    const v = viewer(), t = topic('visualization_msgs/Marker');
    v.configureTopic(t, settings(t.schemaName, { opacity: 0.5 }));
    v.ingest(t, marker({ type, points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], color: { r: 1, g: 0, b: 0, a: 0.4 } }));
    function check(opacity: number) {
      firstMarker(v).object.traverse(object => {
        const material = (object as Mesh).material;
        for (const mat of material ? (Array.isArray(material) ? material : [material]) : []) {
          expect(mat.opacity).toBeCloseTo(opacity);
          expect((mat as MeshBasicMaterial).color).toEqual(new Color(1, 0, 0));
        }
      });
    }
    check(0.2);
    v.configureTopic(t, settings(t.schemaName, { opacity: 0.25 })); check(0.1);
    v.configureTopic(t, settings(t.schemaName, { opacity: 1 })); check(0.4);
  });
});
