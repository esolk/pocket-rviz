import { Color, Matrix4, Quaternion, Vector3 } from 'three';
import { normalizeLayerSettings, type ColorMode, type LayerSettings } from './display-settings';

export type Vec3 = { x: number; y: number; z: number };
export type Quat = Vec3 & { w: number };
export type Cloud = { positions: Float32Array; colors?: Float32Array; count: number; colorMode?: ColorMode; warning?: string; solidIndices?: Uint32Array };

const NS = 1_000_000_000n;
const FLOAT32_MAX = 3.4028234663852886e38;
const MAX_RENDER_POINTS = 1_000_000;
const MAX_IMAGE_PIXELS = 16_777_216;
const MAX_TF_CHILDREN = 512;
const MAX_TF_BATCH = 2048;
const MAX_FRAME_LENGTH = 256;

type Stamp = { secs?: number | bigint; nsecs?: number | bigint; sec?: number | bigint; nsec?: number | bigint; nanosec?: number | bigint };

/** ROS1 uses secs/nsecs; Foxglove's deserializer uses sec/nsec. Zero means latest to TF. */
export function stampNs(stamp: Stamp | undefined | null): bigint {
  if (!stamp) return 0n;
  const sec = stamp.secs ?? stamp.sec ?? 0;
  const nsec = stamp.nsecs ?? stamp.nsec ?? stamp.nanosec ?? 0;
  for (const part of [sec, nsec]) {
    if (typeof part !== 'bigint' && (typeof part !== 'number' || !Number.isSafeInteger(part))) return 0n;
    if (part < 0) return 0n;
  }
  return BigInt(sec) * NS + BigInt(nsec);
}

export function cleanFrame(frame: string): string {
  return typeof frame === 'string' ? frame.trim().replace(/^\/+/, '') : '';
}

type Transform = { parent: string; child: string; time: bigint; translation: Vector3; rotation: Quaternion };
type Step = { transform: Transform; reverse: boolean };

/**
 * ROS transforms map child-frame coordinates into the parent frame. Dynamic samples
 * interpolate translation and quaternion rotation at the requested ROS timestamp;
 * they never extrapolate. Static transforms are timeless and keep one value/child.
 * Histories are bounded per child by age and count, with at most 512 children.
 * At capacity new children are ignored; existing children can still be updated.
 * Batches inspect at most 2048 transforms, and frame names are limited to 256 chars.
 * A fixed-frame change needs no
 * cache reset; on ROS clock rollback call clearDynamic() to preserve latched TF.
 * No velocity extrapolation.
 */
export class TfTree {
  private dynamic = new Map<string, Transform[]>();
  private statics = new Map<string, Transform>();
  private readonly maxSamples: number;
  private readonly maxAgeNs: bigint;

  constructor(maxSamples = 180, maxAgeNs = 10_000_000_000n) {
    this.maxSamples = Number.isFinite(maxSamples) ? Math.max(1, Math.floor(maxSamples)) : 180;
    this.maxAgeNs = maxAgeNs > 0n ? maxAgeNs : 0n;
  }

  update(transforms: any[], isStatic = false): void {
    if (!Array.isArray(transforms)) return;
    for (let i = 0; i < Math.min(transforms.length, MAX_TF_BATCH); i++) {
      const input = transforms[i];
      const parent = cleanFrame(input?.header?.frame_id);
      const child = cleanFrame(input?.child_frame_id);
      const t = input?.transform?.translation;
      const q = input?.transform?.rotation;
      if (!parent || !child || parent.length > MAX_FRAME_LENGTH || child.length > MAX_FRAME_LENGTH || parent === child || !t || !q) continue;
      if (!this.dynamic.has(child) && !this.statics.has(child) && this.dynamic.size + this.statics.size >= MAX_TF_CHILDREN) continue;
      if (![t.x, t.y, t.z, q.x, q.y, q.z, q.w].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      const rotation = new Quaternion(q.x, q.y, q.z, q.w);
      if (rotation.lengthSq() < 1e-20 || !Number.isFinite(rotation.lengthSq())) continue;
      rotation.normalize();
      const transform: Transform = {
        parent, child, time: stampNs(input.header?.stamp),
        translation: new Vector3(t.x, t.y, t.z), rotation,
      };
      // A child has one authority/type. Re-publishing on the other TF topic replaces it.
      if (isStatic) {
        this.dynamic.delete(child);
        this.statics.set(child, transform);
        continue;
      }
      this.statics.delete(child);
      const history = this.dynamic.get(child) ?? [];
      let lo = 0, hi = history.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (history[mid].time < transform.time) lo = mid + 1;
        else hi = mid;
      }
      if (history[lo]?.time === transform.time) history[lo] = transform;
      else history.splice(lo, 0, transform);
      const cutoff = history[history.length - 1].time - this.maxAgeNs;
      let remove = Math.max(0, history.length - this.maxSamples);
      while (remove < history.length - 1 && history[remove].time < cutoff) remove++;
      if (remove) history.splice(0, remove);
      this.dynamic.set(child, history);
    }
  }

  frames(): string[] {
    const names = new Set<string>();
    for (const t of this.statics.values()) { names.add(t.parent); names.add(t.child); }
    for (const history of this.dynamic.values()) {
      for (const t of history) { names.add(t.parent); names.add(t.child); }
    }
    return [...names].sort();
  }

  clear(): void { this.dynamic.clear(); this.statics.clear(); }

  /** ROS /clock rollback invalidates dynamic history but not latched /tf_static. */
  clearDynamic(): void { this.dynamic.clear(); }

  lookup(target: string, source: string, time: bigint = 0n): Matrix4 | undefined {
    target = cleanFrame(target);
    source = cleanFrame(source);
    if (!target || !source || target.length > MAX_FRAME_LENGTH || source.length > MAX_FRAME_LENGTH || time < 0n) return undefined;
    if (target === source) return new Matrix4();
    if (time !== 0n) return this.compose(this.path(target, source, this.at(time)));

    // tf2's Time(0) is the latest COMMON time, not each edge's independent latest.
    // The fast path covers the normal, unchanging tree topology.
    const latest = [...this.statics.values(), ...[...this.dynamic.values()].map((h) => h[h.length - 1])];
    const stableTopology = [...this.dynamic.values()].every((h) => h.every((t) => t.parent === h[0].parent));
    if (stableTopology) {
      const path = this.path(target, source, latest);
      if (!path) return undefined;
      let common: bigint | undefined;
      for (const { transform } of path) {
        if (this.dynamic.has(transform.child) && (common === undefined || transform.time < common)) common = transform.time;
      }
      return common === undefined ? this.compose(path) : this.compose(this.path(target, source, this.at(common)));
    }
    // Reparenting: the latest feasible chain ends at a retained parent-run endpoint.
    // Do not interpolate across a parent change. Search endpoints newest first.
    const candidates = new Set<bigint>();
    for (const h of this.dynamic.values()) {
      for (let i = 0; i < h.length; i++) {
        if (i === h.length - 1 || h[i + 1].parent !== h[i].parent) candidates.add(h[i].time);
      }
    }
    for (const candidate of [...candidates].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)) {
      const path = this.path(target, source, this.at(candidate));
      if (path) return this.compose(path);
    }
    return this.compose(this.path(target, source, [...this.statics.values()]));
  }

  private at(time: bigint): Transform[] {
    const result = [...this.statics.values()];
    for (const h of this.dynamic.values()) {
      if (time < h[0].time || time > h[h.length - 1].time) continue;
      let lo = 0, hi = h.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (h[mid].time < time) lo = mid + 1;
        else hi = mid;
      }
      const after = h[lo];
      if (after.time === time) { result.push(after); continue; }
      const before = h[lo - 1];
      if (!before || before.parent !== after.parent) continue;
      const alpha = Number(time - before.time) / Number(after.time - before.time);
      result.push({
        parent: before.parent, child: before.child, time,
        translation: before.translation.clone().lerp(after.translation, alpha),
        rotation: before.rotation.clone().slerp(after.rotation, alpha),
      });
    }
    return result;
  }

  private path(target: string, source: string, transforms: Transform[]): Step[] | undefined {
    const graph = new Map<string, { next: string; step: Step }[]>();
    const add = (from: string, next: string, transform: Transform, reverse: boolean) => {
      const edges = graph.get(from) ?? [];
      edges.push({ next, step: { transform, reverse } });
      graph.set(from, edges);
    };
    for (const t of transforms) {
      add(t.child, t.parent, t, false);
      add(t.parent, t.child, t, true);
    }
    const queue = [source];
    const previous = new Map<string, { from: string; step: Step }>();
    const visited = new Set([source]);
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      for (const { next, step } of graph.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        previous.set(next, { from: current, step });
        if (next === target) {
          const path: Step[] = [];
          for (let frame = target; frame !== source;) {
            const item = previous.get(frame)!;
            path.push(item.step);
            frame = item.from;
          }
          return path.reverse();
        }
        queue.push(next);
      }
    }
    return undefined;
  }

  private compose(path: Step[] | undefined): Matrix4 | undefined {
    if (!path) return undefined;
    const result = new Matrix4();
    for (const { transform, reverse } of path) {
      const edge = new Matrix4().compose(transform.translation, transform.rotation, new Vector3(1, 1, 1));
      if (reverse) edge.invert();
      result.premultiply(edge);
    }
    return result;
  }
}

/** Zero-copy for typed binary data; ROS bridge JSON transports may send base64. */
export function bytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    if (!data.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('Invalid byte array');
    return Uint8Array.from(data);
  }
  if (typeof data === 'string') {
    const encoded = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
    try {
      const decoded = atob(encoded);
      return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    } catch { throw new Error('Invalid base64 binary data'); }
  }
  throw new Error('Expected binary data, a byte array, or base64');
}

function uint(value: unknown, label: string, nonzero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (nonzero ? 1 : 0) || value > 0xffffffff) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function pointBudget(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_RENDER_POINTS, Math.floor(value))) : 0;
}

function emptyCloud(): Cloud { return { positions: new Float32Array(), colors: new Float32Array(), count: 0 }; }

const FIELD_SIZES = [0, 1, 1, 2, 2, 4, 4, 4, 8];
type Field = { offset: number; datatype: number; count: number };

function readField(view: DataView, offset: number, type: number, little: boolean): number {
  switch (type) {
    case 1: return view.getInt8(offset);
    case 2: return view.getUint8(offset);
    case 3: return view.getInt16(offset, little);
    case 4: return view.getUint16(offset, little);
    case 5: return view.getInt32(offset, little);
    case 6: return view.getUint32(offset, little);
    case 7: return view.getFloat32(offset, little);
    case 8: return view.getFloat64(offset, little);
    default: return NaN;
  }
}

function safeCoordinate(value: number): boolean { return Number.isFinite(value) && Math.abs(value) <= FLOAT32_MAX; }

// Intensity units are device-specific: normalize the retained finite samples per message.
// Clouds without packed color/intensity use a relative height color ramp. Alpha is ignored.
function scalarColors(values: Float64Array, count: number, colors: Float32Array, grayscale: boolean, invalidColor?: Color): void {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) if (Number.isFinite(values[i])) { min = Math.min(min, values[i]); max = Math.max(max, values[i]); }
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(values[i]) && invalidColor) {
      invalidColor.toArray(colors, i * 3);
      continue;
    }
    const span = max - min;
    // Scaling before subtraction preserves a FLOAT64 range that exceeds MAX_VALUE.
    let t = Number.isFinite(values[i]) && max > min
      ? (Number.isFinite(span) ? (values[i] - min) / span : (values[i] / 2 - min / 2) / (max / 2 - min / 2))
      : 0.5;
    t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
    const k = i * 3;
    if (grayscale) colors[k] = colors[k + 1] = colors[k + 2] = 0.2 + 0.8 * t;
    else { colors[k] = t; colors[k + 1] = 1 - Math.abs(2 * t - 1); colors[k + 2] = 1 - t; }
  }
}

/**
 * PointCloud2: field offsets/counts, all eight numeric datatypes, row padding and
 * byte order follow sensor_msgs. Coordinate fields use their first component;
 * packed RGB requires exactly one INT32, UINT32 or FLOAT32 value. Explicit color
 * modes fall back to the configured solid color when their source is unavailable.
 * Regular index decimation bounds rendering cost; it is not voxel-grid filtering.
 */
export function decodePointCloud(msg: any, maxPoints = 60_000, settings?: Partial<LayerSettings>): Cloud {
  const display = normalizeLayerSettings(settings, 'sensor_msgs/PointCloud2');
  const solid = new Color(display.color);
  const width = uint(msg?.width, 'cloud width');
  const height = uint(msg?.height, 'cloud height');
  const budget = pointBudget(maxPoints);
  if (!width || !height || !budget) return emptyCloud();
  const pointStep = uint(msg.point_step, 'point_step', true);
  const rowStep = uint(msg.row_step, 'row_step', true);
  if (rowStep < width * pointStep) throw new Error('Cloud row_step is smaller than its points');
  const data = bytes(msg.data);
  if (!Number.isSafeInteger(rowStep * height) || data.byteLength < rowStep * height) throw new Error('Truncated PointCloud2 data');
  const fields = new Map<string, Field>();
  if (!Array.isArray(msg.fields)) throw new Error('PointCloud2 fields are missing');
  for (const field of msg.fields) {
    try {
      const datatype = uint(field?.datatype, 'field datatype', true);
      const offset = uint(field?.offset, 'field offset');
      const count = uint(field?.count ?? 1, 'field count', true);
      const size = FIELD_SIZES[datatype];
      if (!size || offset + size * count > pointStep) throw new Error(`Invalid PointCloud2 field ${String(field?.name)}`);
      if (typeof field.name === 'string' && !fields.has(field.name)) fields.set(field.name, { datatype, offset, count });
    } catch (error) {
      // Bad optional color metadata must not reject otherwise valid XYZ geometry.
      if (!['rgb', 'rgba', 'intensity'].includes(field?.name)) throw error;
    }
  }
  const x = fields.get('x'), y = fields.get('y'), z = fields.get('z');
  if (!x || !y || !z) throw new Error('PointCloud2 requires x, y and z fields');
  const packed = [fields.get('rgb'), fields.get('rgba')].find((field) =>
    field && [5, 6, 7].includes(field.datatype) && field.count === 1);
  const intensityField = fields.get('intensity');
  const intensity = intensityField?.count === 1 ? intensityField : undefined;
  let mode: ColorMode = display.colorMode === 'auto'
    ? packed ? 'rgb' : intensity ? 'intensity' : 'height'
    : display.colorMode;
  let warning: string | undefined;
  if (mode === 'rgb' && !packed) {
    mode = 'solid';
    warning = 'RGB 字段缺失或无效，使用纯色';
  } else if (mode === 'intensity' && !intensity) {
    mode = 'solid';
    warning = 'intensity 字段缺失或无效，使用纯色';
  }
  const total = width * height;
  const stride = Math.max(1, Math.ceil(total / budget));
  const capacity = Math.ceil(total / stride);
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const scalars = mode === 'intensity' || mode === 'height' ? new Float64Array(capacity) : undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const little = !msg.is_bigendian;
  let count = 0;
  for (let index = 0; index < total; index += stride) {
    const offset = Math.floor(index / width) * rowStep + (index % width) * pointStep;
    const px = readField(view, offset + x.offset, x.datatype, little);
    const py = readField(view, offset + y.offset, y.datatype, little);
    const pz = readField(view, offset + z.offset, z.datatype, little);
    if (![px, py, pz].every(safeCoordinate)) continue;
    const k = count * 3;
    positions[k] = px; positions[k + 1] = py; positions[k + 2] = pz;
    if (mode === 'rgb' && packed) {
      // FLOAT32 rgb is bit-cast, never numerically converted (its value may be NaN).
      const rgb = view.getUint32(offset + packed.offset, little);
      colors[k] = ((rgb >>> 16) & 255) / 255;
      colors[k + 1] = ((rgb >>> 8) & 255) / 255;
      colors[k + 2] = (rgb & 255) / 255;
    } else if (scalars) {
      scalars[count] = mode === 'intensity' && intensity ? readField(view, offset + intensity.offset, intensity.datatype, little) : pz;
    } else solid.toArray(colors, k);
    count++;
  }
  let solidIndices: Uint32Array | undefined;
  if (scalars) {
    let finiteCount = 0;
    for (let i = 0; i < count; i++) if (Number.isFinite(scalars[i])) finiteCount++;
    if (mode === 'intensity' && count && !finiteCount) {
      mode = 'solid';
      warning = 'intensity 没有有限值，使用纯色';
      for (let i = 0; i < count; i++) solid.toArray(colors, i * 3);
    } else {
      scalarColors(scalars, count, colors, mode === 'intensity', solid);
      if (finiteCount < count) {
        warning = '部分 intensity 非有限值，已使用纯色';
        solidIndices = new Uint32Array(count - finiteCount);
        let fallback = 0;
        for (let i = 0; i < count; i++) if (!Number.isFinite(scalars[i])) solidIndices[fallback++] = i;
      }
    }
  }
  return { positions: positions.slice(0, count * 3), colors: colors.slice(0, count * 3), count, colorMode: mode, warning, solidIndices };
}

/** A planar XY scan. Uses one header-time transform; individual rays are not motion-deskewed. */
export function decodeLaserScan(msg: any, maxPoints = 30_000): Cloud {
  const ranges = msg?.ranges;
  if (!Array.isArray(ranges) && !ArrayBuffer.isView(ranges)) throw new Error('LaserScan ranges are missing');
  const values = ranges as ArrayLike<number>;
  if (!Number.isSafeInteger(values.length) || values.length < 0) throw new Error('Invalid LaserScan ranges');
  const budget = pointBudget(maxPoints);
  if (!values.length || !budget) return emptyCloud();
  const { angle_min: angleMin, angle_increment: angleIncrement, range_min: rangeMin, range_max: rangeMax } = msg;
  if (![angleMin, angleIncrement, rangeMin, rangeMax].every((n) => typeof n === 'number' && Number.isFinite(n)) || rangeMin < 0 || rangeMax < rangeMin) {
    throw new Error('Invalid LaserScan angles or range limits');
  }
  const stride = Math.max(1, Math.ceil(values.length / budget));
  const capacity = Math.ceil(values.length / stride);
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const intensity = msg.intensities as ArrayLike<number> | undefined;
  const scalars = intensity && intensity.length === values.length ? new Float64Array(capacity) : undefined;
  let count = 0;
  for (let index = 0; index < values.length; index += stride) {
    const range = values[index];
    if (typeof range !== 'number' || !Number.isFinite(range) || range < rangeMin || range > rangeMax) continue;
    const angle = angleMin + index * angleIncrement;
    const x = range * Math.cos(angle), y = range * Math.sin(angle);
    if (!safeCoordinate(x) || !safeCoordinate(y)) continue;
    const k = count * 3;
    positions[k] = x; positions[k + 1] = y; positions[k + 2] = 0;
    colors[k] = 0.2; colors[k + 1] = 0.9; colors[k + 2] = 1;
    if (scalars) scalars[count] = intensity![index];
    count++;
  }
  if (scalars) scalarColors(scalars, count, colors, true);
  return { positions: positions.slice(0, count * 3), colors: colors.slice(0, count * 3), count };
}

/** Raw sensor_msgs/Image only. mono16 maps full uint16 range to 8-bit; no depth auto-exposure. */
export function decodeImage(msg: any): { width: number; height: number; data: Uint8ClampedArray } {
  const width = uint(msg?.width, 'image width');
  const height = uint(msg?.height, 'image height');
  if (width * height > MAX_IMAGE_PIXELS) throw new Error('Image exceeds the 16-megapixel display limit');
  const encoding = typeof msg.encoding === 'string' ? msg.encoding.toLowerCase() : '';
  const channels: Record<string, number> = { rgb8: 3, bgr8: 3, rgba8: 4, bgra8: 4, mono8: 1, mono16: 2 };
  const pixelBytes = Object.hasOwn(channels, encoding) ? channels[encoding] : undefined;
  if (!pixelBytes) throw new Error(`Unsupported image encoding: ${encoding || '(missing)'}. Use rgb8, bgr8, rgba8, bgra8, mono8 or mono16.`);
  if (!width || !height) return { width, height, data: new Uint8ClampedArray() };
  const step = uint(msg.step, 'image step', true);
  if (step < width * pixelBytes) throw new Error('Image step is smaller than its pixels');
  const input = bytes(msg.data);
  if (input.byteLength < step * height) throw new Error('Truncated image data');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const output = new Uint8ClampedArray(width * height * 4);
  const bgr = encoding === 'bgr8' || encoding === 'bgra8';
  const alpha = encoding === 'rgba8' || encoding === 'bgra8';
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = y * step + x * pixelBytes;
      const target = (y * width + x) * 4;
      if (encoding === 'mono8' || encoding === 'mono16') {
        const value = encoding === 'mono16' ? Math.round(view.getUint16(source, !msg.is_bigendian) / 257) : input[source];
        output[target] = output[target + 1] = output[target + 2] = value;
      } else {
        output[target] = input[source + (bgr ? 2 : 0)];
        output[target + 1] = input[source + 1];
        output[target + 2] = input[source + (bgr ? 0 : 2)];
      }
      output[target + 3] = alpha ? input[source + 3] : 255;
    }
  }
  return { width, height, data: output };
}
