/**
 * Byte helpers for the generated fixture assets: a growable big-endian or
 * little-endian writer and the two checksums the formats need. Pure integer
 * arithmetic, no platform API, so the bytes are the same everywhere.
 */
export class ByteWriter {
  private readonly bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16be(value: number): this {
    return this.u8(value >>> 8).u8(value);
  }

  u32be(value: number): this {
    return this.u16be(value >>> 16).u16be(value);
  }

  u16le(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }

  u32le(value: number): this {
    return this.u16le(value).u16le(value >>> 16);
  }

  ascii(text: string): this {
    for (let index = 0; index < text.length; index += 1) this.u8(text.charCodeAt(index));
    return this;
  }

  append(bytes: Uint8Array): this {
    for (const byte of bytes) this.bytes.push(byte);
    return this;
  }

  /** Zero bytes until the length is a multiple of `alignment`. */
  pad(alignment: number): this {
    while (this.bytes.length % alignment !== 0) this.bytes.push(0);
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** CRC-32 of ISO 3309, as PNG uses it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32 of RFC 1950, the checksum of a zlib stream. */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
