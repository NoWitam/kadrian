/**
 * `kadrion render-frames` (D28.8) and `kadrion export` (D29.10) with injected
 * Producer functions: arguments, the asset map and its relative paths, the
 * files written, where FFmpeg comes from, and the exit codes. That the default
 * functions render and encode is `tests/pinned`'s business.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProducerError,
  type ExportRequest,
  type ExportResult,
  type RenderRequest,
  type RenderResult,
} from '@kadrion/producer';
import { generateReferenceAssets, referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import {
  EXIT_OK,
  EXIT_PRODUCER_ERROR,
  EXIT_USAGE,
  frameFileName,
  parseAssetMap,
  parseTimes,
  runCli,
  USAGE,
} from '../src/index.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
  };
}

/** A directory with the reference composition, its generated assets, and an asset map. */
function workspace(): { dir: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'kadrion-cli-'));
  writeFileSync(join(dir, 'composition.json'), JSON.stringify(referenceComposition));
  const map: Record<string, { path: string; mediaType: string }> = {};
  for (const asset of generateReferenceAssets()) {
    writeFileSync(join(dir, `${asset.id}.bin`), asset.bytes);
    map[asset.id] = { path: `${asset.id}.bin`, mediaType: asset.mediaType };
  }
  writeFileSync(join(dir, 'assets.json'), JSON.stringify(map));
  return {
    dir,
    args: [
      'render-frames',
      '--composition',
      join(dir, 'composition.json'),
      '--assets',
      join(dir, 'assets.json'),
      '--out',
      join(dir, 'out'),
      '--times',
      '0,2500000',
    ],
  };
}

/** Resolves every asset like the Producer and returns one fake PNG per time. */
function fakeRender(seen: RenderRequest[]) {
  return async (request: RenderRequest): Promise<RenderResult> => {
    seen.push(request);
    for (const id of ['asset-image', 'asset-audio', 'asset-font']) {
      await request.resolveAsset({ id, type: 'image', contentHash: 'sha256:x' });
    }
    const frames = request.timesUs.map((timeUs) => ({
      index: Math.round((timeUs * 30) / 1_000_000),
      timeUs,
      png: Uint8Array.of(137, 80, 78, 71),
    }));
    return {
      frames,
      manifest: {
        runtime: { contentHash: 'sha256:runtime' },
        frames: frames.map(({ index, timeUs }) => ({
          index,
          timeUs,
          sha256: `sha256:${String(index)}`,
        })),
      } as unknown as RenderResult['manifest'],
    };
  };
}

describe('kadrion render-frames (D28.8)', () => {
  it('passes the document and the times through, and resolves assets from paths relative to the map', async () => {
    const { dir, args } = workspace();
    const seen: RenderRequest[] = [];
    const { out, io: streams } = io();
    await expect(runCli(args, streams, { render: fakeRender(seen) })).resolves.toBe(EXIT_OK);
    expect(seen[0]?.document).toEqual(referenceComposition);
    expect(seen[0]?.timesUs).toEqual([0, 2_500_000]);
    const font = await seen[0]?.resolveAsset({ id: 'asset-font', type: 'font', contentHash: 'x' });
    expect(font?.mediaType).toBe('font/ttf');
    expect(
      Buffer.from(font?.bytes ?? []).equals(Buffer.from(generateReferenceAssets()[2]?.bytes ?? [])),
    ).toBe(true);
    await expect(
      seen[0]?.resolveAsset({ id: 'asset-other', type: 'image', contentHash: 'x' }),
    ).resolves.toBeNull();
    expect(readdirSync(join(dir, 'out')).sort()).toEqual([
      'frame-000000.png',
      'frame-000075.png',
      'render-manifest.json',
    ]);
    const manifest = JSON.parse(readFileSync(join(dir, 'out', 'render-manifest.json'), 'utf8')) as {
      runtime: { contentHash: string };
    };
    expect(manifest.runtime.contentHash).toBe('sha256:runtime');
    expect(out).toContain('frame-000075.png 2500000 sha256:75');
  });

  it('exits 1 with the code of a ProducerError', async () => {
    const { args } = workspace();
    const { err, io: streams } = io();
    const failing = () => Promise.reject(new ProducerError('asset-hash-mismatch', 'wrong bytes'));
    await expect(runCli(args, streams, { render: failing })).resolves.toBe(EXIT_PRODUCER_ERROR);
    expect(err).toEqual(['error asset-hash-mismatch: wrong bytes']);
  });

  it.each([
    ['no command', []],
    ['another command', ['render']],
    ['a missing option', ['render-frames', '--times', '0']],
    ['an unknown option', ['render-frames', '--golden']],
    ['a positional argument', ['render-frames', 'extra']],
  ])('exits 2 for %s and prints the usage', async (_, args) => {
    const { err, io: streams } = io();
    await expect(runCli(args, streams, { render: never, exportMp4: never })).resolves.toBe(
      EXIT_USAGE,
    );
    expect(err).toContain(USAGE);
  });

  it('exits 2 for unreadable files and malformed times, before rendering', async () => {
    const { args } = workspace();
    const withValue = (option: string, value: string) => {
      const copy = [...args];
      copy[copy.indexOf(option) + 1] = value;
      return copy;
    };
    for (const variant of [
      withValue('--composition', 'missing.json'),
      withValue('--assets', 'missing.json'),
      withValue('--times', '0,,1'),
      withValue('--times', '2.5'),
    ]) {
      await expect(runCli(variant, io().io, { render: never })).resolves.toBe(EXIT_USAGE);
    }
  });
});

/** The export's arguments for the workspace of `workspace()`. */
function exportArgs(dir: string, ...extra: string[]): string[] {
  return [
    'export',
    '--composition',
    join(dir, 'composition.json'),
    '--assets',
    join(dir, 'assets.json'),
    '--out',
    join(dir, 'out'),
    '--preset',
    '720p',
    ...extra,
  ];
}

/** Resolves the audio like the Producer and writes a fake MP4 where it was asked to. */
function fakeExport(seen: ExportRequest[]) {
  return async (request: ExportRequest): Promise<ExportResult> => {
    seen.push(request);
    await request.resolveAsset({ id: 'asset-audio', type: 'audio', contentHash: 'x' });
    writeFileSync(request.outputPath, 'mp4');
    return {
      outputPath: request.outputPath,
      stats: { framesWritten: 300, maxFramesInFlight: 2 },
      manifest: {
        runtime: { contentHash: 'sha256:runtime' },
        frames: new Array(300).fill({}),
        preset: { name: 'mp4-720p' },
        ffmpeg: { version: 'n8.1.3-20260921' },
      } as unknown as ExportResult['manifest'],
    };
  };
}

const never = () => Promise.reject(new Error('must not run'));

describe('kadrion export (D29.10)', () => {
  it('passes the document, the preset, the output path, and the flags through, and writes the manifest', async () => {
    const { dir } = workspace();
    const seen: ExportRequest[] = [];
    const { out, io: streams } = io();
    const args = exportArgs(dir, '--ffmpeg', '/opt/f/ffmpeg', '--ffprobe', '/opt/f/ffprobe');
    await expect(
      runCli(args, streams, { exportMp4: fakeExport(seen), render: never, env: {} }),
    ).resolves.toBe(EXIT_OK);
    expect(seen[0]?.document).toEqual(referenceComposition);
    expect(seen[0]?.preset).toBe('720p');
    expect(seen[0]?.outputPath).toBe(join(dir, 'out', 'video-720p.mp4'));
    expect(seen[0]?.ffmpeg).toEqual({ ffmpegPath: '/opt/f/ffmpeg', ffprobePath: '/opt/f/ffprobe' });
    const audio = await seen[0]?.resolveAsset({
      id: 'asset-audio',
      type: 'audio',
      contentHash: 'x',
    });
    expect(audio?.mediaType).toBe('audio/wav');
    expect(readdirSync(join(dir, 'out')).sort()).toEqual([
      'video-720p.mp4',
      'video-720p.render-manifest.json',
    ]);
    expect(out).toEqual([
      'video-720p.mp4 300 frames mp4-720p ffmpeg n8.1.3-20260921',
      'video-720p.render-manifest.json runtime sha256:runtime',
    ]);
  });

  it('takes the executables from KADRION_FFMPEG and KADRION_FFPROBE, and the flags first', async () => {
    const { dir } = workspace();
    const seen: ExportRequest[] = [];
    const env = {
      KADRION_FFMPEG: '/env/ffmpeg',
      KADRION_FFPROBE: '/env/ffprobe',
      PATH: '/usr/bin',
    };
    await runCli(exportArgs(dir), io().io, { exportMp4: fakeExport(seen), env });
    await runCli(exportArgs(dir, '--ffprobe', '/flag/ffprobe'), io().io, {
      exportMp4: fakeExport(seen),
      env,
    });
    expect(seen.map(({ ffmpeg }) => ffmpeg)).toEqual([
      { ffmpegPath: '/env/ffmpeg', ffprobePath: '/env/ffprobe' },
      { ffmpegPath: '/env/ffmpeg', ffprobePath: '/flag/ffprobe' },
    ]);
  });

  it('exits 1 with ffmpeg-missing, before exporting, when neither flag nor variable names FFmpeg', async () => {
    const { dir } = workspace();
    const { err, io: streams } = io();
    await expect(
      runCli(exportArgs(dir, '--ffmpeg', '/opt/f/ffmpeg'), streams, {
        exportMp4: never,
        env: { PATH: '/usr/bin:/usr/local/bin' },
      }),
    ).resolves.toBe(EXIT_PRODUCER_ERROR);
    expect(err.join('\n')).toMatch(/^error ffmpeg-missing: .*PATH is never searched/);
  });

  it('exits 1 with the code of a ProducerError of the export', async () => {
    const { dir } = workspace();
    const { err, io: streams } = io();
    const failing = () =>
      Promise.reject(new ProducerError('encode-failed', 'FFmpeg exited with 1'));
    await expect(
      runCli(exportArgs(dir), streams, {
        exportMp4: failing,
        env: { KADRION_FFMPEG: '/f', KADRION_FFPROBE: '/p' },
      }),
    ).resolves.toBe(EXIT_PRODUCER_ERROR);
    expect(err).toEqual(['error encode-failed: FFmpeg exited with 1']);
  });

  it.each([
    ['a missing preset', ['export', '--composition', 'c', '--assets', 'a', '--out', 'o']],
    [
      'a preset that could name a path',
      ['export', '--composition', 'c', '--assets', 'a', '--out', 'o', '--preset', '../x'],
    ],
    ['an unknown option', ['export', '--frames']],
  ])('exits 2 for %s', async (_, args) => {
    const { err, io: streams } = io();
    await expect(runCli(args, streams, { exportMp4: never, env: {} })).resolves.toBe(EXIT_USAGE);
    expect(err).toContain(USAGE);
  });
});

describe('the parts of the CLI', () => {
  it('parses integer times in order', () => {
    expect(parseTimes('9900000,0')).toEqual([9_900_000, 0]);
    for (const text of ['', '-1', '1e6', ' 0', '0x10']) expect(() => parseTimes(text)).toThrow();
  });

  it('accepts an asset map of { path, mediaType } entries only', () => {
    expect([...parseAssetMap('{"a":{"path":"a.png","mediaType":"image/png"}}')]).toEqual([
      ['a', { path: 'a.png', mediaType: 'image/png' }],
    ]);
    for (const text of [
      '[]',
      'null',
      '{"a":{"path":"a.png"}}',
      '{"a":{"path":"","mediaType":"x"}}',
      '{"a":{"path":"a","mediaType":"x","extra":1}}',
      'nope',
    ]) {
      expect(() => parseAssetMap(text), text).toThrow();
    }
  });

  it('names frames with six digits', () => {
    expect([frameFileName(0), frameFileName(297)]).toEqual([
      'frame-000000.png',
      'frame-000297.png',
    ]);
  });
});
