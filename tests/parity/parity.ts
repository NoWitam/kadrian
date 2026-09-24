/**
 * The parity measurement of D33: a strict PNG decoder, the metric of §6.2, the
 * refusals that keep a row from comparing frames of different runtime builds,
 * documents, times, or sizes, and the completeness rules of the record.
 *
 * Pure on purpose: no workspace import, no browser. The pinned test computes
 * hashes and times with the packages and passes them in; `check` tests this
 * module and the committed record without Chromium.
 */
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';

export type RefusalCode =
  | 'runtime-mismatch'
  | 'document-mismatch'
  | 'time-mismatch'
  | 'golden-mismatch'
  | 'png-invalid'
  | 'dimension-mismatch';

/** A comparison that must not produce a number (D33.3). */
export class ParityRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ParityRefusal';
    this.code = code;
  }
}

export function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

// --- PNG ------------------------------------------------------------------

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits per channel. */
  readonly data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function invalid(message: string): ParityRefusal {
  return new ParityRefusal('png-invalid', message);
}

/**
 * Decodes the 8-bit RGB or RGBA, non-interlaced PNG that Chromium writes, and
 * refuses everything else rather than guessing: a truncated or corrupted file is
 * an error, never an image of black pixels (D33.3).
 */
export function decodePng(png: Uint8Array): Pixels {
  if (png.length < SIGNATURE.length || SIGNATURE.some((byte, at) => png[at] !== byte)) {
    throw invalid('not a PNG signature');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let header: Uint8Array | null = null;
  let ended = false;
  const idat: Uint8Array[] = [];
  let offset = SIGNATURE.length;
  while (offset < png.length) {
    if (ended) throw invalid('data after IEND');
    if (offset + 12 > png.length) throw invalid('truncated chunk header');
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw invalid('truncated chunk');
    const typeAndData = png.subarray(offset + 4, offset + 8 + length);
    const type = String.fromCharCode(...typeAndData.subarray(0, 4));
    const data = typeAndData.subarray(4);
    if (crc32(typeAndData) !== view.getUint32(offset + 8 + length)) {
      throw invalid(`CRC mismatch in ${type}`);
    }
    if (header === null && type !== 'IHDR') throw invalid('IHDR is not the first chunk');
    if (type === 'IHDR') {
      if (header !== null) throw invalid('a second IHDR');
      if (length !== 13) throw invalid('IHDR has the wrong length');
      header = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    }
    offset = end;
  }
  if (header === null) throw invalid('no IHDR');
  if (!ended) throw invalid('no IEND');
  const head = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = head.getUint32(0);
  const height = head.getUint32(4);
  const [depth, colorType, compression, filterMethod, interlace] = header.subarray(8);
  if (width === 0 || height === 0) throw invalid('an empty image');
  if (depth !== 8) throw invalid(`bit depth ${String(depth)}`);
  if (colorType !== 2 && colorType !== 6) throw invalid(`colour type ${String(colorType)}`);
  if (compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw invalid('an unsupported compression, filter method, or interlace');
  }
  if (idat.length === 0) throw invalid('no IDAT');
  const channels = colorType === 6 ? 4 : 3;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (reason) {
    throw invalid(`the image data does not inflate: ${String(reason)}`);
  }
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) {
    throw invalid(
      `${String(raw.length)} bytes of image data, expected ${String(height * (stride + 1))}`,
    );
  }
  const current = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start] as number;
    if (filter > 4) throw invalid(`filter type ${String(filter)} in row ${String(y)}`);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? (current[x - channels] as number) : 0;
      const b = previous[x] as number;
      const c = x >= channels ? (previous[x - channels] as number) : 0;
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
      current[x] = ((raw[start + 1 + x] as number) + predicted) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      out[target] = current[x * channels] as number;
      out[target + 1] = current[x * channels + 1] as number;
      out[target + 2] = current[x * channels + 2] as number;
      out[target + 3] = channels === 4 ? (current[x * channels + 3] as number) : 255;
    }
    previous.set(current);
  }
  return { width, height, data: out };
}

// --- metric (D33.4) -------------------------------------------------------

/** Buckets of a pixel's largest channel difference. */
export const HISTOGRAM_BUCKETS = [
  '0',
  '1',
  '2-3',
  '4-7',
  '8-15',
  '16-31',
  '32-63',
  '64-127',
  '128-255',
] as const;
export type Bucket = (typeof HISTOGRAM_BUCKETS)[number];
export type Histogram = Record<Bucket, number>;

/** The bucket of a difference 0–255: 0, then one bucket per power of two. */
export function bucketOf(delta: number): Bucket {
  const index = delta === 0 ? 0 : Math.floor(Math.log2(delta)) + 1;
  return HISTOGRAM_BUCKETS[index] as Bucket;
}

export interface Metric {
  readonly differingPixels: number;
  readonly totalPixels: number;
  readonly share: number;
  readonly maxChannelDifference: number;
  readonly histogram: Histogram;
}

/** The metric of §6.2 and D33.4. Frames of different sizes are refused, never compared. */
export function measure(a: Pixels, b: Pixels): Metric {
  if (a.width !== b.width || a.height !== b.height) {
    throw new ParityRefusal(
      'dimension-mismatch',
      `${String(a.width)}x${String(a.height)} against ${String(b.width)}x${String(b.height)}`,
    );
  }
  const counts = new Array<number>(256).fill(0);
  for (let index = 0; index < a.data.length; index += 4) {
    let largest = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        (a.data[index + channel] as number) - (b.data[index + channel] as number),
      );
      if (delta > largest) largest = delta;
    }
    counts[largest] = (counts[largest] as number) + 1;
  }
  const histogram = Object.fromEntries(HISTOGRAM_BUCKETS.map((bucket) => [bucket, 0])) as Histogram;
  let maxChannelDifference = 0;
  counts.forEach((count, delta) => {
    if (count === 0) return;
    histogram[bucketOf(delta)] += count;
    maxChannelDifference = delta;
  });
  const totalPixels = a.width * a.height;
  const differingPixels = totalPixels - histogram['0'];
  return {
    differingPixels,
    totalPixels,
    share: differingPixels / totalPixels,
    maxChannelDifference,
    histogram,
  };
}

// --- one row (D33.3) ------------------------------------------------------

export interface Expected {
  readonly width: number;
  readonly height: number;
}

export interface PlayerFrame {
  readonly png: Uint8Array;
  /** The time the Player confirmed for this frame. */
  readonly timeUs: number;
  /** The runtime hash the Player verified (D25.5). */
  readonly runtimeHash: string;
  /** `sha256(canonicalJson(validated document))` of the text the host returned. */
  readonly compositionHash: string;
}

export interface GoldenFrame {
  readonly png: Uint8Array;
  readonly file: string;
  readonly timeUs: number;
  readonly index: number;
  readonly sha256: string;
  /** `render.runtime.contentHash` of the golden manifest. */
  readonly runtimeHash: string;
  /** `render.compositionHash` of the golden manifest. */
  readonly compositionHash: string;
}

export interface ParityRow extends Metric {
  readonly timeUs: number;
  readonly frameIndex: number;
  readonly runtimeHash: string;
  readonly compositionHash: string;
  readonly width: number;
  readonly height: number;
  readonly playerPng: string;
  readonly goldenPng: string;
  readonly goldenFile: string;
}

export function goldenFileName(timeUs: number): string {
  return `reference-${String(timeUs)}.png`;
}

/**
 * One row of the measurement, or a `ParityRefusal`: every binding of D33.3 is
 * checked before a single pixel is compared.
 */
export function compareFrame(
  expected: Expected & { readonly frameIndex: number },
  player: PlayerFrame,
  golden: GoldenFrame,
): ParityRow {
  if (player.runtimeHash !== golden.runtimeHash) {
    throw new ParityRefusal(
      'runtime-mismatch',
      `the Player ran ${player.runtimeHash}, the golden frames ${golden.runtimeHash}`,
    );
  }
  if (player.compositionHash !== golden.compositionHash) {
    throw new ParityRefusal(
      'document-mismatch',
      `the Player loaded ${player.compositionHash}, the golden frames ${golden.compositionHash}`,
    );
  }
  if (player.timeUs !== golden.timeUs) {
    throw new ParityRefusal(
      'time-mismatch',
      `the Player showed ${String(player.timeUs)}, the golden frame is ${String(golden.timeUs)}`,
    );
  }
  if (golden.file !== goldenFileName(golden.timeUs) || golden.index !== expected.frameIndex) {
    throw new ParityRefusal(
      'golden-mismatch',
      `${golden.file} (frame ${String(golden.index)}) is not the golden frame of ${String(golden.timeUs)} (frame ${String(expected.frameIndex)})`,
    );
  }
  const goldenPng = sha256(golden.png);
  if (goldenPng !== golden.sha256) {
    throw new ParityRefusal(
      'golden-mismatch',
      `${golden.file} hashes to ${goldenPng}, the manifest says ${golden.sha256}`,
    );
  }
  const shown = decodePng(player.png);
  const reference = decodePng(golden.png);
  for (const [name, image] of [
    ['Player', shown],
    ['golden', reference],
  ] as const) {
    if (image.width !== expected.width || image.height !== expected.height) {
      throw new ParityRefusal(
        'dimension-mismatch',
        `the ${name} frame is ${String(image.width)}x${String(image.height)}, expected ${String(expected.width)}x${String(expected.height)}`,
      );
    }
  }
  return {
    timeUs: player.timeUs,
    frameIndex: expected.frameIndex,
    runtimeHash: player.runtimeHash,
    compositionHash: player.compositionHash,
    width: expected.width,
    height: expected.height,
    playerPng: sha256(player.png),
    goldenPng,
    goldenFile: golden.file,
    ...measure(shown, reference),
  };
}

// --- the record (D33.5, D33.6, D34.3) -------------------------------------

export interface Extreme {
  readonly value: number;
  readonly timeUs: number;
}

export interface WorstCase {
  readonly differingPixels: Extreme;
  readonly share: Extreme;
  readonly maxChannelDifference: Extreme;
}

export interface RecordReference {
  readonly goldenManifest: string;
  readonly goldenManifestSha256: string;
  readonly runtimeHash: string;
  readonly compositionHash: string;
  readonly width: number;
  readonly height: number;
}

/** The thresholds of D34.1. Changing them takes a new ADR (D34.4). */
export interface Thresholds {
  readonly differingPixels: number;
  readonly maxChannelDifference: number;
}

export const PARITY_THRESHOLDS: Thresholds = Object.freeze({
  differingPixels: 0,
  maxChannelDifference: 0,
});

/** One file of the Player's dist tree (D33.10). */
export interface DistEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ParityRecord {
  readonly recordVersion: 2;
  readonly method: 'D33';
  /** D34.1 on a gated record, `null` on a report-only one. */
  readonly thresholds: Thresholds | null;
  /** `true` only for a measurement in the pinned environment of the golden frames (D34.3). */
  readonly gate: boolean;
  readonly environment: object;
  readonly reference: RecordReference;
  readonly playerDistTreeSha256: string;
  readonly playerDistManifest: readonly DistEntry[];
  readonly rows: readonly ParityRow[];
  readonly worstCase: WorstCase;
}

/** The largest value of each metric over the rows; a tie goes to the earliest time. */
export function worstCase(rows: readonly ParityRow[]): WorstCase {
  const extreme = (pick: (row: ParityRow) => number): Extreme => {
    let best: Extreme | null = null;
    for (const row of rows) {
      const value = pick(row);
      if (
        best === null ||
        value > best.value ||
        (value === best.value && row.timeUs < best.timeUs)
      ) {
        best = { value, timeUs: row.timeUs };
      }
    }
    if (best === null) throw new Error('A record needs at least one row.');
    return best;
  };
  return {
    differingPixels: extreme((row) => row.differingPixels),
    share: extreme((row) => row.share),
    maxChannelDifference: extreme((row) => row.maxChannelDifference),
  };
}

export function parityRecord(
  environment: object,
  reference: RecordReference,
  rows: readonly ParityRow[],
  options: { readonly gate: boolean; readonly playerDist: readonly DistEntry[] },
): ParityRecord {
  return {
    recordVersion: 2,
    method: 'D33',
    thresholds: options.gate ? PARITY_THRESHOLDS : null,
    gate: options.gate,
    environment,
    reference,
    playerDistTreeSha256: distTreeSha256(options.playerDist),
    playerDistManifest: options.playerDist,
    rows,
    worstCase: worstCase(rows),
  };
}

// --- the Player's dist tree (D33.10) --------------------------------------

/** The host's import map (D33.2): `@kadrion/<name>` → `packages/<name>/dist/index.js`. */
export const HOST_PACKAGES = ['player', 'renderer-dom', 'runtime', 'schema'] as const;
/** The two runtime files the host fetches besides the modules it imports. */
export const RUNTIME_FILES = [
  'packages/renderer-dom/dist/runtime-build/kadrion-runtime.js',
  'packages/renderer-dom/dist/runtime-build/kadrion-runtime.json',
] as const;
export const PLAYER_ENTRY = 'packages/player/dist/index.js';

const DIST_PATH = /^packages\/[a-z-]+\/dist\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

/** Whether a path is repository-relative POSIX inside a package's dist, with no `..` (D33.10). */
export function isDistPath(path: string): boolean {
  return DIST_PATH.test(path) && !path.split('/').some((part) => part === '..' || part === '.');
}

/** The canonical manifest: one entry per file, sorted by path in code-unit order, no repeats. */
export function distManifest(files: Iterable<readonly [string, Uint8Array]>): readonly DistEntry[] {
  const entries = [...files].map(([path, bytes]) => {
    if (!isDistPath(path)) throw new Error(`${path} is not a repository-relative dist path.`);
    return { path, size: bytes.length, sha256: sha256(bytes) };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  entries.forEach((entry, at) => {
    if (at > 0 && entries[at - 1]?.path === entry.path) throw new Error(`${entry.path} repeats.`);
  });
  return entries;
}

/** SHA-256 of `JSON.stringify` of the entries, keys in the order path, size, sha256. */
export function distTreeSha256(entries: readonly DistEntry[]): string {
  return sha256(
    JSON.stringify(entries.map(({ path, size, sha256: hash }) => ({ path, size, sha256: hash }))),
  );
}

const SPECIFIER = /(?:^|[\s;{}])(?:import|export)\s(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

function resolveSpecifier(from: string, specifier: string): string {
  const bare = /^@kadrion\/([a-z-]+)$/.exec(specifier);
  if (bare?.[1] !== undefined) {
    if (!(HOST_PACKAGES as readonly string[]).includes(bare[1])) {
      throw new Error(`${from} imports ${specifier}, which the host does not map.`);
    }
    return `packages/${bare[1]}/dist/index.js`;
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error(`${from} imports ${specifier}, which the host cannot serve.`);
  }
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const resolved = parts.join('/');
  const packageDist = from.split('/').slice(0, 3).join('/');
  if (!resolved.startsWith(`${packageDist}/`)) {
    throw new Error(`${from} imports ${specifier} outside its package's dist.`);
  }
  return resolved;
}

/**
 * Every file the conformance host serves (D33.10): the static import closure of
 * `@kadrion/player` through the import map, and the runtime files. `read`
 * returns the bytes of a repository path, or throws when the file is missing.
 */
export function servedDist(read: (path: string) => Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const pending: string[] = [PLAYER_ENTRY];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (files.has(path)) continue;
    const bytes = read(path);
    files.set(path, bytes);
    const text = Buffer.from(bytes).toString('utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      if (match[1] !== undefined) pending.push(resolveSpecifier(path, match[1]));
    }
  }
  for (const path of RUNTIME_FILES) files.set(path, read(path));
  return files;
}

// --- checking a record ----------------------------------------------------

/** What `recordProblems` checks a record against: the golden manifest as committed. */
export interface GoldenManifest {
  readonly render: {
    readonly compositionHash: string;
    readonly runtime: { readonly contentHash: string };
  };
  readonly environment: object;
  readonly frames: readonly {
    readonly file: string;
    readonly timeUs: number;
    readonly index: number;
    readonly sha256: string;
  }[];
}

/** The fields of the environment manifest (D26.4) that can change a pixel (D33.6). */
export const PIXEL_ENVIRONMENT = [
  'pinned',
  'image',
  'pinnedPlatform',
  'os',
  'arch',
  'playwrightCore',
  'chromiumRevision',
  'chromiumVersion',
  'reportedVersion',
  'channel',
  'args',
  'locale',
  'timezone',
  'viewport',
  'deviceScaleFactor',
] as const;

const HASH = /^sha256:[0-9a-f]{64}$/;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function count(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Why a measurement's environment cannot carry the gate (D34.3): it is not
 * pinned, or a pixel-relevant field differs from the golden frames'
 * environment. Empty when the gate applies.
 */
export function gateEnvironmentProblems(environment: object, goldenEnvironment: object): string[] {
  const measured = environment as Readonly<Record<string, unknown>>;
  const golden = goldenEnvironment as Readonly<Record<string, unknown>>;
  const problems: string[] = [];
  if (measured.pinned !== true) problems.push('the environment is not pinned (D26.2)');
  for (const field of PIXEL_ENVIRONMENT) {
    if (!same(measured[field], golden[field])) {
      problems.push(`environment.${field} differs from the golden frames' environment`);
    }
  }
  return problems;
}

/**
 * The three cases of D34.3. Without `claimed` (the value of
 * `KADRION_PINNED_IMAGE`), a run only reports. With it, it must name the pinned
 * image and run in the golden frames' environment, and then it is gated; it
 * never falls back to a report. Throws otherwise.
 */
export function parityMode(
  claimed: string | undefined,
  pinnedImage: string,
  environment: object,
  goldenEnvironment: object,
): 'report' | 'gate' {
  if (claimed === undefined) return 'report';
  if (claimed !== pinnedImage) {
    throw new Error(`KADRION_PINNED_IMAGE names ${claimed}, not the pinned image ${pinnedImage}.`);
  }
  const problems = gateEnvironmentProblems(environment, goldenEnvironment);
  if (problems.length > 0) {
    throw new Error(`A pinned run outside the golden frames' environment: ${problems.join('; ')}.`);
  }
  return 'gate';
}

/**
 * Everything that makes a record incomplete, inconsistent with the golden
 * manifest it claims to measure against, or over its thresholds (D33.5, D34.3).
 * With `reference`, also what keeps it from being the committed record of the
 * reference run (D33.6): a gated measurement without a network (D28.9).
 */
export function recordProblems(
  value: unknown,
  golden: {
    readonly manifest: GoldenManifest;
    readonly manifestSha256: string;
    readonly timestamps: readonly number[];
    readonly width: number;
    readonly height: number;
  },
  options: { readonly reference: boolean },
): string[] {
  const problems: string[] = [];
  const record = value as Partial<ParityRecord> | null;
  if (typeof record !== 'object' || record === null) return ['the record is not an object'];
  if (record.recordVersion !== 2) {
    return [`unsupported record version ${JSON.stringify(record.recordVersion)}; expected 2`];
  }
  if (record.method !== 'D33') problems.push('method is not D33');
  const { manifest } = golden;
  const environment = (record.environment ?? {}) as Readonly<Record<string, unknown>>;
  // Every field is present, and only `image` may be null (a run outside the container).
  const missing = [...PIXEL_ENVIRONMENT, 'network'].filter(
    (field) =>
      environment[field] === undefined || (environment[field] === null && field !== 'image'),
  );
  if (missing.length > 0) {
    problems.push(`the environment identity is incomplete: no ${missing.join(', ')}`);
  }

  // The gate (D34.3).
  const thresholds = record.thresholds as Partial<Thresholds> | null | undefined;
  if (record.gate === true) {
    if (thresholds === null || thresholds === undefined) {
      problems.push('gate=true without thresholds');
    } else {
      if (!count(thresholds.differingPixels) || !count(thresholds.maxChannelDifference)) {
        problems.push('thresholds are not non-negative integers');
      }
      if (!same(thresholds, PARITY_THRESHOLDS)) {
        problems.push(`thresholds ${JSON.stringify(thresholds)} are not those of D34.1`);
      }
    }
    for (const reason of gateEnvironmentProblems(environment, manifest.environment)) {
      problems.push(`gate=true on a cross-environment record: ${reason}`);
    }
  } else if (record.gate === false) {
    if (thresholds !== null) problems.push('a report-only record carries thresholds');
  } else {
    problems.push('gate is not a boolean');
  }

  const reference = record.reference;
  const expectedReference: RecordReference = {
    goldenManifest: 'packages/test-fixtures/src/golden-frames/reference.golden-frames.json',
    goldenManifestSha256: golden.manifestSha256,
    runtimeHash: manifest.render.runtime.contentHash,
    compositionHash: manifest.render.compositionHash,
    width: golden.width,
    height: golden.height,
  };
  if (!same(reference, expectedReference)) {
    problems.push(
      `reference is ${JSON.stringify(reference)}, expected ${JSON.stringify(expectedReference)}`,
    );
  }

  // The Player's dist tree (D33.10).
  const dist: readonly DistEntry[] = Array.isArray(record.playerDistManifest)
    ? (record.playerDistManifest as readonly DistEntry[])
    : [];
  const distShaped = dist.every(
    (entry) =>
      typeof entry.path === 'string' &&
      isDistPath(entry.path) &&
      count(entry.size) &&
      typeof entry.sha256 === 'string' &&
      HASH.test(entry.sha256) &&
      same(Object.keys(entry), ['path', 'size', 'sha256']),
  );
  const sorted = dist.every(
    (entry, at) => at === 0 || (dist[at - 1] as DistEntry).path < entry.path,
  );
  if (dist.length === 0 || !distShaped || !sorted) {
    problems.push('the Player dist manifest is not canonical');
  } else {
    if (!dist.some((entry) => entry.path === PLAYER_ENTRY)) {
      problems.push(`the Player dist manifest has no ${PLAYER_ENTRY}`);
    }
    if (record.playerDistTreeSha256 !== distTreeSha256(dist)) {
      problems.push('playerDistTreeSha256 is not the hash of the manifest');
    }
  }

  const rows: readonly ParityRow[] = Array.isArray(record.rows)
    ? (record.rows as readonly ParityRow[])
    : [];
  if (
    !same(
      rows.map((row) => row.timeUs),
      golden.timestamps,
    )
  ) {
    problems.push(
      `rows are ${JSON.stringify(rows.map((row) => row.timeUs))}, expected the golden timestamps in order`,
    );
  }
  const keys = [
    'timeUs',
    'frameIndex',
    'runtimeHash',
    'compositionHash',
    'width',
    'height',
    'playerPng',
    'goldenPng',
    'goldenFile',
    'differingPixels',
    'totalPixels',
    'share',
    'maxChannelDifference',
    'histogram',
  ];
  for (const row of rows) {
    const at = `row ${String(row.timeUs)}`;
    if (!same(Object.keys(row).sort(), [...keys].sort())) problems.push(`${at}: unexpected keys`);
    const frame = manifest.frames.find((candidate) => candidate.timeUs === row.timeUs);
    if (row.runtimeHash !== expectedReference.runtimeHash) problems.push(`${at}: runtime hash`);
    if (row.compositionHash !== expectedReference.compositionHash)
      problems.push(`${at}: composition hash`);
    if (frame === undefined || row.goldenPng !== frame.sha256)
      problems.push(`${at}: golden PNG hash`);
    if (
      frame === undefined ||
      row.goldenFile !== frame.file ||
      row.goldenFile !== goldenFileName(row.timeUs)
    ) {
      problems.push(`${at}: golden file`);
    }
    if (frame === undefined || row.frameIndex !== frame.index) problems.push(`${at}: frame index`);
    if (row.playerPng === row.goldenPng && row.differingPixels !== 0) {
      problems.push(`${at}: identical PNGs cannot differ in a pixel`);
    }
    if (typeof row.playerPng !== 'string' || !HASH.test(row.playerPng))
      problems.push(`${at}: Player PNG hash`);
    if (row.width !== golden.width || row.height !== golden.height)
      problems.push(`${at}: dimensions`);
    if (row.totalPixels !== golden.width * golden.height) problems.push(`${at}: totalPixels`);
    const numbers: [string, unknown][] = [
      ['differingPixels', row.differingPixels],
      ['totalPixels', row.totalPixels],
      ['maxChannelDifference', row.maxChannelDifference],
    ];
    for (const [name, number] of numbers) {
      if (!count(number)) problems.push(`${at}: ${name} is not a non-negative integer`);
    }
    if (
      typeof row.share !== 'number' ||
      !Number.isFinite(row.share) ||
      row.share < 0 ||
      row.share > 1
    ) {
      problems.push(`${at}: share is not a finite number in [0, 1]`);
    }
    const histogram = (row.histogram as Partial<Histogram> | undefined) ?? {};
    const counts = HISTOGRAM_BUCKETS.map((bucket) => histogram[bucket]);
    if (!same(Object.keys(histogram), [...HISTOGRAM_BUCKETS]) || !counts.every(count)) {
      problems.push(`${at}: histogram buckets`);
      continue;
    }
    const sum = (counts as number[]).reduce((total, value) => total + value, 0);
    if (sum !== row.totalPixels) problems.push(`${at}: the histogram sums to ${String(sum)}`);
    if (row.differingPixels !== row.totalPixels - (counts[0] as number)) {
      problems.push(`${at}: differingPixels disagrees with the histogram`);
    }
    if (row.share !== row.differingPixels / row.totalPixels)
      problems.push(`${at}: share is not the quotient`);
    let highest = -1;
    (counts as number[]).forEach((value, index) => {
      if (value > 0) highest = index;
    });
    if (
      !count(row.maxChannelDifference) ||
      row.maxChannelDifference > 255 ||
      bucketOf(row.maxChannelDifference) !== HISTOGRAM_BUCKETS[highest]
    ) {
      problems.push(`${at}: maxChannelDifference disagrees with the histogram`);
    }
    // The gate compares decoded pixels, never PNG bytes (D34.3).
    if (record.gate === true && thresholds !== null && thresholds !== undefined) {
      if (!(row.differingPixels <= (thresholds.differingPixels ?? -1))) {
        problems.push(
          `${at}: ${String(row.differingPixels)} differing pixels exceed the threshold`,
        );
      }
      if (!(row.maxChannelDifference <= (thresholds.maxChannelDifference ?? -1))) {
        problems.push(
          `${at}: a channel difference of ${String(row.maxChannelDifference)} exceeds the threshold`,
        );
      }
    }
  }
  if (rows.length > 0 && !same(record.worstCase, worstCase(rows))) {
    problems.push('worstCase is not the worst of the rows');
  }
  if (options.reference) {
    if (record.gate !== true) problems.push('the committed record is not a gated measurement');
    const network = environment.network as { loopbackOnly?: unknown } | undefined;
    if (network?.loopbackOnly !== true) problems.push('the network was not loopback only (D28.9)');
  }
  return problems;
}

// --- the report's table (D33.6) -------------------------------------------

function percent(share: number): string {
  return `${(share * 100).toFixed(4)} %`;
}

/** The header of the report's table; its rows are `reportRows`. */
export const REPORT_HEADER = [
  '`timeUs`',
  'Frame',
  'Differing pixels',
  'Share',
  'Max channel difference',
  'Histogram 0 / 1 / 2-3 / 4-7 / 8-15 / 16-31 / 32-63 / 64-127 / 128-255',
] as const;

/**
 * The cells of the table in `docs/spike/report.md`, formatted from a record.
 * `check` compares the report's cells with these as strings (Prettier aligns
 * the columns, so the cells are compared, not the lines), and the prose cannot
 * keep stale numbers.
 */
export function reportRows(record: ParityRecord): string[][] {
  return record.rows.map((row) => [
    String(row.timeUs),
    String(row.frameIndex),
    `${String(row.differingPixels)} / ${String(row.totalPixels)}`,
    percent(row.share),
    String(row.maxChannelDifference),
    HISTOGRAM_BUCKETS.map((bucket) => String(row.histogram[bucket])).join(' / '),
  ]);
}

/** The sentence under the table. */
export function reportWorstCase(record: ParityRecord): string {
  const { differingPixels, share, maxChannelDifference } = record.worstCase;
  return `Worst case: ${String(differingPixels.value)} differing pixels (at ${String(differingPixels.timeUs)} µs), share ${percent(share.value)} (at ${String(share.timeUs)} µs), maximum channel difference ${String(maxChannelDifference.value)} (at ${String(maxChannelDifference.timeUs)} µs).`;
}

/** The table's cells as Markdown lines (for writing the report; Prettier aligns them). */
export function reportTable(record: ParityRecord): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [
    line(REPORT_HEADER),
    line(REPORT_HEADER.map((_, index) => (index === 0 ? ':--' : '--:'))),
    ...reportRows(record).map(line),
  ].join('\n');
}

/**
 * The table between `<!-- parity-table:start -->` and `<!-- parity-table:end -->`
 * of a Markdown text, as trimmed cells, header and delimiter row removed.
 */
export function tableIn(markdown: string): string[][] | null {
  const found = /<!-- parity-table:start -->\n([\s\S]*?)\n<!-- parity-table:end -->/.exec(markdown);
  if (found?.[1] === undefined) return null;
  const lines = found[1]
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text.startsWith('|'));
  return lines.slice(2).map((text) =>
    text
      .slice(1, text.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim()),
  );
}
