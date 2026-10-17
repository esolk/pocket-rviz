/** Read dimensions before a browser decoder allocates a compressed image bitmap.
 * This is a bounded header inspection, not an image decoder or integrity check.
 * Browser decoding must still reject corrupt compressed data, and callers must
 * impose their pixel/byte limits before calling createImageBitmap.
 */
export function inspectCompressedImageDimensions(
  data: Uint8Array,
  format: string,
): { width: number; height: number } {
  if (!(data instanceof Uint8Array))
    throw new Error("Expected compressed image bytes");
  const requested = String(format).toLowerCase();
  if (requested.includes("compresseddepth"))
    throw new Error("Unsupported compressedDepth image");
  const png = requested.includes("png");
  const jpeg = requested.includes("jpeg") || requested.includes("jpg");
  if (png === jpeg)
    throw new Error("Unsupported or ambiguous compressed image format");
  const dimensions = (width: number, height: number) => {
    if (!width || !height) throw new Error("Malformed image: zero dimensions");
    return { width, height };
  };
  if (png) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (data.length < 33 || !signature.every((value, i) => data[i] === value))
      throw new Error("Malformed PNG signature or IHDR");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // IHDR must be the first chunk and exactly 13 bytes, followed by its CRC.
    if (
      view.getUint32(8, false) !== 13 ||
      view.getUint32(12, false) !== 0x49484452
    )
      throw new Error("Malformed PNG IHDR");
    const width = view.getUint32(16, false),
      height = view.getUint32(20, false);
    // PNG dimensions are limited to 2^31-1 by the file format.
    if (width > 0x7fffffff || height > 0x7fffffff)
      throw new Error("Malformed PNG dimensions");
    return dimensions(width, height);
  }

  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8)
    throw new Error("Malformed JPEG signature");
  const startsFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) throw new Error("Malformed JPEG marker");
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) throw new Error("Truncated JPEG marker");
    const marker = data[offset++];
    if (marker === 0 || marker === 0xd8)
      throw new Error("Malformed JPEG marker");
    if (marker === 0xda || marker === 0xd9)
      throw new Error("JPEG has no supported dimensions before scan");
    // TEM and restart markers carry no segment length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) throw new Error("Truncated JPEG segment");
    const length = (data[offset] << 8) | data[offset + 1];
    if (length < 2 || length > data.length - offset)
      throw new Error("Malformed or truncated JPEG segment");
    if (startsFrame.has(marker)) {
      if (length < 11) throw new Error("Malformed JPEG frame header");
      const components = data[offset + 7];
      if (!components || length !== 8 + 3 * components)
        throw new Error("Malformed JPEG component table");
      return dimensions(
        (data[offset + 5] << 8) | data[offset + 6],
        (data[offset + 3] << 8) | data[offset + 4],
      );
    }
    offset += length;
  }
  throw new Error("JPEG frame dimensions are missing");
}
