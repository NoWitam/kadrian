/**
 * The parity measurement of D33 in Chromium: the public `@kadrion/player` in
 * the conformance host against the committed golden frames of the Producer
 * (§6.2). The premise comes first and runs through the same capture as the
 * rows; the rows are refused rather than computed when a runtime build, a
 * document, a time, or a size does not match; the record is written as data and
 * checked for completeness. No threshold is applied (D33.8). Informative
 * outside the pinned environment (D33.9).
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  captureFrame,
  launchChromium,
  PINNED_IMAGE,
  PINNED_IMAGE_VARIABLE,
  renderFrames,
  type LaunchedChromium,
} from '@kadrion/producer';
import { timeUsToFrame, validateComposition } from '@kadrion/schema';
import {
  generateReferenceAssets,
  goldenTimestamps,
  referenceComposition,
} from '@kadrion/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  compareFrame,
  decodePng,
  distManifest,
  measure,
  ParityRefusal,
  parityMode,
  parityRecord,
  recordProblems,
  servedDist,
  sha256,
  type GoldenFrame,
  type GoldenManifest,
  type ParityRow,
  type Pixels,
  type PlayerFrame,
} from '../parity/parity.js';

import {
  closeConformanceHost,
  HOST_PACKAGES,
  HOST_PAGE,
  HOST_SCRIPT,
  openConformanceHost,
  seekAndCapture,
  type CapturedFrame,
  type ConformanceHost,
} from './conformance-host.js';
import {
  expectedBar,
  expectedTree,
  GOLDEN_MANIFEST,
  HEIGHT,
  OUTPUT_DIRECTORY,
  pinnedRun,
  readGoldens,
  referenceResolver,
  repoRoot,
  variant,
  WIDTH,
  writeReport,
} from './support.js';

const RECORD = join('parity', 'parity-measurement.json');
const FAILED_RECORD = join('parity', 'parity-measurement.failed.json');
const times = goldenTimestamps.map(({ timeUs }) => timeUs);
const assets = generateReferenceAssets();
const referenceText = JSON.stringify(referenceComposition);
const validatedReference = validateComposition(referenceComposition);
if (!validatedReference.ok) throw new Error('The reference composition is not valid.');
const { fps } = validatedReference.composition;

let chromium: LaunchedChromium;
let host: ConformanceHost;
let golden: { manifest: GoldenManifest; manifestSha256: string; frames: Map<number, Uint8Array> };

function goldenFrame(timeUs: number): GoldenFrame {
  const entry = golden.manifest.frames.find((frame) => frame.timeUs === timeUs);
  const png = golden.frames.get(timeUs);
  if (entry === undefined || png === undefined)
    throw new Error(`No golden frame of ${String(timeUs)}.`);
  return {
    png,
    file: entry.file,
    timeUs: entry.timeUs,
    index: entry.index,
    sha256: entry.sha256,
    runtimeHash: golden.manifest.render.runtime.contentHash,
    compositionHash: golden.manifest.render.compositionHash,
  };
}

function playerFrame(captured: CapturedFrame, target: ConformanceHost = host): PlayerFrame {
  return { ...captured, compositionHash: target.compositionHash };
}

function expected(timeUs: number): { width: number; height: number; frameIndex: number } {
  return { width: WIDTH, height: HEIGHT, frameIndex: timeUsToFrame(timeUs, fps) };
}

function refusalOf(action: () => unknown): string {
  try {
    action();
  } catch (reason) {
    if (reason instanceof ParityRefusal) return reason.code;
    throw reason;
  }
  return 'none';
}

beforeAll(async () => {
  // A record of an earlier run must never be taken for this one (D33.5).
  rmSync(join(OUTPUT_DIRECTORY, 'parity'), { recursive: true, force: true });
  const goldens = readGoldens();
  if (goldens === null) throw new Error('The measurement needs the committed golden frames.');
  golden = {
    manifest: goldens.manifest,
    manifestSha256: sha256(readFileSync(GOLDEN_MANIFEST)),
    frames: goldens.frames,
  };
  chromium = await launchChromium();
  host = await openConformanceHost(chromium, referenceText, assets);
});

afterAll(async () => {
  await closeConformanceHost(host);
  await chromium.browser.close();
});

describe('the conformance host (D33.2)', () => {
  it('imports only @kadrion/player and serves only its build and the runtime', () => {
    const imports = [...HOST_SCRIPT.matchAll(/\bimport\b[\s\S]*?from\s*'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(['@kadrion/player']);
    expect(HOST_SCRIPT).not.toMatch(/\bimport\s*\(/);
    expect(HOST_PAGE).not.toContain('test-fixtures');
    expect(HOST_PAGE).not.toMatch(/scale\(|zoom|transform/);
    expect(host.refused).toEqual([]);
    const packages = new Set(
      host.servedPaths.flatMap((path) => /^\/pkg\/([a-z-]+)\//.exec(path)?.[1] ?? []),
    );
    expect(packages.has('player')).toBe(true);
    for (const name of packages) expect(HOST_PACKAGES).toContain(name);
    expect(host.servedPaths).toContain('/runtime/kadrion-runtime.js');
  });

  it('loaded the reference document, hashed from the text the page returned', () => {
    expect(host.compositionHash).toBe(golden.manifest.render.compositionHash);
    expect({ width: host.width, height: host.height }).toEqual({ width: WIDTH, height: HEIGHT });
  });
});

describe('the premise: the measurement sees a difference on real frames (D33.7)', () => {
  it('between the golden frame and the Player one grid frame later', async () => {
    const at = 2_500_000;
    const next = 2_533_333;
    expect(timeUsToFrame(next, fps)).toBe(timeUsToFrame(at, fps) + 1);
    // The Custom HTML bar grows on every frame, so the two frames must differ.
    expect(Math.round(expectedBar(next))).not.toBe(Math.round(expectedBar(at)));
    const later = await seekAndCapture(host, next, null);
    expect(later.timeUs).toBe(next);
    expect(
      measure(decodePng(later.png), decodePng(goldenFrame(at).png)).differingPixels,
    ).toBeGreaterThan(0);
    expect(refusalOf(() => compareFrame(expected(at), playerFrame(later), goldenFrame(at)))).toBe(
      'time-mismatch',
    );
  });

  it('between two golden timestamps whose hand-derived trees differ', async () => {
    expect(JSON.stringify(expectedTree(5_000_000))).not.toBe(
      JSON.stringify(expectedTree(2_500_000)),
    );
    const shown = await seekAndCapture(host, 5_000_000);
    expect(
      measure(decodePng(shown.png), decodePng(goldenFrame(2_500_000).png)).differingPixels,
    ).toBeGreaterThan(0);
  });

  it('between a golden frame and itself shifted by one pixel column', () => {
    const image = decodePng(goldenFrame(5_000_000).png);
    const shifted = new Uint8Array(image.data.length);
    for (let y = 0; y < image.height; y += 1) {
      const row = y * image.width * 4;
      shifted.set(image.data.subarray(row, row + (image.width - 1) * 4), row + 4);
      shifted.set(image.data.subarray(row, row + 4), row);
    }
    const moved: Pixels = { ...image, data: shifted };
    expect(measure(image, moved).differingPixels).toBeGreaterThan(0);
  });

  it('between the reference and a document that moves one node, which is also refused', async () => {
    const moved = variant((draft) => {
      const title = draft.scenes[0]?.nodes.find((node) => node.id === 'node-title');
      if (title === undefined) throw new Error('No title node.');
      title.position = { x: 300, y: 400 };
    });
    const other = await openConformanceHost(chromium, JSON.stringify(moved.document), assets);
    try {
      expect(other.compositionHash).not.toBe(golden.manifest.render.compositionHash);
      const shown = await seekAndCapture(other, 0, null);
      expect(
        refusalOf(() => compareFrame(expected(0), playerFrame(shown, other), goldenFrame(0))),
      ).toBe('document-mismatch');
      expect(
        measure(decodePng(shown.png), decodePng(goldenFrame(0).png)).differingPixels,
      ).toBeGreaterThan(0);
    } finally {
      await closeConformanceHost(other);
    }
  });
});

describe('refusals on real inputs (D33.3)', () => {
  it('refuses golden frames of another runtime build', async () => {
    const shown = await seekAndCapture(host, 0);
    const foreign = { ...goldenFrame(0), runtimeHash: sha256('another build') };
    expect(refusalOf(() => compareFrame(expected(0), playerFrame(shown), foreign))).toBe(
      'runtime-mismatch',
    );
  });

  it('refuses a capture of another size instead of cropping or scaling it', async () => {
    const shown = await seekAndCapture(host, 0);
    const shorter = await captureFrame(host.page, WIDTH, HEIGHT - 1);
    expect(
      refusalOf(() =>
        compareFrame(expected(0), { ...playerFrame(shown), png: shorter }, goldenFrame(0)),
      ),
    ).toBe('dimension-mismatch');
  });
});

describe('the equality gate of D28.5 within one run and one browser binary', () => {
  it('the Player and the Producer of this run differ in zero pixels', async () => {
    // Not a threshold (D33.8): both hosts run the same build in the same embedding,
    // measured the same way, so any difference is a bug. It does not use goldens.
    const producer = await renderFrames({
      document: referenceComposition,
      resolveAsset: referenceResolver,
      timesUs: times,
      chromium,
    });
    for (const timeUs of times) {
      const shown = await seekAndCapture(host, timeUs);
      const reference = producer.frames.find((frame) => frame.timeUs === timeUs)?.png;
      if (reference === undefined) throw new Error(`No Producer frame of ${String(timeUs)}.`);
      expect(shown.runtimeHash).toBe(producer.manifest.runtime.contentHash);
      expect(host.compositionHash).toBe(producer.manifest.compositionHash);
      expect(
        measure(decodePng(shown.png), decodePng(reference)).differingPixels,
        String(timeUs),
      ).toBe(0);
    }
  });
});

describe('parity against the committed golden frames (§6.2, D33, D34)', () => {
  it('measures every golden timestamp, gates in the pinned environment, and writes a complete record', async () => {
    const rows: ParityRow[] = [];
    for (const timeUs of times) {
      const shown = await seekAndCapture(host, timeUs);
      rows.push(compareFrame(expected(timeUs), playerFrame(shown), goldenFrame(timeUs)));
    }
    // The Player's dist tree (D33.10), taken after the last seek: the host served
    // exactly the static import closure of @kadrion/player, byte for byte.
    const onDisk = servedDist((path) => new Uint8Array(readFileSync(join(repoRoot, path))));
    expect([...host.servedFiles.keys()].sort()).toEqual([...onDisk.keys()].sort());
    for (const [path, bytes] of onDisk) {
      expect(Buffer.from(host.servedFiles.get(path) ?? []).equals(bytes), path).toBe(true);
    }
    const environment = pinnedRun(chromium);
    // Three cases (D34.3): without the variable, report only. With it, it must name
    // the pinned image, the environment must be the golden frames' one, and the
    // gate applies; a run with the variable never falls back to a report.
    const gate =
      parityMode(
        process.env[PINNED_IMAGE_VARIABLE],
        PINNED_IMAGE,
        environment,
        golden.manifest.environment,
      ) === 'gate';
    const record = parityRecord(
      environment,
      {
        goldenManifest: 'packages/test-fixtures/src/golden-frames/reference.golden-frames.json',
        goldenManifestSha256: golden.manifestSha256,
        runtimeHash: golden.manifest.render.runtime.contentHash,
        compositionHash: golden.manifest.render.compositionHash,
        width: WIDTH,
        height: HEIGHT,
      },
      rows,
      { gate, playerDist: distManifest(host.servedFiles) },
    );
    const problems = recordProblems(
      JSON.parse(JSON.stringify(record)),
      {
        manifest: golden.manifest,
        manifestSha256: golden.manifestSha256,
        timestamps: times,
        width: WIDTH,
        height: HEIGHT,
      },
      { reference: false },
    );
    // A record that fails its own checks is kept for diagnosis, but never under the
    // name of a good record, which pinned-run.sh and CI copy out.
    const file = writeReport(problems.length === 0 ? RECORD : FAILED_RECORD, record);
    console.info(`Parity record (${gate ? 'gated' : 'report only'}): ${file}`);
    console.info(JSON.stringify(record.worstCase));
    expect(problems).toEqual([]);
    if (gate) {
      // D34.1, stated here as literals rather than read from the record.
      for (const row of rows) {
        expect(row.differingPixels, String(row.timeUs)).toBe(0);
        expect(row.maxChannelDifference, String(row.timeUs)).toBe(0);
      }
    }
  });
});
