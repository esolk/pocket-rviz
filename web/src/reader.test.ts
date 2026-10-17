/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import fixtureText from '../../qa/fixtures-data.json?raw';
import { parse } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg-serialization';
import type { MessageDefinition } from '@foxglove/message-definition';
import { SafeMessageReader } from './reader';
import { bytes, decodePointCloud, stampNs, TfTree } from './data';
import { Vector3 } from 'three';

const roundtrip = (schema: string, message: unknown) => {
  const definitions = parse(schema);
  const payload = new MessageWriter(definitions).writeMessage(message);
  return new SafeMessageReader(definitions).readMessage(payload);
};
const prefix = (count: number) => { const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, count, true); return data; };
const fixture = JSON.parse(fixtureText);
const channels = fixture.channels as { id: number; schema: string; topic: string; schemaName: string; payloadBase64: string }[];

describe('SafeMessageReader primitives and ROS1 layout', () => {
  it('reads every numeric primitive, bool, UTF-8, time and signed duration', () => {
    const schema = 'bool yes\nint8 a\nuint8 b\nint16 c\nuint16 d\nint32 e\nuint32 f\nint64 g\nuint64 h\nfloat32 i\nfloat64 j\nstring text\ntime stamp\nduration duration';
    const message = { yes: true, a: -127, b: 255, c: -12345, d: 54321, e: -1234567, f: 4_000_000_000, g: -9_007_199_254_740_993n, h: 18_446_744_073_709_551_615n, i: 1.5, j: -1e123, text: '机器人 🤖\0end', stamp: { sec: 123, nsec: 456 }, duration: { sec: -2, nsec: -3 } };
    expect(roundtrip(schema, message)).toEqual(message);
  });
  it('handles fixed and variable primitive arrays, including signed byte occupancy maps', () => {
    const output = roundtrip('uint8[] u\nint8[] s\nint16[2] a\nuint16[] b\nint32[] c\nuint32[] d\nint64[] e\nuint64[] f\nfloat32[] g\nfloat64[] h\nbool[] ok\nstring[2] text', {
      u: [0, 255], s: [-1, 100], a: [-123, 456], b: [123, 65535], c: [-123456], d: [4_000_000_000], e: [-1234567891011n], f: [1234567891011n], g: [0.125], h: [Math.PI], ok: [true, false], text: ['hello', '世界'],
    });
    expect(output.u).toBeInstanceOf(Uint8Array); expect([...output.u]).toEqual([0, 255]);
    expect(output.s).toBeInstanceOf(Int8Array); expect([...output.s]).toEqual([-1, 100]);
    expect(output.a).toBeInstanceOf(Int16Array); expect([...output.a]).toEqual([-123, 456]);
    expect([...output.b]).toEqual([123, 65535]); expect([...output.c]).toEqual([-123456]);
    expect([...output.d]).toEqual([4_000_000_000]); expect([...output.e]).toEqual([-1234567891011n]);
    expect([...output.f]).toEqual([1234567891011n]); expect([...output.g]).toEqual([0.125]);
    expect([...output.h]).toEqual([Math.PI]); expect(output.ok).toEqual([true, false]); expect(output.text).toEqual(['hello', '世界']);
  });
  it('supports time/duration arrays, constants and zero-length arrays', () => {
    const result = roundtrip('uint8 CONST=7\ntime[] t\nduration[1] d\nuint8[0] empty', { t: [{ sec: 1, nsec: 2 }], d: [{ sec: -1, nsec: -2 }], empty: [] });
    expect(result).toEqual({ t: [{ sec: 1, nsec: 2 }], d: [{ sec: -1, nsec: -2 }], empty: new Uint8Array() });
    expect(result.CONST).toBeUndefined();
  });
  it('does not assume alignment or a zero view byte offset', () => {
    const definitions = parse('uint8 flag\nfloat64[] points\nuint8[] blob');
    const payload = new MessageWriter(definitions).writeMessage({ flag: 7, points: [1.5, -2.25], blob: [4, 5, 6] });
    const backing = new Uint8Array(payload.length + 10); backing.set(payload, 3);
    const reader = new SafeMessageReader(definitions);
    const output = reader.readMessage(new DataView(backing.buffer, 3, payload.length));
    expect([...output.points]).toEqual([1.5, -2.25]); expect([...output.blob]).toEqual([4, 5, 6]);
    expect(output.blob.buffer).toBe(backing.buffer);
    expect(reader.lastReadByteLength()).toBe(payload.length); expect(reader.lastReadHadTrailingBytes()).toBe(false);
  });
  it('supports Header aliases and local nested type names', () => {
    const schema = 'Header header\nThing[] things\n===\nMSG: std_msgs/Header\nuint32 seq\ntime stamp\nstring frame_id\n===\nMSG: pkg/Thing\nfloat32 value';
    const result = roundtrip(schema, { header: { seq: 4, stamp: { sec: 10, nsec: 20 }, frame_id: 'map' }, things: [{ value: 1.5 }] });
    expect(result.header.frame_id).toBe('map'); expect(result.things).toEqual([{ value: 1.5 }]);
    const definitions = parse(schema, { skipTypeFixup: true });
    const safe = new SafeMessageReader(definitions);
    const payload = new MessageWriter(parse(schema)).writeMessage({ header: { seq: 0, stamp: { sec: 1, nsec: 2 }, frame_id: 'world' }, things: [] });
    expect(safe.readMessage(payload).header.frame_id).toBe('world');
  });
  it('handles byte and char aliases in directly supplied definitions', () => {
    const reader = new SafeMessageReader([{ definitions: [{ name: 'a', type: 'byte' }, { name: 'b', type: 'char' }] }]);
    expect(reader.readMessage(new Uint8Array([255, 255]))).toEqual({ a: -1, b: 255 });
  });
  it('still decodes when eval and Function are forbidden', () => {
    const definitions = parse('uint32 value\nstring label');
    const payload = new MessageWriter(definitions).writeMessage({ value: 42, label: 'CSP-safe' });
    const fail = () => { throw new Error('Dynamic JavaScript disabled by CSP'); };
    vi.stubGlobal('eval', fail); vi.stubGlobal('Function', fail);
    let output: any;
    try { output = new SafeMessageReader(definitions).readMessage(payload); }
    finally { vi.unstubAllGlobals(); }
    expect(output).toEqual({ value: 42, label: 'CSP-safe' });
  });
});

describe('independent Python ROS1 wire fixtures', () => {
  it.each(channels.map((channel) => [channel.topic, channel] as const))('matches Foxglove deserialization for %s', (_topic, channel) => {
    const definitions = parse(channel.schema);
    const payload = bytes(channel.payloadBase64);
    const safe = new SafeMessageReader(definitions);
    const expected = new MessageReader(definitions).readMessage(payload);
    expect(safe.readMessage(payload)).toEqual(expected);
    expect(safe.lastReadByteLength()).toBe(payload.length);
  });
  it('decodes mixed-datatype padded clouds in both byte orders and applies the known TF chain', () => {
    const tree = new TfTree();
    for (const channel of channels.filter((c) => c.topic === '/tf' || c.topic === '/tf_static')) {
      const msg = new SafeMessageReader(parse(channel.schema)).readMessage(bytes(channel.payloadBase64));
      tree.update(msg.transforms, channel.topic === '/tf_static');
    }
    for (const channel of channels.filter((c) => c.schemaName === 'sensor_msgs/PointCloud2')) {
      const msg = new SafeMessageReader(parse(channel.schema)).readMessage(bytes(channel.payloadBase64));
      const result = decodePointCloud(msg);
      expect(result.count).toBe(fixture.expected.pointcloud.finite_points);
      expect([...result.positions]).toEqual(fixture.expected.pointcloud.finite_lidar_xyz.flat());
      const matrix = tree.lookup('map', msg.header.frame_id, stampNs(msg.header.stamp));
      expect(matrix).toBeDefined();
      for (let i = 0; i < result.count; i++) {
        const point = new Vector3().fromArray(result.positions, i * 3).applyMatrix4(matrix!);
        point.toArray().forEach((n, axis) => expect(n).toBeCloseTo(fixture.expected.pointcloud.finite_map_xyz_tick_0[i][axis], 5));
        const color = fixture.expected.pointcloud.rgb_uint32[i];
        expect(result.colors![i * 3]).toBeCloseTo(((color >>> 16) & 255) / 255);
        expect(result.colors![i * 3 + 1]).toBeCloseTo(((color >>> 8) & 255) / 255);
        expect(result.colors![i * 3 + 2]).toBeCloseTo((color & 255) / 255);
      }
    }
  });
});

describe('bounded malformed-input handling', () => {
  it('rejects truncation at every byte boundary and trailing bytes', () => {
    const definitions = parse('string label\nuint32[] values');
    const payload = new MessageWriter(definitions).writeMessage({ label: 'robot', values: [1, 2, 3] });
    const reader = new SafeMessageReader(definitions);
    for (let i = 0; i < payload.length; i++) expect(() => reader.readMessage(payload.subarray(0, i))).toThrow();
    const extra = new Uint8Array(payload.length + 1); extra.set(payload);
    expect(() => reader.readMessage(extra)).toThrow('Trailing');
  });
  it('rejects huge array and string counts before allocation', () => {
    for (const schema of ['uint8[] values', 'float64[] values', 'string values']) {
      expect(() => new SafeMessageReader(parse(schema)).readMessage(prefix(0xffffffff))).toThrow(/limit/);
    }
    expect(() => new SafeMessageReader(parse('uint8[] values')).readMessage(prefix(100))).toThrow('Truncated');
  });
  it('rejects payloads above 32 MiB', () => {
    expect(() => new SafeMessageReader(parse('uint8[] data')).readMessage(new Uint8Array(32 * 1024 * 1024 + 1))).toThrow('32 MiB');
  });
  it('bounds empty-message arrays despite their zero-byte element size', () => {
    const definitions: MessageDefinition[] = [{ definitions: [{ name: 'items', type: 'pkg/Empty', isArray: true }] }, { name: 'pkg/Empty', definitions: [] }];
    expect(() => new SafeMessageReader(definitions).readMessage(prefix(200001))).toThrow(/value limit/);
  });
  it('bounds the aggregate decoded object budget across separate arrays', () => {
    const definitions: MessageDefinition[] = [{ definitions: [{ name: 'a', type: 'pkg/Empty', isArray: true }, { name: 'b', type: 'pkg/Empty', isArray: true }] }, { name: 'pkg/Empty', definitions: [] }];
    const data = new Uint8Array(8); data.set(prefix(100000)); data.set(prefix(100000), 4);
    expect(() => new SafeMessageReader(definitions).readMessage(data)).toThrow(/value limit/);
  });
  it('rejects missing, ambiguous, recursive and excessively nested schemas', () => {
    expect(() => new SafeMessageReader([])).toThrow();
    expect(() => new SafeMessageReader([{ definitions: [{ name: 'x', type: 'Missing' }] }])).toThrow('Missing');
    expect(() => new SafeMessageReader([{ definitions: [{ name: 'x', type: 'Thing' }] }, { name: 'a/Thing', definitions: [] }, { name: 'b/Thing', definitions: [] }])).toThrow('ambiguous');
    expect(() => new SafeMessageReader([{ name: 'pkg/Loop', definitions: [{ name: 'x', type: 'pkg/Loop', isArray: true }] }])).toThrow('Recursive');
    const deep: MessageDefinition[] = Array.from({ length: 70 }, (_, i) => ({ name: `pkg/N${i}`, definitions: i === 69 ? [] : [{ name: 'child', type: `pkg/N${i + 1}` }] }));
    expect(() => new SafeMessageReader(deep)).toThrow('nesting');
  });
  it('rejects duplicate fields/types and malformed fixed arrays', () => {
    expect(() => new SafeMessageReader([{ definitions: [{ name: 'x', type: 'uint8' }, { name: 'x', type: 'uint8' }] }])).toThrow('duplicate');
    expect(() => new SafeMessageReader([{ name: 'A', definitions: [] }, { name: 'A', definitions: [] }])).toThrow('Duplicate');
    expect(() => new SafeMessageReader([{ definitions: [{ name: 'x', type: 'uint8', isArray: true, arrayLength: -1 }] }])).toThrow('array');
  });
  it('treats __proto__ fields as data without changing object prototypes', () => {
    const reader = new SafeMessageReader([{ definitions: [{ name: '__proto__', type: 'uint8' }, { name: 'constructor', type: 'uint8' }] }]);
    const result = reader.readMessage(new Uint8Array([5, 6]));
    expect(Object.getPrototypeOf(result)).toBe(null); expect(result.__proto__).toBe(5); expect(result.constructor).toBe(6);
  });
});
