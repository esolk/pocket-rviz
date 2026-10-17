import type { MessageDefinition } from '@foxglove/message-definition';

// No source generation, eval or Function constructor. Suitable for script-src 'self'.
// ROS1 wire encoding is packed little-endian (without CDR alignment). Limits are
// deliberately conservative for a tablet; uint8/int8 image/cloud blobs are zero-copy.
const MAX_PAYLOAD = 32 * 1024 * 1024;
const MAX_ARRAY = 1_000_000;
const MAX_VALUES = 2_000_000;
const MAX_OBJECTS = 200_000;
const MAX_STRING = 1024 * 1024;
const MAX_STRING_TOTAL = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const SIZES = new Map<string, number>([
  ['bool', 1], ['int8', 1], ['uint8', 1], ['int16', 2], ['uint16', 2],
  ['int32', 4], ['uint32', 4], ['int64', 8], ['uint64', 8], ['float32', 4], ['float64', 8],
  ['time', 8], ['duration', 8], ['string', 4],
]);
type Primitive = { kind: 'primitive'; type: string; min: number };
type Message = { kind: 'message'; fields: Field[]; min: number };
type Node = Primitive | Message;
type Field = { name: string; node: Node; array: boolean; length?: number };
type Cursor = { view: DataView; offset: number; values: number; objects: number; strings: number };

/** Bounded, interpreted ROS1 reader. 64-bit integers are bigint; time/duration are {sec,nsec}. */
export class SafeMessageReader {
  private readonly root: Message;
  private readonly utf8 = new TextDecoder('utf-8');
  private lastLength = 0;

  constructor(definitions: MessageDefinition[]) {
    if (!Array.isArray(definitions) || !definitions.length || definitions.length > 2048) throw new Error('Invalid or oversized ROS1 schema');
    const named = new Map<string, MessageDefinition>();
    const short = new Map<string, MessageDefinition[]>();
    let fields = 0, unnamed = 0;
    for (const def of definitions) {
      if (!def || !Array.isArray(def.definitions)) throw new Error('Invalid ROS1 message definition');
      fields += def.definitions.length;
      if (fields > 16_384) throw new Error('ROS1 schema has too many fields');
      if (!def.name) { if (++unnamed > 1) throw new Error('Ambiguous ROS1 root message'); continue; }
      if (named.has(def.name)) throw new Error(`Duplicate ROS1 type: ${def.name}`);
      named.set(def.name, def);
      const name = def.name.split('/').pop()!;
      short.set(name, [...(short.get(name) ?? []), def]);
    }
    const cache = new Map<MessageDefinition, Message>();
    const active = new Set<MessageDefinition>();
    const resolve = (type: string, owner: MessageDefinition): MessageDefinition => {
      if (type === 'Header' && named.has('std_msgs/Header')) return named.get('std_msgs/Header')!;
      if (named.has(type)) return named.get(type)!;
      if (!type.includes('/') && owner.name?.includes('/')) {
        const full = owner.name.slice(0, owner.name.lastIndexOf('/') + 1) + type;
        if (named.has(full)) return named.get(full)!;
      }
      const candidates = !type.includes('/') ? short.get(type) : undefined;
      if (candidates?.length === 1) return candidates[0];
      throw new Error(`Missing or ambiguous ROS1 type: ${type}`);
    };
    const compile = (def: MessageDefinition, depth: number): Message => {
      if (depth > MAX_DEPTH) throw new Error('ROS1 schema nesting limit exceeded');
      if (active.has(def)) throw new Error('Recursive ROS1 schemas are unsupported');
      const found = cache.get(def);
      if (found) return found;
      active.add(def);
      const node: Message = { kind: 'message', fields: [], min: 0 };
      const names = new Set<string>();
      for (const field of def.definitions) {
        if (field.isConstant) continue;
        if (typeof field.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) || names.has(field.name)) throw new Error('Invalid or duplicate ROS1 field name');
        names.add(field.name);
        if (typeof field.type !== 'string') throw new Error('Invalid ROS1 field type');
        const type = field.type === 'byte' ? 'int8' : field.type === 'char' ? 'uint8' : field.type;
        const size = SIZES.get(type);
        const child: Node = size === undefined ? compile(resolve(type, def), depth + 1) : { kind: 'primitive', type, min: size };
        const array = !!field.isArray;
        const length = field.arrayLength;
        if (length !== undefined && (!array || !Number.isInteger(length) || length < 0 || length > (['uint8', 'int8'].includes(type) ? MAX_PAYLOAD : MAX_ARRAY))) throw new Error('Invalid or oversized ROS1 fixed array');
        if (field.upperBound !== undefined || field.arrayUpperBound !== undefined) throw new Error('ROS2 bounded types are not ROS1 wire types');
        node.fields.push({ name: field.name, node: child, array, length });
        node.min += array ? length === undefined ? 4 : length * child.min : child.min;
        if (!Number.isSafeInteger(node.min) || node.min > MAX_PAYLOAD) throw new Error('ROS1 schema minimum payload exceeds limit');
      }
      active.delete(def);
      cache.set(def, node);
      return node;
    };
    this.root = compile(definitions.find((d) => !d.name) ?? definitions[0], 0);
  }

  readMessage(buffer: ArrayBufferView): any {
    this.lastLength = 0;
    if (!ArrayBuffer.isView(buffer)) throw new Error('ROS1 payload must be an ArrayBuffer view');
    if (buffer.byteLength > MAX_PAYLOAD) throw new Error('ROS1 payload exceeds 32 MiB');
    const ctx: Cursor = {
      view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength), offset: 0,
      values: MAX_VALUES, objects: MAX_OBJECTS, strings: MAX_STRING_TOTAL,
    };
    this.ensure(ctx, this.root.min);
    const result = this.readNode(this.root, ctx, 0);
    this.lastLength = ctx.offset;
    if (ctx.offset !== buffer.byteLength) throw new Error('Trailing bytes after ROS1 message');
    return result;
  }

  lastReadByteLength(): number { return this.lastLength; }
  // Successful reads always consume the full frame; trailing input throws.
  lastReadHadTrailingBytes(): boolean { return false; }

  private ensure(ctx: Cursor, length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > ctx.view.byteLength - ctx.offset) throw new Error('Truncated ROS1 payload');
  }

  private consume(ctx: Cursor, count: number): void {
    if (count > ctx.values) throw new Error('ROS1 decoded value limit exceeded');
    ctx.values -= count;
  }

  private readNode(node: Node, ctx: Cursor, depth: number): any {
    if (depth > MAX_DEPTH) throw new Error('ROS1 message nesting limit exceeded');
    this.consume(ctx, 1);
    if (node.kind === 'primitive') return this.primitive(node.type, ctx);
    if (--ctx.objects < 0) throw new Error('ROS1 object count limit exceeded');
    // Null prototypes make even unusual field names data, never object setters.
    const result = Object.create(null) as Record<string, unknown>;
    for (const field of node.fields) {
      result[field.name] = field.array ? this.array(field, ctx, depth + 1) : this.readNode(field.node, ctx, depth + 1);
    }
    return result;
  }

  private array(field: Field, ctx: Cursor, depth: number): any {
    const count = field.length ?? this.primitive('uint32', ctx);
    const node = field.node;
    const type = node.kind === 'primitive' ? node.type : '';
    const isByte = type === 'uint8' || type === 'int8';
    if (!Number.isInteger(count) || count < 0 || count > (isByte ? MAX_PAYLOAD : MAX_ARRAY)) throw new Error('ROS1 array length limit exceeded');
    this.ensure(ctx, count * node.min);
    if (isByte) {
      const offset = ctx.view.byteOffset + ctx.offset;
      const result = type === 'uint8' ? new Uint8Array(ctx.view.buffer, offset, count) : new Int8Array(ctx.view.buffer, offset, count);
      ctx.offset += count;
      return result;
    }
    if (count > ctx.values || (node.kind === 'message' && count > ctx.objects)) throw new Error('ROS1 array decoded value limit exceeded');
    const constructors: Record<string, any> = {
      int16: Int16Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array,
      float32: Float32Array, float64: Float64Array, int64: BigInt64Array, uint64: BigUint64Array,
    };
    const ctor = Object.hasOwn(constructors, type) ? constructors[type] : undefined;
    if (ctor) {
      this.consume(ctx, count);
      const output = new ctor(count);
      for (let i = 0; i < count; i++) output[i] = this.primitive(type, ctx);
      return output;
    }
    const result = new Array(count);
    for (let i = 0; i < count; i++) result[i] = this.readNode(node, ctx, depth);
    return result;
  }

  private primitive(type: string, ctx: Cursor): any {
    const size = SIZES.get(type);
    if (size === undefined) throw new Error(`Unsupported ROS1 primitive: ${type}`);
    this.ensure(ctx, size);
    const p = ctx.offset, v = ctx.view;
    ctx.offset += size;
    switch (type) {
      case 'bool': return v.getUint8(p) !== 0;
      case 'int8': return v.getInt8(p);
      case 'uint8': return v.getUint8(p);
      case 'int16': return v.getInt16(p, true);
      case 'uint16': return v.getUint16(p, true);
      case 'int32': return v.getInt32(p, true);
      case 'uint32': return v.getUint32(p, true);
      case 'int64': return v.getBigInt64(p, true);
      case 'uint64': return v.getBigUint64(p, true);
      case 'float32': return v.getFloat32(p, true);
      case 'float64': return v.getFloat64(p, true);
      case 'time': return { sec: v.getUint32(p, true), nsec: v.getUint32(p + 4, true) };
      case 'duration': return { sec: v.getInt32(p, true), nsec: v.getInt32(p + 4, true) };
      case 'string': {
        const length = v.getUint32(p, true);
        if (length > MAX_STRING || length > ctx.strings) throw new Error('ROS1 string length limit exceeded');
        this.ensure(ctx, length);
        const data = new Uint8Array(v.buffer, v.byteOffset + ctx.offset, length);
        ctx.offset += length; ctx.strings -= length;
        // ROS1 strings are byte-counted, without a NUL terminator. Invalid UTF-8 is replaced.
        return this.utf8.decode(data);
      }
    }
  }
}
