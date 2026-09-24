/**
 * The image asset: a 128 x 128 truecolour PNG with a fixed pattern. The zlib
 * stream uses stored (uncompressed) blocks, so the bytes do not depend on the
 * version of any compression library.
 */
import { adler32, ByteWriter, crc32 } from './bytes.js';

export const IMAGE_SIZE = 128;

/** The colour of one pixel: a border, quadrants, and a diagonal, in integers only. */
function pixel(x: number, y: number): readonly [number, number, number] {
  const edge = Math.min(x, y, IMAGE_SIZE - 1 - x, IMAGE_SIZE - 1 - y);
  if (edge < 8) return [255, 255, 255];
  if (x === y || x + y === IMAGE_SIZE - 1) return [11, 16, 32];
  const left = x < IMAGE_SIZE / 2;
  const top = y < IMAGE_SIZE / 2;
  if (top && left) return [21, 94, 239];
  if (top) return [247, 144, 9];
  if (left) return [18, 183, 106];
  return [240, 68, 56];
}

function chunk(out: ByteWriter, type: string, data: Uint8Array): void {
  const body = new ByteWriter().ascii(type).append(data).toBytes();
  out.u32be(data.length).append(body).u32be(crc32(body));
}

/** A zlib stream (RFC 1950) of stored deflate blocks (RFC 1951, BTYPE 00). */
function storedZlib(raw: Uint8Array): Uint8Array {
  const out = new ByteWriter().u8(0x78).u8(0x01);
  const limit = 0xffff;
  for (let start = 0; start < raw.length || start === 0; start += limit) {
    const block = raw.subarray(start, start + limit);
    const final = start + limit >= raw.length ? 1 : 0;
    out
      .u8(final)
      .u16le(block.length)
      .u16le(~block.length & 0xffff)
      .append(block);
    if (raw.length === 0) break;
  }
  return out.u32be(adler32(raw)).toBytes();
}

export function generateImage(): Uint8Array {
  const raw = new ByteWriter();
  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    raw.u8(0); // filter type None
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw.u8(r).u8(g).u8(b);
    }
  }
  const header = new ByteWriter()
    .u32be(IMAGE_SIZE)
    .u32be(IMAGE_SIZE)
    .u8(8) // bit depth
    .u8(2) // colour type: truecolour
    .u8(0) // compression
    .u8(0) // filter
    .u8(0) // interlace
    .toBytes();
  const out = new ByteWriter().append(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  );
  chunk(out, 'IHDR', header);
  chunk(out, 'IDAT', storedZlib(raw.toBytes()));
  chunk(out, 'IEND', new Uint8Array(0));
  return out.toBytes();
}
