/**
 * The parity measurement of D33 without a browser: the decoder refuses every
 * broken PNG instead of producing pixels, the metric and the histogram are
 * exact, every binding of a row is refused when it fails, and a record that is
 * incomplete or inconsistent with the golden manifest is caught.
 */
import { crc32, deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  bucketOf,
  compareFrame,
  decodePng,
  distManifest,
  distTreeSha256,
  goldenFileName,
  HISTOGRAM_BUCKETS,
  isDistPath,
  measure,
  PARITY_THRESHOLDS,
  parityMode,
  ParityRefusal,
  parityRecord,
  recordProblems,
  reportRows,
  reportTable,
  reportWorstCase,
  RUNTIME_FILES,
  servedDist,
  sha256,
  tableIn,
  worstCase,
  type GoldenFrame,
  type GoldenManifest,
  type ParityRecord,
  type ParityRow,
  type Pixels,
  type PlayerFrame,
} from './parity.js';

// --- a PNG encoder for the tests ------------------------------------------

interface Encoding {
  readonly colorType?: 2 | 6;
  /** A filter type per row, cycled; 0–4 are valid. */
  readonly filters?: readonly number[];
  readonly depth?: number;
  readonly interlace?: number;
  /** Bytes removed from the end of the raw image data before it is compressed. */
  readonly shortBy?: number;
  /** The zlib level of the image data. */
  readonly level?: number;
  /** A tEXt chunk before IEND: metadata that changes the bytes, not the pixels. */
  readonly text?: string;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  return out;
}

function filtered(filter: number, line: Uint8Array, previous: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(line.length);
  for (let x = 0; x < line.length; x += 1) {
    const a = x >= bpp ? (line[x - bpp] as number) : 0;
    const b = previous[x] as number;
    const c = x >= bpp ? (previous[x - bpp] as number) : 0;
    let predicted = 0;
    if (filter === 1) predicted = a;
    else if (filter === 2) predicted = b;
    else if (filter === 3) predicted = (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[x] = ((line[x] as number) - predicted) & 0xff;
  }
  return out;
}

function encodePng(image: Pixels, encoding: Encoding = {}): Uint8Array {
  const colorType = encoding.colorType ?? 6;
  const bpp = colorType === 6 ? 4 : 3;
  const filters = encoding.filters ?? [0];
  const stride = image.width * bpp;
  const raw: number[] = [];
  let previous = new Uint8Array(stride);
  for (let y = 0; y < image.height; y += 1) {
    const line = new Uint8Array(stride);
    for (let x = 0; x < image.width; x += 1) {
      for (let channel = 0; channel < bpp; channel += 1) {
        line[x * bpp + channel] = image.data[(y * image.width + x) * 4 + channel] as number;
      }
    }
    const filter = filters[y % filters.length] as number;
    raw.push(filter, ...filtered(filter > 4 ? 0 : filter, line, previous, bpp));
    previous = line;
  }
  const bytes = Uint8Array.from(raw.slice(0, raw.length - (encoding.shortBy ?? 0)));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = encoding.depth ?? 8;
  header[9] = colorType;
  header[12] = encoding.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(bytes, { level: encoding.level ?? -1 })),
    ...(encoding.text === undefined ? [] : [chunk('tEXt', Buffer.from(encoding.text, 'latin1'))]),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A deterministic image with varied values in every channel, so every filter predicts something. */
function image(width: number, height: number, alpha = true): Pixels {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = alpha || index % 4 !== 3 ? (index * 37 + (index >> 3) * 11) & 0xff : 255;
  }
  return { width, height, data };
}

function withPixel(source: Pixels, x: number, y: number, rgba: readonly number[]): Pixels {
  const data = Uint8Array.from(source.data);
  data.set(rgba, (y * source.width + x) * 4);
  return { ...source, data };
}

/** The chunks of a PNG as [offset, type, length]. */
function chunks(png: Uint8Array): [number, string, number][] {
  const view = Buffer.from(png);
  const found: [number, string, number][] = [];
  for (let offset = 8; offset < view.length;) {
    const length = view.readUInt32BE(offset);
    found.push([offset, view.toString('latin1', offset + 4, offset + 8), length]);
    offset += 12 + length;
  }
  return found;
}

function refusal(action: () => unknown): string {
  try {
    action();
  } catch (reason) {
    if (reason instanceof ParityRefusal) return reason.code;
    throw reason;
  }
  return 'none';
}

// --- decoder --------------------------------------------------------------

describe('decodePng (D33.3)', () => {
  it('decodes RGBA and RGB through every filter type exactly', () => {
    const rgba = image(7, 10);
    expect(decodePng(encodePng(rgba, { filters: [0, 1, 2, 3, 4] }))).toEqual(rgba);
    const rgb = image(5, 6, false);
    expect(decodePng(encodePng(rgb, { colorType: 2, filters: [4, 3, 2, 1, 0] }))).toEqual(rgb);
  });

  it('refuses a file that is not a PNG', () => {
    const png = encodePng(image(2, 2));
    const broken = Uint8Array.from(png);
    broken[1] = 0;
    expect(refusal(() => decodePng(broken))).toBe('png-invalid');
    expect(refusal(() => decodePng(new Uint8Array(3)))).toBe('png-invalid');
  });

  it('refuses a truncated file instead of reading zeros', () => {
    const png = encodePng(image(4, 4));
    for (const cut of [1, 12, 20]) {
      expect(
        refusal(() => decodePng(png.subarray(0, png.length - cut))),
        String(cut),
      ).toBe('png-invalid');
    }
  });

  it('refuses a flipped bit in any chunk by its CRC', () => {
    const png = encodePng(image(4, 4));
    for (const [offset, type, length] of chunks(png)) {
      if (length === 0) continue;
      const broken = Uint8Array.from(png);
      broken[offset + 8] = (broken[offset + 8] as number) ^ 1;
      expect(
        refusal(() => decodePng(broken)),
        type,
      ).toBe('png-invalid');
    }
  });

  it('refuses image data that is one byte short, even when it inflates', () => {
    expect(refusal(() => decodePng(encodePng(image(4, 4), { shortBy: 1 })))).toBe('png-invalid');
  });

  it('refuses a missing IEND, data after IEND, and IHDR out of place', () => {
    const png = Buffer.from(encodePng(image(2, 2)));
    const iend = chunks(png).find(([, type]) => type === 'IEND')?.[0] ?? 0;
    expect(refusal(() => decodePng(png.subarray(0, iend)))).toBe('png-invalid');
    const trailing = Buffer.concat([png, chunk('tEXt', Buffer.from('x'))]);
    expect(refusal(() => decodePng(trailing))).toBe('png-invalid');
    const [ihdr, idat] = chunks(png);
    const swapped = Buffer.concat([
      png.subarray(0, 8),
      png.subarray(idat?.[0], (idat?.[0] ?? 0) + 12 + (idat?.[2] ?? 0)),
      png.subarray(ihdr?.[0], (ihdr?.[0] ?? 0) + 12 + (ihdr?.[2] ?? 0)),
      png.subarray(iend),
    ]);
    expect(refusal(() => decodePng(swapped))).toBe('png-invalid');
  });

  it('refuses another bit depth, interlacing, and an unknown filter type', () => {
    expect(refusal(() => decodePng(encodePng(image(2, 2), { depth: 16 })))).toBe('png-invalid');
    expect(refusal(() => decodePng(encodePng(image(2, 2), { interlace: 1 })))).toBe('png-invalid');
    expect(refusal(() => decodePng(encodePng(image(2, 2), { filters: [0, 5] })))).toBe(
      'png-invalid',
    );
  });
});

// --- metric ---------------------------------------------------------------

describe('measure (D33.4)', () => {
  it('finds nothing between identical frames', () => {
    const frame = image(6, 4);
    const metric = measure(frame, { ...frame, data: Uint8Array.from(frame.data) });
    expect(metric).toMatchObject({
      differingPixels: 0,
      totalPixels: 24,
      share: 0,
      maxChannelDifference: 0,
    });
    expect(metric.histogram['0']).toBe(24);
  });

  it('counts a pixel once, by its largest channel difference, in every channel including alpha', () => {
    const frame = image(4, 4);
    const [r, g, b, a] = frame.data.subarray(0, 4) as unknown as number[];
    const one = withPixel(frame, 0, 0, [
      ((r as number) + 7) & 0xff,
      ((g as number) + 2) & 0xff,
      b as number,
      a as number,
    ]);
    expect(measure(frame, one)).toMatchObject({ differingPixels: 1, maxChannelDifference: 7 });
    expect(measure(frame, one).histogram['4-7']).toBe(1);
    const alphaOnly = withPixel(frame, 3, 3, [
      ...frame.data.subarray(60, 63),
      ((frame.data[63] as number) + 1) & 0xff,
    ]);
    expect(measure(frame, alphaOnly)).toMatchObject({
      differingPixels: 1,
      maxChannelDifference: 1,
    });
  });

  it('puts every difference in its power-of-two bucket', () => {
    const deltas = [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 255];
    expect(deltas.map(bucketOf)).toEqual([
      '0',
      '1',
      '2-3',
      '2-3',
      '4-7',
      '4-7',
      '8-15',
      '8-15',
      '16-31',
      '16-31',
      '32-63',
      '32-63',
      '64-127',
      '64-127',
      '128-255',
      '128-255',
    ]);
    const zero: Pixels = {
      width: deltas.length,
      height: 1,
      data: new Uint8Array(deltas.length * 4),
    };
    const shifted: Pixels = {
      ...zero,
      data: Uint8Array.from(deltas.flatMap((delta) => [0, delta, 0, 0])),
    };
    const metric = measure(zero, shifted);
    expect(Object.values(metric.histogram)).toEqual([1, 1, 2, 2, 2, 2, 2, 2, 2]);
    expect(Object.keys(metric.histogram)).toEqual([...HISTOGRAM_BUCKETS]);
    expect(metric).toMatchObject({ differingPixels: 15, maxChannelDifference: 255 });
    expect(metric.share).toBe(15 / 16);
  });

  it('refuses frames of different sizes instead of comparing a part', () => {
    expect(refusal(() => measure(image(4, 4), image(4, 5)))).toBe('dimension-mismatch');
    expect(refusal(() => measure(image(4, 4), image(3, 4)))).toBe('dimension-mismatch');
  });
});

// --- one row --------------------------------------------------------------

const RUNTIME = sha256('runtime');
const DOCUMENT = sha256('document');
const SIZE = { width: 4, height: 3, frameIndex: 75 };

function sides(): { player: PlayerFrame; golden: GoldenFrame } {
  const png = encodePng(image(4, 3));
  return {
    player: {
      png: encodePng(image(4, 3), { filters: [1] }),
      timeUs: 2_500_000,
      runtimeHash: RUNTIME,
      compositionHash: DOCUMENT,
    },
    golden: {
      png,
      file: goldenFileName(2_500_000),
      timeUs: 2_500_000,
      index: 75,
      sha256: sha256(png),
      runtimeHash: RUNTIME,
      compositionHash: DOCUMENT,
    },
  };
}

describe('compareFrame (D33.3)', () => {
  it('measures a bound pair and records both hashes and the identity of the row', () => {
    const { player, golden } = sides();
    const row = compareFrame(SIZE, player, golden);
    expect(row).toMatchObject({
      timeUs: 2_500_000,
      frameIndex: 75,
      runtimeHash: RUNTIME,
      compositionHash: DOCUMENT,
      width: 4,
      height: 3,
      playerPng: sha256(player.png),
      goldenPng: golden.sha256,
      goldenFile: 'reference-2500000.png',
      differingPixels: 0,
    });
  });

  it('refuses another runtime build, another document, and another time before any pixel', () => {
    const { player, golden } = sides();
    const garbage = new Uint8Array(4);
    expect(
      refusal(() =>
        compareFrame(SIZE, { ...player, png: garbage, runtimeHash: sha256('other') }, golden),
      ),
    ).toBe('runtime-mismatch');
    expect(
      refusal(() =>
        compareFrame(SIZE, { ...player, png: garbage, compositionHash: sha256('other') }, golden),
      ),
    ).toBe('document-mismatch');
    expect(
      refusal(() => compareFrame(SIZE, { ...player, png: garbage, timeUs: 2_533_333 }, golden)),
    ).toBe('time-mismatch');
  });

  it('refuses a golden frame that is not the committed one of that time', () => {
    const { player, golden } = sides();
    expect(refusal(() => compareFrame(SIZE, player, { ...golden, file: 'reference-0.png' }))).toBe(
      'golden-mismatch',
    );
    expect(refusal(() => compareFrame(SIZE, player, { ...golden, index: 76 }))).toBe(
      'golden-mismatch',
    );
    expect(refusal(() => compareFrame(SIZE, player, { ...golden, sha256: sha256('other') }))).toBe(
      'golden-mismatch',
    );
    const other = encodePng(withPixel(image(4, 3), 0, 0, [1, 2, 3, 4]));
    expect(refusal(() => compareFrame(SIZE, player, { ...golden, png: other }))).toBe(
      'golden-mismatch',
    );
  });

  it('refuses a frame that is not exactly the expected size on either side', () => {
    const { player, golden } = sides();
    const larger = encodePng(image(4, 4));
    expect(refusal(() => compareFrame(SIZE, { ...player, png: larger }, golden))).toBe(
      'dimension-mismatch',
    );
    expect(refusal(() => compareFrame({ ...SIZE, width: 5 }, player, golden))).toBe(
      'dimension-mismatch',
    );
    const smallGolden = encodePng(image(4, 2));
    expect(
      refusal(() =>
        compareFrame(SIZE, player, { ...golden, png: smallGolden, sha256: sha256(smallGolden) }),
      ),
    ).toBe('dimension-mismatch');
  });

  it('refuses a PNG it cannot decode on either side', () => {
    const { player, golden } = sides();
    const broken = Uint8Array.from(player.png);
    broken[broken.length - 1] = (broken[broken.length - 1] as number) ^ 1;
    expect(refusal(() => compareFrame(SIZE, { ...player, png: broken }, golden))).toBe(
      'png-invalid',
    );
    const brokenGolden = Uint8Array.from(golden.png);
    brokenGolden[40] = (brokenGolden[40] as number) ^ 1;
    expect(
      refusal(() =>
        compareFrame(SIZE, player, { ...golden, png: brokenGolden, sha256: sha256(brokenGolden) }),
      ),
    ).toBe('png-invalid');
  });

  it('passes identical pixels behind other PNG bytes: metadata, compression, filters (D34.3)', () => {
    const { player, golden } = sides();
    const png = encodePng(image(4, 3), {
      filters: [4],
      level: 1,
      text: 'Software\u0000another encoder',
    });
    expect(sha256(png)).not.toBe(golden.sha256);
    const measured = compareFrame(SIZE, { ...player, png }, golden);
    expect(measured).toMatchObject({ differingPixels: 0, maxChannelDifference: 0 });
    expect(measured.playerPng).not.toBe(measured.goldenPng);
  });

  it('sees a one-pixel difference between the bound frames', () => {
    const { player, golden } = sides();
    const moved = encodePng(withPixel(image(4, 3), 2, 1, [0, 0, 0, 255]));
    expect(compareFrame(SIZE, { ...player, png: moved }, golden).differingPixels).toBe(1);
  });
});

// --- the record -----------------------------------------------------------

const TIMES = [0, 2_500_000, 5_000_000, 7_500_000, 9_900_000];
const INDEX: Readonly<Record<number, number>> = {
  0: 0,
  2_500_000: 75,
  5_000_000: 150,
  7_500_000: 225,
  9_900_000: 297,
};
const ENVIRONMENT = {
  pinned: true,
  image: 'image@sha256:x',
  pinnedPlatform: 'linux/amd64',
  os: 'linux',
  arch: 'x64',
  node: 'v24',
  playwrightCore: '1.63.0',
  chromiumRevision: '1243',
  chromiumVersion: '153.0.8010.12',
  reportedVersion: '153.0.8010.12',
  channel: 'chromium',
  args: ['--a'],
  locale: 'en-US',
  timezone: 'UTC',
  viewport: { width: 4, height: 3 },
  deviceScaleFactor: 1,
  network: { interfaces: ['lo'], loopbackOnly: true },
};
/** A development machine: not the golden frames' environment. */
const INFORMATIVE = {
  ...ENVIRONMENT,
  pinned: false,
  image: null,
  os: 'win32',
  network: { interfaces: ['eth0', 'lo'], loopbackOnly: false },
};
const DIST = distManifest([
  ['packages/player/dist/player.js', new Uint8Array([1, 2, 3])],
  ['packages/player/dist/index.js', new Uint8Array([4])],
  ['packages/renderer-dom/dist/runtime-build/kadrion-runtime.js', new Uint8Array([5, 6])],
]);

function manifest(): GoldenManifest {
  return {
    render: { compositionHash: DOCUMENT, runtime: { contentHash: RUNTIME } },
    environment: ENVIRONMENT,
    frames: TIMES.map((timeUs) => ({
      file: goldenFileName(timeUs),
      timeUs,
      index: INDEX[timeUs] ?? -1,
      sha256: sha256(`golden ${String(timeUs)}`),
    })),
  };
}

function row(timeUs: number, differing: number[]): ParityRow {
  const histogram = Object.fromEntries(
    HISTOGRAM_BUCKETS.map((bucket) => [bucket, 0]),
  ) as ParityRow['histogram'];
  for (const delta of differing) histogram[bucketOf(delta)] += 1;
  histogram['0'] = 12 - differing.length;
  return {
    timeUs,
    frameIndex: INDEX[timeUs] ?? -1,
    runtimeHash: RUNTIME,
    compositionHash: DOCUMENT,
    width: 4,
    height: 3,
    playerPng: sha256(`player ${String(timeUs)}`),
    goldenPng: sha256(`golden ${String(timeUs)}`),
    goldenFile: goldenFileName(timeUs),
    differingPixels: differing.length,
    totalPixels: 12,
    share: differing.length / 12,
    maxChannelDifference: Math.max(0, ...differing),
    histogram,
  };
}

const GOLDEN = {
  manifest: manifest(),
  manifestSha256: sha256('manifest'),
  timestamps: TIMES,
  width: 4,
  height: 3,
};

const REFERENCE = {
  goldenManifest: 'packages/test-fixtures/src/golden-frames/reference.golden-frames.json',
  goldenManifestSha256: GOLDEN.manifestSha256,
  runtimeHash: RUNTIME,
  compositionHash: DOCUMENT,
  width: 4,
  height: 3,
};

/** A report-only record of another environment, with differences in its rows. */
function record(): ParityRecord {
  return parityRecord(
    INFORMATIVE,
    REFERENCE,
    [
      row(0, []),
      row(2_500_000, [3]),
      row(5_000_000, [200, 1]),
      row(7_500_000, [9, 9]),
      row(9_900_000, []),
    ],
    { gate: false, playerDist: DIST },
  );
}

/** A gated record of the reference run: the golden frames' environment, all zeros. */
function gated(differing: Readonly<Record<number, number[]>> = {}): ParityRecord {
  return parityRecord(
    ENVIRONMENT,
    REFERENCE,
    TIMES.map((timeUs) => row(timeUs, differing[timeUs] ?? [])),
    { gate: true, playerDist: DIST },
  );
}

type Draft = { -readonly [K in keyof ParityRecord]: unknown } & Record<string, unknown>;
type Edit = (draft: Draft) => void;

function problemsOf(base: ParityRecord, edit: Edit, reference = false): string {
  const draft = structuredClone(base) as unknown as Draft;
  edit(draft);
  return recordProblems(draft, GOLDEN, { reference }).join(' | ');
}

function rowsOf(draft: Draft): Record<string, unknown>[] {
  return draft.rows as Record<string, unknown>[];
}

function rowAt(draft: Draft, index: number): Record<string, unknown> {
  return rowsOf(draft)[index] as Record<string, unknown>;
}

function histogramOf(draft: Draft, index: number): Record<string, number> {
  return rowAt(draft, index).histogram as Record<string, number>;
}

function environmentOf(draft: Draft): Record<string, unknown> {
  return draft.environment as Record<string, unknown>;
}

function distOf(draft: Draft): Record<string, unknown>[] {
  return draft.playerDistManifest as Record<string, unknown>[];
}

describe('the thresholds of D34.1', () => {
  it('are zero differing pixels and a zero channel difference, frozen', () => {
    // A literal on purpose: editing the constant must fail here (D34.4).
    expect(PARITY_THRESHOLDS).toEqual({ differingPixels: 0, maxChannelDifference: 0 });
    expect(Object.isFrozen(PARITY_THRESHOLDS)).toBe(true);
  });

  it('go into a gated record, and a report-only record carries none', () => {
    expect(gated()).toMatchObject({
      recordVersion: 2,
      gate: true,
      thresholds: { differingPixels: 0, maxChannelDifference: 0 },
    });
    expect(record()).toMatchObject({ recordVersion: 2, gate: false, thresholds: null });
  });
});

describe('the record (D33.5, D33.6, D34.3)', () => {
  it('takes the worst of each metric, the earliest time on a tie', () => {
    expect(worstCase(record().rows)).toEqual({
      differingPixels: { value: 2, timeUs: 5_000_000 },
      share: { value: 2 / 12, timeUs: 5_000_000 },
      maxChannelDifference: { value: 200, timeUs: 5_000_000 },
    });
    expect(worstCase([row(0, []), row(2_500_000, [])]).differingPixels).toEqual({
      value: 0,
      timeUs: 0,
    });
  });

  it('accepts a gated record of the reference run, and a report-only record of another environment', () => {
    expect(recordProblems(gated(), GOLDEN, { reference: true })).toEqual([]);
    expect(recordProblems(record(), GOLDEN, { reference: false })).toEqual([]);
  });

  it('gates decoded pixels, not PNG bytes: other bytes with equal pixels pass', () => {
    const base = gated();
    expect(base.rows.every((entry) => entry.playerPng !== entry.goldenPng)).toBe(true);
    expect(recordProblems(base, GOLDEN, { reference: true })).toEqual([]);
  });

  // Each case names the problem it must produce, so a rule that another rule
  // happens to cover as well is still seen doing its own work.
  it.each<[string, () => ParityRecord, Edit, string, boolean?]>([
    // The version and the gate.
    [
      'a version-1 record',
      record,
      (draft) => (draft.recordVersion = 1),
      'unsupported record version 1',
    ],
    [
      'a version-3 record',
      record,
      (draft) => (draft.recordVersion = 3),
      'unsupported record version 3',
    ],
    [
      'a gate without thresholds',
      gated,
      (draft) => (draft.thresholds = null),
      'gate=true without thresholds',
    ],
    [
      'a gate with other thresholds',
      gated,
      (draft) => (draft.thresholds = { differingPixels: 5, maxChannelDifference: 0 }),
      'are not those of D34.1',
    ],
    [
      'negative thresholds',
      gated,
      (draft) => (draft.thresholds = { differingPixels: -1, maxChannelDifference: 0 }),
      'thresholds are not non-negative integers',
    ],
    [
      'a report-only record with thresholds',
      record,
      (draft) => (draft.thresholds = { differingPixels: 0, maxChannelDifference: 0 }),
      'a report-only record carries thresholds',
    ],
    [
      'a gate that is not a boolean',
      record,
      (draft) => (draft.gate = 'yes'),
      'gate is not a boolean',
    ],
    [
      'a gate on a record of another environment',
      record,
      (draft) => (draft.gate = true),
      'gate=true on a cross-environment record',
    ],
    [
      'a gate on another Chromium',
      gated,
      (draft) => (environmentOf(draft).reportedVersion = '154'),
      'gate=true on a cross-environment record: environment.reportedVersion differs',
    ],
    [
      'a gate on another device scale factor',
      gated,
      (draft) => (environmentOf(draft).deviceScaleFactor = 2),
      'environment.deviceScaleFactor differs',
    ],
    [
      'a gate on an unpinned run',
      gated,
      (draft) => (environmentOf(draft).pinned = false),
      'the environment is not pinned',
    ],
    // Over the threshold, with every other rule satisfied.
    [
      'differing pixels over the threshold',
      () => gated({ 5_000_000: [1] }),
      () => undefined,
      'row 5000000: 1 differing pixels exceed the threshold',
    ],
    [
      'a channel difference over the threshold',
      () => gated({ 5_000_000: [1] }),
      () => undefined,
      'row 5000000: a channel difference of 1 exceeds the threshold',
    ],
    // Numbers.
    [
      'NaN differing pixels',
      record,
      (draft) => (rowAt(draft, 1).differingPixels = Number.NaN),
      'row 2500000: differingPixels is not a non-negative integer',
    ],
    [
      'infinite total pixels',
      record,
      (draft) => (rowAt(draft, 1).totalPixels = Number.POSITIVE_INFINITY),
      'row 2500000: totalPixels is not a non-negative integer',
    ],
    [
      'a negative channel difference',
      record,
      (draft) => (rowAt(draft, 1).maxChannelDifference = -3),
      'row 2500000: maxChannelDifference is not a non-negative integer',
    ],
    // NaN is neither below 0 nor above 1: only the finiteness rule catches it.
    [
      'a NaN share',
      record,
      (draft) => (rowAt(draft, 1).share = Number.NaN),
      'row 2500000: share is not a finite number',
    ],
    [
      'an infinite share',
      record,
      (draft) => (rowAt(draft, 1).share = Number.POSITIVE_INFINITY),
      'row 2500000: share is not a finite number',
    ],
    [
      'a negative share',
      record,
      (draft) => (rowAt(draft, 1).share = -0.5),
      'row 2500000: share is not a finite number',
    ],
    [
      'a negative histogram bucket',
      record,
      (draft) => (histogramOf(draft, 3)['1'] = -1),
      'row 7500000: histogram buckets',
    ],
    // The environment's identity.
    [
      'an environment without a locale',
      record,
      (draft) => delete environmentOf(draft).locale,
      'the environment identity is incomplete: no locale',
    ],
    [
      'an environment without a network',
      record,
      (draft) => delete environmentOf(draft).network,
      'the environment identity is incomplete: no network',
    ],
    [
      'an environment with a null locale',
      record,
      (draft) => (environmentOf(draft).locale = null),
      'the environment identity is incomplete: no locale',
    ],
    // The Player's dist tree (D33.10).
    [
      'an unsorted dist manifest',
      gated,
      (draft) => distOf(draft).reverse(),
      'the Player dist manifest is not canonical',
    ],
    [
      'a dist path with ..',
      gated,
      (draft) =>
        ((distOf(draft)[0] as Record<string, unknown>).path = 'packages/player/dist/../../x.js'),
      'the Player dist manifest is not canonical',
    ],
    [
      'a dist entry with an extra key',
      gated,
      (draft) => ((distOf(draft)[0] as Record<string, unknown>).mtime = 1),
      'the Player dist manifest is not canonical',
    ],
    [
      'a dist manifest without the Player',
      gated,
      (draft) => distOf(draft).splice(0, 2),
      'has no packages/player/dist/index.js',
    ],
    [
      'another dist tree hash',
      gated,
      (draft) => (draft.playerDistTreeSha256 = sha256('x')),
      'playerDistTreeSha256 is not the hash',
    ],
    [
      'an edited dist size',
      gated,
      (draft) => ((distOf(draft)[0] as Record<string, unknown>).size = 9),
      'playerDistTreeSha256 is not the hash',
    ],
    // Rows.
    ['a missing row', record, (draft) => rowsOf(draft).pop(), 'rows are'],
    ['rows out of order', record, (draft) => rowsOf(draft).reverse(), 'rows are'],
    [
      'another runtime in a row',
      record,
      (draft) => (rowAt(draft, 1).runtimeHash = sha256('x')),
      'row 2500000: runtime hash',
    ],
    [
      'another document in a row',
      record,
      (draft) => (rowAt(draft, 1).compositionHash = sha256('x')),
      'row 2500000: composition hash',
    ],
    [
      'another golden PNG',
      record,
      (draft) => (rowAt(draft, 2).goldenPng = sha256('x')),
      'row 5000000: golden PNG hash',
    ],
    [
      'another golden file',
      record,
      (draft) => (rowAt(draft, 2).goldenFile = 'reference-0.png'),
      'row 5000000: golden file',
    ],
    [
      'another frame index',
      record,
      (draft) => (rowAt(draft, 2).frameIndex = 151),
      'row 5000000: frame index',
    ],
    [
      'no Player PNG hash',
      record,
      (draft) => (rowAt(draft, 2).playerPng = ''),
      'row 5000000: Player PNG hash',
    ],
    ['other dimensions', record, (draft) => (rowAt(draft, 0).width = 5), 'row 0: dimensions'],
    ['an extra key', record, (draft) => (rowAt(draft, 0).scaled = true), 'row 0: unexpected keys'],
    // One more pixel in a non-zero bucket: differingPixels, the maximum, and the
    // worst case all still agree, so only the sum can catch it.
    [
      'a histogram that does not sum',
      record,
      (draft) => (histogramOf(draft, 3)['8-15'] = 3),
      'row 7500000: the histogram sums to 13',
    ],
    [
      'a histogram without a bucket',
      record,
      (draft) => delete histogramOf(draft, 3)['1'],
      'row 7500000: histogram buckets',
    ],
    [
      'differing pixels that disagree',
      record,
      (draft) => (rowAt(draft, 3).differingPixels = 1),
      'row 7500000: differingPixels disagrees',
    ],
    [
      'a rounded share',
      record,
      (draft) => (rowAt(draft, 3).share = 0.16),
      'row 7500000: share is not the quotient',
    ],
    // Below the worst case of 200, so only the histogram rule can catch it.
    [
      'a max outside its bucket',
      record,
      (draft) => (rowAt(draft, 3).maxChannelDifference = 20),
      'row 7500000: maxChannelDifference disagrees',
    ],
    [
      'identical PNGs with differing pixels',
      record,
      (draft) => (rowAt(draft, 2).playerPng = rowAt(draft, 2).goldenPng),
      'row 5000000: identical PNGs',
    ],
    [
      'an edited worst case',
      record,
      (draft) =>
        ((draft.worstCase as Record<string, unknown>).differingPixels = { value: 0, timeUs: 0 }),
      'worstCase is not',
    ],
    [
      'another golden manifest',
      record,
      (draft) => ((draft.reference as Record<string, unknown>).goldenManifestSha256 = sha256('x')),
      'reference is',
    ],
    // The committed record of the reference run (D33.6).
    [
      'a report-only record as the reference',
      record,
      () => undefined,
      'the committed record is not a gated measurement',
      true,
    ],
    [
      'a reference run with a network',
      gated,
      (draft) =>
        (environmentOf(draft).network = { interfaces: ['eth0', 'lo'], loopbackOnly: false }),
      'loopback only',
      true,
    ],
  ])('refuses %s', (_, base, edit, problem, reference = false) => {
    expect(problemsOf(base(), edit, reference)).toContain(problem);
  });

  it('lets a pinned run with a network gate: only the committed record needs isolation', () => {
    const withNetwork = structuredClone(gated()) as unknown as Draft;
    environmentOf(withNetwork).network = { interfaces: ['eth0', 'lo'], loopbackOnly: false };
    // CI: pinned, with a network. The gate holds there; only the committed record needs isolation.
    expect(recordProblems(withNetwork, GOLDEN, { reference: false })).toEqual([]);
  });
});

describe("the Player's dist tree (D33.10)", () => {
  it('sorts by path, hashes each file, and hashes the canonical JSON', () => {
    expect(DIST.map((entry) => entry.path)).toEqual([
      'packages/player/dist/index.js',
      'packages/player/dist/player.js',
      'packages/renderer-dom/dist/runtime-build/kadrion-runtime.js',
    ]);
    expect(DIST[0]).toEqual({
      path: 'packages/player/dist/index.js',
      size: 1,
      sha256: sha256(new Uint8Array([4])),
    });
    expect(distTreeSha256(DIST)).toBe(sha256(JSON.stringify(DIST)));
    expect(gated().playerDistTreeSha256).toBe(distTreeSha256(DIST));
  });

  it('refuses a repeated path, a path with .., an absolute path, and a backslash', () => {
    const bytes = new Uint8Array([1]);
    expect(() =>
      distManifest([
        ['packages/player/dist/index.js', bytes],
        ['packages/player/dist/index.js', bytes],
      ]),
    ).toThrow(/repeats/);
    for (const path of [
      'packages/player/dist/../x.js',
      '/packages/player/dist/index.js',
      'packages\\player\\dist\\index.js',
      'apps/playground/dist/app.js',
    ]) {
      expect(() => distManifest([[path, bytes]]), path).toThrow(/dist path/);
      expect(isDistPath(path), path).toBe(false);
    }
  });

  it('follows the static imports of @kadrion/player through the import map, plus the runtime files', () => {
    const text = (value: string): Uint8Array => new TextEncoder().encode(value);
    const disk = new Map<string, Uint8Array>([
      [
        'packages/player/dist/index.js',
        text("export { createPlayer } from './player.js';\nexport * from './errors.js';\n"),
      ],
      [
        'packages/player/dist/player.js',
        text(
          "import {\n  validate,\n} from '@kadrion/schema';\nimport './side-effect.js';\n// the word import in a comment\nexport const x = 1;\n",
        ),
      ],
      ['packages/player/dist/errors.js', text('export class E extends Error {}\n')],
      ['packages/player/dist/side-effect.js', text('globalThis.x = 1;\n')],
      ['packages/schema/dist/index.js', text("export * from './validate.js';\n")],
      ['packages/schema/dist/validate.js', text('export const validate = () => true;\n')],
      ['packages/schema/dist/unused.js', text('export const unused = 1;\n')],
      [RUNTIME_FILES[0], text('runtime')],
      [RUNTIME_FILES[1], text('{}')],
    ]);
    const read = (path: string): Uint8Array => {
      const bytes = disk.get(path);
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return bytes;
    };
    expect([...servedDist(read).keys()].sort()).toEqual([
      'packages/player/dist/errors.js',
      'packages/player/dist/index.js',
      'packages/player/dist/player.js',
      'packages/player/dist/side-effect.js',
      'packages/renderer-dom/dist/runtime-build/kadrion-runtime.js',
      'packages/renderer-dom/dist/runtime-build/kadrion-runtime.json',
      'packages/schema/dist/index.js',
      'packages/schema/dist/validate.js',
    ]);
    disk.set('packages/player/dist/errors.js', text("import '@kadrion/test-fixtures';\n"));
    expect(() => servedDist(read)).toThrow(/does not map/);
    disk.set('packages/player/dist/errors.js', text("import '../../schema/dist/index.js';\n"));
    expect(() => servedDist(read)).toThrow(/outside its package/);
    disk.set('packages/player/dist/errors.js', text("import './gone.js';\n"));
    expect(() => servedDist(read)).toThrow(/missing packages\/player\/dist\/gone\.js/);
    // Quoted import text in a comment is followed too: it fails closed, never silently.
    disk.set('packages/player/dist/errors.js', text("// see: import x from './also-gone.js'\n"));
    expect(() => servedDist(read)).toThrow(/missing packages\/player\/dist\/also-gone\.js/);
  });
});

describe('the three cases of a run (D34.3)', () => {
  const PINNED = 'image@sha256:x';

  it('reports without the variable, in any environment', () => {
    expect(parityMode(undefined, PINNED, INFORMATIVE, ENVIRONMENT)).toBe('report');
  });

  it("gates when the variable names the pinned image in the golden frames' environment", () => {
    expect(parityMode(PINNED, PINNED, ENVIRONMENT, ENVIRONMENT)).toBe('gate');
  });

  it('fails, never reports, when the variable names another image', () => {
    expect(() => parityMode('image@sha256:y', PINNED, ENVIRONMENT, ENVIRONMENT)).toThrow(
      /names image@sha256:y/,
    );
    expect(() => parityMode('', PINNED, ENVIRONMENT, ENVIRONMENT)).toThrow(/not the pinned image/);
  });

  it("fails, never reports, when a pinned run is not in the golden frames' environment", () => {
    expect(() => parityMode(PINNED, PINNED, INFORMATIVE, ENVIRONMENT)).toThrow(
      /outside the golden frames' environment/,
    );
    expect(() =>
      parityMode(PINNED, PINNED, { ...ENVIRONMENT, locale: 'pl-PL' }, ENVIRONMENT),
    ).toThrow(/environment\.locale differs/);
  });
});

describe('the report table (D33.6)', () => {
  it('reads back the cells it writes, whatever the column alignment', () => {
    const written = reportTable(record());
    const aligned = written
      .split('\n')
      .map((line) => line.replace(/ \| /g, '   |   '))
      .join('\n');
    const report = `text\n\n<!-- parity-table:start -->\n\n${aligned}\n\n<!-- parity-table:end -->\n`;
    expect(tableIn(report)).toEqual(reportRows(record()));
    expect(tableIn('no table')).toBeNull();
  });

  it('formats the numbers of each row and the worst case', () => {
    expect(reportRows(record())[2]).toEqual([
      '5000000',
      '150',
      '2 / 12',
      '16.6667 %',
      '200',
      '10 / 1 / 0 / 0 / 0 / 0 / 0 / 0 / 1',
    ]);
    expect(reportWorstCase(record())).toBe(
      'Worst case: 2 differing pixels (at 5000000 µs), share 16.6667 % (at 5000000 µs), maximum channel difference 200 (at 5000000 µs).',
    );
  });
});
