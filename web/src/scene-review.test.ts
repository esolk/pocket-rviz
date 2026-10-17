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
import { Vector3 } from 'three';

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
});
