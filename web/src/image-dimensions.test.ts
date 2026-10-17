/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import fixturesText from '../../qa/fixtures-data.json?raw';
import { inspectCompressedImageDimensions as inspect } from './image-dimensions';
import { bytes } from './data';
import { parse } from '@foxglove/rosmsg';
import { SafeMessageReader } from './reader';

function png(width = 320, height = 180) {
  const result = new Uint8Array(33);
  result.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(result.buffer);
  view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, width); view.setUint32(20, height);
  result[24] = 8; result[25] = 2;
  return result;
}
function jpeg(width = 320, height = 180, marker = 0xc0, prefix: number[] = []) {
  return Uint8Array.from([0xff, 0xd8, ...prefix, 0xff, marker, 0, 11, 8,
    height >>> 8, height & 255, width >>> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
}
describe('pre-decode compressed image dimensions', () => {
  it('reads PNG metadata and nonzero byteOffset without decoding pixels', () => {
    const backing = new Uint8Array(40); backing.set(png(), 4);
    expect(inspect(backing.subarray(4, 37), 'rgb8; png compressed')).toEqual({ width: 320, height: 180 });
  });
  it('reads baseline and progressive JPEG dimensions', () => {
    expect(inspect(jpeg(), 'jpeg')).toEqual({ width: 320, height: 180 });
    expect(inspect(jpeg(1920, 1080, 0xc2), 'bgr8; jpeg compressed bgr8')).toEqual({ width: 1920, height: 1080 });
  });
  it('skips JPEG application segments, fill bytes, and standalone markers', () => {
    expect(inspect(jpeg(320, 180, 0xc0, [0xff, 0xe0, 0, 4, 42, 42, 0xff, 0xff, 1]), 'jpg')).toEqual({ width: 320, height: 180 });
  });
  it('reads independently produced Python JPEG fixture dimensions', () => {
    const channel = JSON.parse(fixturesText).channels.find((c: any) => c.schemaName === 'sensor_msgs/CompressedImage');
    const msg = new SafeMessageReader(parse(channel.schema)).readMessage(bytes(channel.payloadBase64));
    expect(inspect(msg.data, msg.format)).toEqual({ width: 320, height: 180 });
  });
  it('reveals decompression-bomb dimensions before createImageBitmap would run', () => {
    const info = inspect(png(100000, 100000), 'png');
    expect(info.width * info.height).toBeGreaterThan(8_294_400);
    expect(inspect(jpeg(65535, 65535), 'jpeg')).toEqual({ width: 65535, height: 65535 });
  });
  it('rejects truncation at every PNG header byte and every required JPEG header byte', () => {
    const p = png(), j = jpeg();
    for (let i = 0; i < p.length; i++) expect(() => inspect(p.subarray(0, i), 'png')).toThrow();
    for (let i = 0; i < j.length - 2; i++) expect(() => inspect(j.subarray(0, i), 'jpeg')).toThrow();
  });
  it('rejects bad signatures, IHDR lengths, zero dimensions and invalid PNG extents', () => {
    expect(() => inspect(jpeg(), 'png')).toThrow();
    expect(() => inspect(png(), 'jpeg')).toThrow();
    const badLength = png(); badLength[11] = 14;
    expect(() => inspect(badLength, 'png')).toThrow();
    expect(() => inspect(png(0), 'png')).toThrow();
    expect(() => inspect(png(0x80000000), 'png')).toThrow();
    expect(() => inspect(jpeg(0), 'jpeg')).toThrow();
  });
  it('rejects invalid JPEG lengths, missing SOF and scan-before-dimensions', () => {
    for (const value of [
      [0xff, 0xd8, 0xff, 0xe0, 0, 1],
      [0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff],
      [0xff, 0xd8, 0xff, 0xda],
      [0xff, 0xd8, 0xff, 0xd9],
      [0xff, 0xd8, 0xff, 0],
    ]) expect(() => inspect(Uint8Array.from(value), 'jpeg')).toThrow();
    const badComponents = jpeg(); badComponents[11] = 2;
    expect(() => inspect(badComponents, 'jpeg')).toThrow();
  });
  it('rejects unsupported, ambiguous, and compressedDepth formats', () => {
    for (const format of ['gif', 'webp', 'jpeg png', '16UC1; compressedDepth png']) expect(() => inspect(png(), format)).toThrow();
  });
});
