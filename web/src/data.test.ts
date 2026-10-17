import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { bytes, cleanFrame, decodeImage, decodeLaserScan, decodePointCloud, stampNs, TfTree } from './data';

const transform = (parent: string, child: string, time: number, translation = [0, 0, 0], rotation = [0, 0, 0, 1]) => ({
  header: { frame_id: parent, stamp: { secs: 0, nsecs: time } }, child_frame_id: child,
  transform: { translation: { x: translation[0], y: translation[1], z: translation[2] }, rotation: { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] } },
});
const position = (matrix: Matrix4 | undefined, point = new Vector3()) => {
  expect(matrix).toBeDefined();
  return point.applyMatrix4(matrix!).toArray();
};
const closeVector = (actual: number[], expected: number[]) => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 5));

describe('timestamps and frames', () => {
  it('reads both ROS1 and deserialized timestamps without losing epoch nanoseconds', () => {
    expect(stampNs({ secs: 1_700_000_000, nsecs: 123 })).toBe(1_700_000_000_000_000_123n);
    expect(stampNs({ sec: 42, nsec: 51 })).toBe(42_000_000_051n);
    expect(stampNs({ sec: 1n, nanosec: 2n })).toBe(1_000_000_002n);
    expect(stampNs(undefined)).toBe(0n);
    expect(stampNs({ secs: NaN })).toBe(0n);
    expect(stampNs({ secs: -1 })).toBe(0n);
    expect(stampNs({ secs: 0.5 })).toBe(0n);
  });
  it('normalizes legacy leading slashes', () => {
    expect(cleanFrame(' //base_link ')).toBe('base_link');
    expect(cleanFrame('robot/camera')).toBe('robot/camera');
  });
});

describe('TfTree', () => {
  it('composes rotated parent-child transforms in the correct order', () => {
    const tree = new TfTree();
    tree.update([
      transform('map', 'base', 2, [10, 0, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]),
      transform('base', 'laser', 2, [1, 0, 0]),
    ], true);
    closeVector(position(tree.lookup('/map', '/laser')), [10, 1, 0]);
    closeVector(position(tree.lookup('laser', 'map'), new Vector3(10, 1, 0)), [0, 0, 0]);
  });
  it('traverses arbitrary reverse/forward sibling chains', () => {
    const tree = new TfTree();
    tree.update([transform('world', 'a', 0, [2, 0, 0]), transform('world', 'b', 0, [0, 3, 0]), transform('b', 'c', 0, [0, 0, 4])], true);
    closeVector(position(tree.lookup('a', 'c')), [-2, 3, 4]);
    closeVector(position(tree.lookup('c', 'a')), [2, -3, -4]);
    expect(tree.lookup('world', 'unknown')).toBeUndefined();
    expect(tree.lookup('world', '')).toBeUndefined();
    expect(tree.lookup('world', 'world')).toEqual(new Matrix4());
  });
  it('interpolates translation and quaternion rotation at a message timestamp', () => {
    const tree = new TfTree();
    tree.update([transform('world', 'base', 10), transform('world', 'base', 30, [10, 0, 0], [0, 0, 1, 0])]);
    closeVector(position(tree.lookup('world', 'base', 20n), new Vector3(1, 0, 0)), [5, 1, 0]);
    expect(tree.lookup('world', 'base', 9n)).toBeUndefined();
    expect(tree.lookup('world', 'base', 31n)).toBeUndefined();
    closeVector(position(tree.lookup('world', 'base', 30n)), [10, 0, 0]);
  });
  it('uses latest common time across the whole chain', () => {
    const tree = new TfTree();
    tree.update([
      transform('world', 'base', 10, [0, 0, 0]), transform('world', 'base', 30, [20, 0, 0]),
      transform('base', 'laser', 10, [0, 1, 0]), transform('base', 'laser', 20, [0, 2, 0]),
    ]);
    closeVector(position(tree.lookup('world', 'laser')), [10, 2, 0]);
    closeVector(position(tree.lookup('world', 'laser', 0n)), [10, 2, 0]);
    expect(tree.lookup('world', 'laser', 25n)).toBeUndefined();
  });
  it('does not synthesize a chain when dynamic histories do not overlap', () => {
    const tree = new TfTree();
    tree.update([transform('world', 'base', 5), transform('base', 'laser', 10)]);
    expect(tree.lookup('world', 'laser')).toBeUndefined();
  });
  it('handles out-of-order and duplicate samples deterministically', () => {
    const tree = new TfTree();
    tree.update([transform('world', 'base', 30, [30, 0, 0]), transform('world', 'base', 10, [10, 0, 0]), transform('world', 'base', 20, [20, 0, 0])]);
    tree.update([transform('world', 'base', 20, [40, 0, 0])]);
    closeVector(position(tree.lookup('world', 'base', 15n)), [25, 0, 0]);
    closeVector(position(tree.lookup('world', 'base')), [30, 0, 0]);
  });
  it('bounds dynamic history by count and age', () => {
    const countTree = new TfTree(2, 100n);
    countTree.update([transform('map', 'base', 10), transform('map', 'base', 20), transform('map', 'base', 30)]);
    expect(countTree.lookup('map', 'base', 10n)).toBeUndefined();
    expect(countTree.lookup('map', 'base', 20n)).toBeDefined();
    const ageTree = new TfTree(20, 10n);
    ageTree.update([transform('map', 'base', 10), transform('map', 'base', 20), transform('map', 'base', 30)]);
    expect(ageTree.lookup('map', 'base', 19n)).toBeUndefined();
    expect(ageTree.lookup('map', 'base', 20n)).toBeDefined();
    ageTree.update([transform('map', 'base', 1)]);
    expect(ageTree.lookup('map', 'base', 1n)).toBeUndefined();
  });
  it('keeps static transforms timeless and replaces their single stored value', () => {
    const tree = new TfTree(1, 1n);
    tree.update([transform('base', 'laser', 100, [1, 0, 0])], true);
    expect(tree.lookup('base', 'laser', 1n)).toBeDefined();
    expect(tree.lookup('base', 'laser', 999999999n)).toBeDefined();
    tree.update([transform('base', 'laser', 200, [2, 0, 0])], true);
    closeVector(position(tree.lookup('base', 'laser', 1n)), [2, 0, 0]);
    expect(tree.frames()).toEqual(['base', 'laser']);
    tree.clear();
    expect(tree.frames()).toEqual([]);
    expect(tree.lookup('base', 'laser')).toBeUndefined();
  });
  it('clears only dynamic history after a ROS clock rollback', () => {
    const tree = new TfTree();
    tree.update([transform('base', 'laser', 100, [0.5, 0, 0])], true);
    tree.update([transform('map', 'base', 100, [10, 0, 0])]);
    tree.clearDynamic();
    closeVector(position(tree.lookup('base', 'laser', 1n)), [0.5, 0, 0]);
    expect(tree.lookup('map', 'laser')).toBeUndefined();
    expect(tree.frames()).toEqual(['base', 'laser']);
    tree.update([transform('map', 'base', 1, [2, 0, 0])]);
    closeVector(position(tree.lookup('map', 'laser', 1n)), [2.5, 0, 0]);
  });
  it('switches static/dynamic authority without keeping a stale parallel edge', () => {
    const tree = new TfTree();
    tree.update([transform('old', 'child', 1)], true);
    tree.update([transform('new', 'child', 10)]);
    expect(tree.frames()).toEqual(['child', 'new']);
    expect(tree.lookup('old', 'child')).toBeUndefined();
    expect(tree.lookup('new', 'child', 1n)).toBeUndefined();
    tree.update([transform('fixed', 'child', 5)], true);
    expect(tree.lookup('new', 'child')).toBeUndefined();
    expect(tree.lookup('fixed', 'child', 1n)).toBeDefined();
  });
  it('does not interpolate across reparenting and finds the latest historical chain', () => {
    const tree = new TfTree();
    tree.update([
      transform('world', 'a', 10, [1, 0, 0]), transform('world', 'a', 20, [2, 0, 0]),
      transform('a', 'child', 10, [0, 1, 0]), transform('a', 'child', 15, [0, 2, 0]),
      transform('unconnected', 'child', 20),
    ]);
    expect(tree.lookup('world', 'child', 17n)).toBeUndefined();
    closeVector(position(tree.lookup('world', 'child')), [1.5, 2, 0]);
    expect(tree.lookup('unconnected', 'child', 20n)).toBeDefined();
  });
  it('normalizes valid quaternions and ignores invalid transform input', () => {
    const tree = new TfTree();
    tree.update([
      transform('world', 'base', 1, [1, 2, 3], [0, 0, 0, 2]),
      transform('world', 'bad', 1, [NaN, 0, 0]),
      transform('world', 'zero', 1, [0, 0, 0], [0, 0, 0, 0]),
      transform('same', 'same', 1), null as any,
    ]);
    closeVector(position(tree.lookup('world', 'base')), [1, 2, 3]);
    expect(tree.frames()).toEqual(['base', 'world']);
  });
  it('combines timeless static mounts with timestamped dynamics', () => {
    const tree = new TfTree();
    tree.update([transform('base', 'sensor', 999, [0, 2, 0])], true);
    tree.update([transform('world', 'base', 10, [1, 0, 0]), transform('world', 'base', 20, [3, 0, 0])]);
    closeVector(position(tree.lookup('world', 'sensor', 15n)), [2, 2, 0]);
    closeVector(position(tree.lookup('world', 'sensor')), [3, 2, 0]);
    expect(tree.lookup('world', 'sensor', 21n)).toBeUndefined();
  });
  it('interpolates antipodal quaternion representations without spinning', () => {
    const tree = new TfTree();
    tree.update([transform('world', 'base', 10), transform('world', 'base', 20, [0, 0, 0], [0, 0, 0, -1])]);
    closeVector(position(tree.lookup('world', 'base', 15n), new Vector3(1, 0, 0)), [1, 0, 0]);
  });
  it('preserves interpolation precision at epoch-scale timestamps', () => {
    const tree = new TfTree();
    const a = transform('world', 'base', 100, [0, 0, 0]);
    const b = transform('world', 'base', 200, [10, 0, 0]);
    a.header.stamp.secs = b.header.stamp.secs = 1_700_000_000;
    tree.update([a, b]);
    closeVector(position(tree.lookup('world', 'base', 1_700_000_000_000_000_150n)), [5, 0, 0]);
  });
  it('caps total children while allowing updates and authority changes for retained children', () => {
    const tree = new TfTree();
    tree.update(Array.from({ length: 512 }, (_, i) => transform('map', `f${i}`, 1)), true);
    tree.update([transform('map', 'overflow', 1)], true);
    expect(tree.frames()).toHaveLength(513);
    expect(tree.lookup('map', 'overflow')).toBeUndefined();
    tree.update([transform('map', 'f0', 10, [9, 0, 0])]);
    closeVector(position(tree.lookup('map', 'f0')), [9, 0, 0]);
    tree.update([transform('map', 'overflow', 11)]);
    expect(tree.lookup('map', 'overflow')).toBeUndefined();
  });
  it('rejects frame names beyond 256 characters', () => {
    const tree = new TfTree();
    tree.update([transform('map', 'x'.repeat(257), 1), transform('y'.repeat(257), 'child', 1), transform('map', 'z'.repeat(256), 1)]);
    expect(tree.frames()).toEqual(['map', 'z'.repeat(256)]);
    expect(tree.lookup('x'.repeat(257), 'x'.repeat(257))).toBeUndefined();
  });
  it('limits processing to 2048 transforms per input batch', () => {
    const tree = new TfTree();
    tree.update(Array.from({ length: 2049 }, (_, i) => transform('map', 'child', i, [i, 0, 0])), true);
    closeVector(position(tree.lookup('map', 'child')), [2047, 0, 0]);
  });
  it('terminates even if a malformed producer publishes a cycle', () => {
    const tree = new TfTree();
    tree.update([transform('a', 'b', 1), transform('b', 'c', 1), transform('c', 'a', 1)], true);
    expect(tree.lookup('unconnected', 'a')).toBeUndefined();
  });
});

describe('binary bytes', () => {
  it('accepts byte arrays, base64, ArrayBuffer and typed views with offsets', () => {
    expect([...bytes([0, 255, 127])]).toEqual([0, 255, 127]);
    expect([...bytes('AP9/')]).toEqual([0, 255, 127]);
    expect([...bytes('data:application/octet-stream;base64,AP9/')]).toEqual([0, 255, 127]);
    const buffer = new Uint8Array([9, 1, 2, 3, 8]);
    expect([...bytes(buffer.subarray(1, 4))]).toEqual([1, 2, 3]);
    expect([...bytes(new DataView(buffer.buffer, 1, 3))]).toEqual([1, 2, 3]);
    expect([...bytes(new Uint8Array([4, 5]).buffer)]).toEqual([4, 5]);
  });
  it('rejects malformed representations', () => {
    for (const bad of [[-1], [256], [1.5], ['1'], {}, null, '!!not base64']) expect(() => bytes(bad)).toThrow();
  });
});

const field = (name: string, offset: number, datatype = 7, count = 1) => ({ name, offset, datatype, count });
const cloud = (points: number[][], extra: Record<string, unknown> = {}) => {
  const data = new Uint8Array(points.length * 12);
  const view = new DataView(data.buffer);
  points.forEach((p, i) => p.forEach((v, axis) => view.setFloat32(i * 12 + axis * 4, v, true)));
  return { width: points.length, height: 1, point_step: 12, row_step: data.length, fields: [field('x', 0), field('y', 4), field('z', 8)], data, is_bigendian: false, ...extra };
};
const setNumeric = (view: DataView, offset: number, type: number, value: number, little: boolean) => {
  switch (type) {
    case 1: view.setInt8(offset, value); break;
    case 2: view.setUint8(offset, value); break;
    case 3: view.setInt16(offset, value, little); break;
    case 4: view.setUint16(offset, value, little); break;
    case 5: view.setInt32(offset, value, little); break;
    case 6: view.setUint32(offset, value, little); break;
    case 7: view.setFloat32(offset, value, little); break;
    case 8: view.setFloat64(offset, value, little); break;
  }
};

describe('PointCloud2 decoding', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('decodes datatype %i at nontrivial offsets in both endiannesses', (datatype) => {
    for (const little of [true, false]) {
      const size = [0, 1, 1, 2, 2, 4, 4, 4, 8][datatype];
      const pointStep = size * 3 + 5;
      const backing = new Uint8Array(pointStep + 8);
      const data = backing.subarray(3, 3 + pointStep);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const expected = [5, 10, 15];
      expected.forEach((v, i) => setNumeric(view, 2 + i * size, datatype, v, little));
      const result = decodePointCloud({ width: 1, height: 1, point_step: pointStep, row_step: pointStep, fields: [field('z', 2 + 2 * size, datatype), field('x', 2, datatype), field('y', 2 + size, datatype)], data, is_bigendian: !little });
      expect(result.count).toBe(1);
      expect([...result.positions]).toEqual(expected);
    }
  });
  it('handles signed and float values rather than interpreting everything as FLOAT32', () => {
    const data = new Uint8Array(18), view = new DataView(data.buffer);
    view.setInt16(0, -1234, true); view.setFloat64(2, -0.125, true); view.setUint32(10, 4_000_000_000, true);
    const result = decodePointCloud({ width: 1, height: 1, point_step: 18, row_step: 18, fields: [field('x', 0, 3), field('y', 2, 8), field('z', 10, 6)], data });
    expect([...result.positions]).toEqual([-1234, -0.125, 4_000_000_000]);
  });
  it('respects organized row_step padding, field offsets and point stride', () => {
    const data = new Uint8Array(80).fill(255), view = new DataView(data.buffer);
    const expected = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
    expected.forEach((p, i) => p.forEach((v, axis) => view.setFloat32(Math.floor(i / 2) * 40 + (i % 2) * 16 + axis * 4, v, true)));
    const result = decodePointCloud({ ...cloud([]), width: 2, height: 2, point_step: 16, row_step: 40, data });
    expect(result.count).toBe(4);
    expect([...result.positions]).toEqual(expected.flat());
  });
  it.each(['rgb', 'rgba'])('bit-casts packed %s FLOAT32, including NaN bit patterns', (name) => {
    for (const little of [true, false]) {
      const data = new Uint8Array(16), view = new DataView(data.buffer);
      [1, 2, 3].forEach((v, i) => view.setFloat32(i * 4, v, little));
      view.setUint32(12, 0xffff8040, little);
      const result = decodePointCloud({ width: 1, height: 1, point_step: 16, row_step: 16, fields: [field('x', 0), field('y', 4), field('z', 8), field(name, 12)], data, is_bigendian: !little });
      expect(result.count).toBe(1);
      closeVector([...result.colors!], [1, 128 / 255, 64 / 255]);
    }
  });
  it('reads UINT32 packed color and gives packed color priority over intensity', () => {
    const data = new Uint8Array(20), view = new DataView(data.buffer);
    view.setUint32(12, 0x123456, true); view.setFloat32(16, 100, true);
    const result = decodePointCloud({ width: 1, height: 1, point_step: 20, row_step: 20, fields: [field('x', 0), field('y', 4), field('z', 8), field('rgba', 12, 6), field('intensity', 16)], data });
    closeVector([...result.colors!], [0x12 / 255, 0x34 / 255, 0x56 / 255]);
  });
  it('colors by intensity or relative height when packed color is absent', () => {
    const input = cloud([[0, 0, 0], [0, 0, 10]]);
    const height = decodePointCloud(input);
    expect([...height.colors!]).toEqual([0, 0, 1, 1, 0, 0]);
    const intensity = decodePointCloud({ ...input, fields: [...input.fields, field('intensity', 8)] });
    closeVector([...intensity.colors!].slice(0, 3), [0.2, 0.2, 0.2]);
    closeVector([...intensity.colors!].slice(3, 6), [1, 1, 1]);
  });
  it('handles finite FLOAT64 intensity ranges whose difference overflows', () => {
    const data = new Uint8Array(60), view = new DataView(data.buffer);
    [-1e308, 0, 1e308].forEach((value, index) => view.setFloat64(index * 20 + 12, value, true));
    const result = decodePointCloud({ width: 3, height: 1, point_step: 20, row_step: 60, fields: [field('x', 0), field('y', 4), field('z', 8), field('intensity', 12, 8)], data });
    expect(result.colors![0]).toBeCloseTo(0.2);
    expect(result.colors![3]).toBeCloseTo(0.6);
    expect(result.colors![6]).toBeCloseTo(1);
  });
  it('uses the first component of valid array fields', () => {
    const input = cloud([[1, 2, 3]]);
    const result = decodePointCloud({ ...input, fields: [field('x', 0, 7, 3), field('y', 4), field('z', 8)] });
    expect([...result.positions]).toEqual([1, 2, 3]);
  });
  it('drops nonfinite coordinates, but not valid zero coordinates', () => {
    const result = decodePointCloud(cloud([[NaN, 0, 0], [0, Infinity, 0], [0, 0, -Infinity], [0, 0, 0], [-1, 2, 3]]));
    expect(result.count).toBe(2);
    expect([...result.positions]).toEqual([0, 0, 0, -1, 2, 3]);
    expect(result.colors!.length).toBe(6);
  });
  it('drops FLOAT64 coordinates that would overflow the renderer Float32Array', () => {
    const data = new Uint8Array(24), view = new DataView(data.buffer);
    view.setFloat64(0, 1e100, true);
    expect(decodePointCloud({ width: 1, height: 1, point_step: 24, row_step: 24, fields: [field('x', 0, 8), field('y', 8, 8), field('z', 16, 8)], data }).count).toBe(0);
  });
  it('decimates predictably and does not exceed the point budget', () => {
    const input = cloud(Array.from({ length: 10 }, (_, i) => [i, 0, 0]));
    const result = decodePointCloud(input, 3);
    expect(result.count).toBe(3);
    expect([...result.positions]).toEqual([0, 0, 0, 4, 0, 0, 8, 0, 0]);
    expect(decodePointCloud(input, 0).count).toBe(0);
    expect(decodePointCloud(cloud([])).count).toBe(0);
  });
  it('accepts base64 payloads', () => {
    const input = cloud([[1, 2, 3]]);
    expect([...decodePointCloud({ ...input, data: btoa(String.fromCharCode(...input.data)) }).positions]).toEqual([1, 2, 3]);
  });
  it('rejects truncated data, impossible strides and invalid field extents', () => {
    const input = cloud([[1, 2, 3]]);
    expect(() => decodePointCloud({ ...input, data: input.data.subarray(0, 11) })).toThrow('Truncated');
    expect(() => decodePointCloud({ ...input, row_step: 11 })).toThrow('row_step');
    expect(() => decodePointCloud({ ...input, fields: [field('x', 0), field('y', 4), field('z', 9)] })).toThrow('field');
    expect(() => decodePointCloud({ ...input, fields: [field('x', 0), field('y', 4), field('z', 8, 9)] })).toThrow('field');
    expect(() => decodePointCloud({ ...input, fields: [field('x', 0), field('y', 4), field('z', 8, 7, 2)] })).toThrow('field');
    expect(() => decodePointCloud({ ...input, fields: [field('x', 0)] })).toThrow('requires');
    expect(() => decodePointCloud({ ...input, width: -1 })).toThrow('width');
  });
});

const scan = (ranges: number[] | Float32Array, overrides: Record<string, unknown> = {}) => ({ ranges, angle_min: 0, angle_increment: Math.PI / 2, range_min: 0.1, range_max: 10, intensities: [], ...overrides });

describe('LaserScan decoding', () => {
  it('uses ROS XY axes and counterclockwise positive angles', () => {
    const result = decodeLaserScan(scan([1, 2, 3]));
    expect(result.count).toBe(3);
    closeVector([...result.positions], [1, 0, 0, 0, 2, 0, -3, 0, 0]);
  });
  it('discards NaN, infinity and out-of-range returns, preserving inclusive limits', () => {
    const result = decodeLaserScan(scan([NaN, Infinity, -Infinity, 0.09, 10.01, 0.1, 10], { angle_increment: 0 }));
    expect(result.count).toBe(2);
    closeVector([...result.positions], [0.1, 0, 0, 10, 0, 0]);
  });
  it('handles typed arrays, negative angle increments and sampled ray indices', () => {
    const result = decodeLaserScan(scan(new Float32Array([1, 1, 1, 1, 1]), { angle_increment: -Math.PI / 4 }), 3);
    expect(result.count).toBe(3);
    closeVector([...result.positions], [1, 0, 0, 0, -1, 0, -1, 0, 0]);
  });
  it('uses intensity when complete and finite display colors with bad intensity samples', () => {
    const result = decodeLaserScan(scan([1, 1, 1], { intensities: [0, NaN, 100] }));
    expect([...result.colors!].every(Number.isFinite)).toBe(true);
    expect(result.colors![0]).toBeCloseTo(0.2);
    expect(result.colors![6]).toBeCloseTo(1);
  });
  it('handles empty/zero-budget data and rejects invalid metadata', () => {
    expect(decodeLaserScan(scan([])).count).toBe(0);
    expect(decodeLaserScan(scan([1]), 0).count).toBe(0);
    expect(() => decodeLaserScan(scan([1], { angle_min: NaN }))).toThrow();
    expect(() => decodeLaserScan(scan([1], { range_min: -1 }))).toThrow();
    expect(() => decodeLaserScan(scan([1], { range_min: 20 }))).toThrow();
    expect(() => decodeLaserScan(scan([1], { range_max: Infinity }))).toThrow();
    expect(() => decodeLaserScan({ ranges: new DataView(new ArrayBuffer(4)) })).toThrow();
  });
});

describe('raw image decoding', () => {
  it.each([
    ['rgb8', [10, 20, 30], [10, 20, 30, 255]],
    ['bgr8', [10, 20, 30], [30, 20, 10, 255]],
    ['rgba8', [10, 20, 30, 40], [10, 20, 30, 40]],
    ['bgra8', [10, 20, 30, 40], [30, 20, 10, 40]],
    ['mono8', [77], [77, 77, 77, 255]],
  ])('decodes %s', (encoding, input, expected) => {
    const data = input as number[];
    expect([...decodeImage({ width: 1, height: 1, step: data.length, encoding, data }).data]).toEqual(expected);
  });
  it('respects row padding and input byte offsets', () => {
    const backing = new Uint8Array([99, 10, 20, 30, 254, 40, 50, 60, 254, 99]);
    const result = decodeImage({ width: 1, height: 2, step: 4, encoding: 'rgb8', data: backing.subarray(1, 9) });
    expect(result.width).toBe(1); expect(result.height).toBe(2);
    expect([...result.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });
  it('maps mono16 full-range values and supports both byte orders', () => {
    for (const big of [true, false]) {
      const data = new Uint8Array(8), view = new DataView(data.buffer);
      [0, 32768, 65535].forEach((v, i) => view.setUint16(i * 2, v, !big));
      expect([...decodeImage({ width: 3, height: 1, step: 8, encoding: 'mono16', data, is_bigendian: big }).data]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
    }
  });
  it('reads base64 and handles empty images', () => {
    expect([...decodeImage({ width: 1, height: 1, step: 3, encoding: 'rgb8', data: 'AQID' }).data]).toEqual([1, 2, 3, 255]);
    expect(decodeImage({ width: 0, height: 0, encoding: 'rgb8' }).data.length).toBe(0);
  });
  it('rejects prototype property names as encodings', () => {
    for (const encoding of ['__proto__', 'constructor', 'toString']) {
      expect(() => decodeImage({ width: 1, height: 1, encoding, step: 4, data: [0, 0, 0, 0] })).toThrow('Unsupported');
    }
  });
  it('rejects unsupported encodings, oversized images, short rows and truncated input', () => {
    expect(() => decodeImage({ width: 1, height: 1, encoding: '32FC1', step: 4, data: [0, 0, 0, 0] })).toThrow('Unsupported');
    expect(() => decodeImage({ width: 100000, height: 100000, encoding: 'rgb8' })).toThrow('16-megapixel');
    expect(() => decodeImage({ width: 2, height: 1, encoding: 'rgb8', step: 3, data: [0, 0, 0] })).toThrow('step');
    expect(() => decodeImage({ width: 1, height: 1, encoding: 'rgb8', step: 3, data: [0, 0] })).toThrow('Truncated');
    expect(() => decodeImage({ width: -1, height: 1, encoding: 'mono8' })).toThrow('width');
  });
});
