/**
 * The committed parity record of the reference run (D33.6, D34.3) and the
 * spike report that quotes it. `check` cannot prove where a PNG hash came from
 * — the pinned test proves that — but it does prove that the record is a gated,
 * complete measurement against the golden frames and the environment that are
 * committed now, that it is current with the build (the runtime artifact, the
 * reference document, and the Player's dist tree), and that the report's
 * numbers are the record's numbers.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { canonicalJson } from '@kadrion/producer';
import { goldenTimestamps, referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import {
  distManifest,
  recordProblems,
  reportRows,
  reportWorstCase,
  servedDist,
  tableIn,
  type GoldenManifest,
  type ParityRecord,
} from '../parity/parity.js';

import { readJson, readText, repoPath } from './repo.js';

const RECORD = repoPath('docs', 'spike', 'parity-measurement.json');
const MANIFEST = [
  'packages',
  'test-fixtures',
  'src',
  'golden-frames',
  'reference.golden-frames.json',
];

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const manifest = readJson(...MANIFEST) as GoldenManifest;
const golden = {
  manifest,
  manifestSha256: sha256(readFileSync(repoPath(...MANIFEST))),
  timestamps: goldenTimestamps.map(({ timeUs }) => timeUs),
  width: 1080,
  height: 1920,
};

describe('the committed parity record (D33.6, D34.3)', () => {
  it('exists: the reference run measured parity', () => {
    expect(
      existsSync(RECORD),
      'Copy /out/parity-measurement-1.json of "pinned-run.sh reference" to docs/spike/.',
    ).toBe(true);
  });

  const record = readJson('docs', 'spike', 'parity-measurement.json') as ParityRecord;

  it('is a complete, gated measurement against the committed golden frames in their environment, without a network', () => {
    expect(recordProblems(record, golden, { reference: true })).toEqual([]);
    expect(record.gate).toBe(true);
  });

  it('is current with the runtime artifact and the reference document of this build', () => {
    const runtime = JSON.parse(
      readText('packages', 'renderer-dom', 'dist', 'runtime-build', 'kadrion-runtime.json'),
    ) as { contentHash: string };
    expect(record.reference.runtimeHash).toBe(runtime.contentHash);
    expect(record.reference.compositionHash).toBe(sha256(canonicalJson(referenceComposition)));
  });

  it("is current with the Player's dist tree of this build, file for file (D33.10)", () => {
    // Missing dist fails here: `check` builds before it tests.
    const current = distManifest(
      servedDist((path) => new Uint8Array(readFileSync(repoPath(...path.split('/'))))),
    );
    expect(record.playerDistManifest).toEqual(current);
  });
});

describe('the spike report (D33.6)', () => {
  const report = readText('docs', 'spike', 'report.md');
  const record = readJson('docs', 'spike', 'parity-measurement.json') as ParityRecord;
  const environment = record.environment as Readonly<Record<string, unknown>>;

  it("quotes the record's rows cell for cell and its worst case word for word", () => {
    expect(tableIn(report)).toEqual(reportRows(record));
    expect(report).toContain(reportWorstCase(record));
  });

  it('names the runtime build, the document, the Player dist tree, the image, and the browser of the record', () => {
    for (const value of [
      record.reference.runtimeHash,
      record.reference.compositionHash,
      record.playerDistTreeSha256,
      environment.image,
      environment.reportedVersion,
    ]) {
      expect(typeof value === 'string' && report.includes(value), String(value)).toBe(true);
    }
  });

  it('points at the method and the thresholds that gate the record', () => {
    expect(record.thresholds).toEqual({ differingPixels: 0, maxChannelDifference: 0 });
    expect(report).toContain('../adr/D33-parity-measurement.md');
    expect(report).toContain('../adr/D34-parity-thresholds.md');
  });
});
