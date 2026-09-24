/**
 * The MP4 export of D29 (specification §5 P5) with the pinned FFmpeg. It needs
 * `KADRION_FFMPEG` and `KADRION_FFPROBE`, the verified binaries of
 * `node --run ffmpeg:fetch`: required in the pinned environment, and skipped
 * with a message elsewhere, because the pinned build runs on linux/x64 only.
 * Structure is checked with `ffprobe`; pixels are compared on the pre-encode
 * frames only, and the decoded video is reported, never asserted (P5). The
 * expectations are written out from D29, not taken from the implementation.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  exportMp4,
  launchChromium,
  networkFacts,
  PINNED_IMAGE,
  PINNED_IMAGE_VARIABLE,
  renderFrames,
  type ExportResult,
  type LaunchedChromium,
  type RenderResult,
} from '@kadrion/producer';
import { goldenTimestamps } from '@kadrion/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  customHtmlNode,
  decodePng,
  OUTPUT_DIRECTORY,
  readGoldens,
  referenceResolver,
  variant,
  writeReport,
  type Pixels,
} from './support.js';

const run = promisify(execFile);
const ffmpegPath = process.env.KADRION_FFMPEG;
const ffprobePath = process.env.KADRION_FFPROBE;
const available = ffmpegPath !== undefined && ffprobePath !== undefined;
const pinned = process.env[PINNED_IMAGE_VARIABLE] === PINNED_IMAGE;
const FFMPEG = { ffmpegPath: ffmpegPath ?? '', ffprobePath: ffprobePath ?? '' };
const EXPORTS = join(OUTPUT_DIRECTORY, 'exports');
const report: Record<string, unknown> = {};

describe('the pinned FFmpeg for the export (D29.1)', () => {
  it('is given wherever the run is pinned, and its absence is stated elsewhere', () => {
    if (pinned) expect(available).toBe(true);
    if (!available) {
      console.info(
        'The export tests are skipped: KADRION_FFMPEG and KADRION_FFPROBE are not set. P5 is not proven by this run.',
      );
    }
  });
});

interface Stream {
  readonly codec_type: string;
  readonly codec_name: string;
  readonly profile?: string;
  readonly level?: number;
  readonly width?: number;
  readonly height?: number;
  readonly pix_fmt?: string;
  readonly sample_aspect_ratio?: string;
  readonly r_frame_rate: string;
  readonly avg_frame_rate: string;
  readonly time_base: string;
  readonly start_pts?: number;
  readonly duration_ts?: number;
  readonly nb_read_frames?: string;
  readonly color_range?: string;
  readonly color_space?: string;
  readonly color_transfer?: string;
  readonly color_primaries?: string;
  readonly sample_rate?: string;
  readonly channels?: number;
  readonly channel_layout?: string;
}

interface Probe {
  readonly streams: readonly Stream[];
  readonly format: {
    readonly format_name: string;
    readonly duration: string;
    readonly tags?: Record<string, string>;
  };
}

async function probe(file: string): Promise<Probe> {
  const { stdout } = await run(
    ffprobePath ?? '',
    ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as Probe;
}

/** The presentation time of every video frame, in the stream's time base. */
async function videoTimestamps(file: string): Promise<number[]> {
  const { stdout } = await run(
    ffprobePath ?? '',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts', '-of', 'csv=p=0', file],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  // The first frame carries side data, which csv output writes as one more, empty field.
  return stdout
    .trim()
    .split('\n')
    .map((line) => Number(line.split(',')[0]?.trim()));
}

/** The audio, decoded by the pinned FFmpeg to mono signed 16-bit samples at 48 kHz. */
async function decodedAudio(file: string): Promise<Int16Array> {
  const { stdout } = await run(
    ffmpegPath ?? '',
    ['-v', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const bytes = stdout as unknown as Buffer;
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

/** The source tone of the audio fixture, written out again: a 480 Hz triangle of 100 samples. */
function source(index: number): number {
  const phase = index % 100;
  return phase < 50 ? -8000 + 320 * phase : 8000 - 320 * (phase - 50);
}

/** Decoded RGB frames of the MP4 at the given indices (report only, P5). */
async function decodedFrames(file: string, indices: readonly number[]): Promise<Pixels[]> {
  const select = indices.map((index) => `eq(n\\,${String(index)})`).join('+');
  const { stdout } = await run(
    ffmpegPath ?? '',
    ['-v', 'error', '-i', file, '-vf', `select=${select}`, '-fps_mode', 'passthrough'].concat([
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ]),
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  const bytes = stdout as unknown as Buffer;
  const size = 1080 * 1920 * 3;
  return indices.map((_, position) => {
    const rgb = bytes.subarray(position * size, (position + 1) * size);
    const data = new Uint8Array(1080 * 1920 * 4);
    for (let pixel = 0; pixel < 1080 * 1920; pixel += 1) {
      data[pixel * 4] = rgb[pixel * 3] ?? 0;
      data[pixel * 4 + 1] = rgb[pixel * 3 + 1] ?? 0;
      data[pixel * 4 + 2] = rgb[pixel * 3 + 2] ?? 0;
      data[pixel * 4 + 3] = 255;
    }
    return { width: 1080, height: 1920, data };
  });
}

function psnr(a: Pixels, b: Pixels): number {
  let squared = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = (a.data[index + channel] ?? 0) - (b.data[index + channel] ?? 0);
      squared += delta * delta;
    }
  }
  const mse = squared / ((a.data.length / 4) * 3);
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}

/** Files anywhere below `directory`, a few levels deep, that look like frames. */
function frameLikeFiles(directory: string, depth = 3): string[] {
  if (depth < 0 || !existsSync(directory)) return [];
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  for (const name of entries) {
    const path = join(directory, name);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) found.push(...frameLikeFiles(path, depth - 1));
    else if (/\.(png|bmp|ppm|rgb|rgba|raw|yuv|y4m)$/i.test(name)) found.push(path);
  }
  return found;
}

describe.skipIf(!available)('the MP4 export with the pinned FFmpeg (D29, P5)', () => {
  let chromium: LaunchedChromium;
  let reference: RenderResult;
  let full: ExportResult;
  let small: ExportResult;
  const watched: string[] = [];
  const watchedDirectories = [EXPORTS, tmpdir(), '/dev/shm'];

  beforeAll(async () => {
    chromium = await launchChromium();
    rmSync(EXPORTS, { recursive: true, force: true });
    mkdirSync(EXPORTS, { recursive: true });
    const before = new Set(watchedDirectories.flatMap((directory) => frameLikeFiles(directory)));
    const outputs = new Set<string>();
    const watch = setInterval(() => {
      for (const directory of watchedDirectories) {
        for (const file of frameLikeFiles(directory)) if (!before.has(file)) outputs.add(file);
      }
      for (const name of existsSync(EXPORTS) ? readdirSync(EXPORTS) : []) {
        if (!/^video-(1080p|720p)\.mp4$/.test(name)) outputs.add(join(EXPORTS, name));
      }
    }, 25);
    try {
      full = await exportMp4({
        document: variant(() => undefined).document,
        resolveAsset: referenceResolver,
        preset: '1080p',
        outputPath: join(EXPORTS, 'video-1080p.mp4'),
        ffmpeg: FFMPEG,
        chromium,
      });
      small = await exportMp4({
        document: variant(() => undefined).document,
        resolveAsset: referenceResolver,
        preset: '720p',
        outputPath: join(EXPORTS, 'video-720p.mp4'),
        ffmpeg: FFMPEG,
        chromium,
      });
    } finally {
      clearInterval(watch);
    }
    watched.push(...outputs);
    // The reference: the frame loop of D28 over the full grid, in a page of its own.
    reference = await renderFrames({
      document: variant(() => undefined).document,
      resolveAsset: referenceResolver,
      timesUs: full.manifest.frames.map(({ timeUs }) => timeUs),
      chromium,
    });
  }, 1_200_000);

  afterAll(async () => {
    await chromium.browser.close();
    writeReport('export-report.json', report);
  });

  it('records the network interfaces this host reports, not assumed ones (D28.9)', () => {
    expect(full.manifest.environment.network).toEqual(
      networkFacts(Object.keys(networkInterfaces())),
    );
  });

  it('writes no file but the MP4 while exporting (§5 P5)', () => {
    report.frameFiles = watched;
    expect(watched).toEqual([]);
    expect(readdirSync(EXPORTS).sort()).toEqual(['video-1080p.mp4', 'video-720p.mp4']);
  });

  it('pipes exactly the pre-encode frames of the Producer for every (composition, timeUs)', () => {
    // The FFmpeg the export verified and used (D29.1), for ci-identity.json.
    report.ffmpeg = full.manifest.ffmpeg;
    expect(full.manifest.frames).toHaveLength(300);
    full.manifest.frames.forEach((frame, index) => {
      expect(frame.index).toBe(index);
      // frameToTimeUs of D13 at 30 fps, written out: ⌊index × 1 000 000 / 30⌋.
      expect(frame.timeUs).toBe(Math.floor((index * 1_000_000) / 30));
    });
    expect(full.manifest.frames).toEqual(reference.manifest.frames);
  });

  it('pipes the golden frames at the golden timestamps, where the pinned goldens exist', () => {
    const goldens = readGoldens();
    report.goldens = goldens === null ? 'none' : goldens.manifest.environment.pinned;
    report.pinned = pinned;
    report.goldenFramesCompared = false;
    if (goldens === null || !goldens.manifest.environment.pinned || !pinned) return;
    for (const { timeUs, frame: index } of goldenTimestamps) {
      expect(full.manifest.frames[index]?.sha256, String(timeUs)).toBe(
        goldens.manifest.frames.find((frame) => frame.timeUs === timeUs)?.sha256,
      );
    }
    // Only a comparison that ran to the end counts: an early return above leaves it false.
    report.goldenFramesCompared = true;
  });

  it('exports 720p from the same source frames (D29.5)', () => {
    expect(small.manifest.frames).toEqual(full.manifest.frames);
  });

  it('keeps FRAMES_IN_FLIGHT and writes every frame once (D29.3)', () => {
    report.stats = { full: full.stats, small: small.stats };
    expect(full.stats).toEqual({ framesWritten: 300, maxFramesInFlight: 2 });
  });

  it.each([
    ['1080p', 1080, 1920],
    ['720p', 720, 1280],
  ] as const)('has the video stream of D29.4 in the %s export', async (preset, width, height) => {
    const file = join(EXPORTS, `video-${preset}.mp4`);
    const { streams, format } = await probe(file);
    (report.probe ??= {}) as Record<string, unknown>;
    (report.probe as Record<string, unknown>)[preset] = { streams, format };
    expect(format.format_name).toContain('mp4');
    expect(streams.map(({ codec_type: type }) => type)).toEqual(['video', 'audio']);
    const [video] = streams;
    expect(video).toMatchObject({
      codec_name: 'h264',
      profile: 'High',
      level: 40,
      width,
      height,
      pix_fmt: 'yuv420p',
      sample_aspect_ratio: '1:1',
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1',
      time_base: '1/15360',
      nb_read_frames: '300',
      color_range: 'tv',
      color_space: 'bt709',
    });
    // Measured in the pinned container: this build writes the matrix and the range,
    // and ffprobe reports no primaries or transfer characteristics for the stream —
    // with or without +bitexact. The arguments still ask for BT.709 (D29.4), and the
    // manifest records them, so a change of intent is visible in review.
    report.colour = {
      space: video?.color_space ?? null,
      range: video?.color_range ?? null,
      primaries: video?.color_primaries ?? null,
      transfer: video?.color_transfer ?? null,
    };
    expect(full.manifest.ffmpeg.args).toEqual(
      expect.arrayContaining(['-color_primaries', 'bt709', '-color_trc', 'bt709']),
    );
    expect(await videoTimestamps(file)).toEqual(Array.from({ length: 300 }, (_, i) => i * 512));
    expect(format.tags?.creation_time).toBeUndefined();
    expect(format.tags?.encoder).toBeUndefined();
  });

  it.each(['1080p', '720p'])('has the audio stream of D29.6 in the %s export', async (preset) => {
    const file = join(EXPORTS, `video-${preset}.mp4`);
    const { streams, format } = await probe(file);
    const audio = streams[1];
    expect(audio).toMatchObject({
      codec_name: 'aac',
      profile: 'LC',
      sample_rate: '48000',
      channels: 2,
      channel_layout: 'stereo',
      time_base: '1/48000',
    });
    // D29.6: the stream starts at 0 within one sample, and lasts 480 000 samples up to one AAC frame more.
    expect(Math.abs(audio?.start_pts ?? Number.NaN)).toBeLessThanOrEqual(1);
    expect(audio?.duration_ts).toBeGreaterThanOrEqual(480_000);
    expect(audio?.duration_ts).toBeLessThan(480_000 + 1024);
    // The whole file lasts the composition, within one AAC frame.
    expect(Number(format.duration)).toBeGreaterThanOrEqual(10);
    expect(Number(format.duration)).toBeLessThan(10 + 1024 / 48_000);
  });

  it('decodes the audio in sync with its source: no leading silence, in phase (D29.6)', async () => {
    const samples = await decodedAudio(join(EXPORTS, 'video-1080p.mp4'));
    expect(samples.length).toBeGreaterThanOrEqual(480_000);
    expect(samples.length).toBeLessThan(480_000 + 1024);
    const window = 4_800;
    let best = { lag: 0, error: Number.POSITIVE_INFINITY };
    for (let lag = -50; lag <= 50; lag += 1) {
      let error = 0;
      for (let index = 100; index < window; index += 1) {
        const delta = (samples[index] ?? 0) - source(index - lag);
        error += delta * delta;
      }
      if (error < best.error) best = { lag, error };
    }
    const leading = Array.from(samples.subarray(0, 480)).map(Math.abs);
    const leadingPeak = Math.max(...leading);
    report.audio = { decodedSamples: samples.length, lag: best.lag, leadingPeak };
    expect(leadingPeak).toBeGreaterThan(4_000);
    expect(Math.abs(best.lag)).toBeLessThanOrEqual(2);
  });

  it('reports the decoded video against the pre-encode frames, without asserting it (P5)', async () => {
    const indices = goldenTimestamps.map(({ frame }) => frame);
    const decoded = await decodedFrames(join(EXPORTS, 'video-1080p.mp4'), indices);
    const rows = indices.map((index, position) => {
      const png = reference.frames[index]?.png ?? new Uint8Array();
      const neighbours = [index - 1, index + 1]
        .filter((other) => other >= 0 && other < 300)
        .map((other) =>
          psnr(decoded[position] as Pixels, decodePng(reference.frames[other]?.png ?? png)),
        );
      return {
        index,
        psnr: psnr(decoded[position] as Pixels, decodePng(png)),
        neighbourPsnr: neighbours,
      };
    });
    report.decodedVideo = rows;
    console.info(`Decoded MP4 against pre-encode frames (report only): ${JSON.stringify(rows)}`);
    expect(rows).toHaveLength(indices.length);
  });

  it('refuses FFmpeg that is missing, found by name, or not the pinned build, before the first frame', async () => {
    const attempts = [
      ['ffmpeg-missing', { ffmpegPath: 'ffmpeg', ffprobePath: FFMPEG.ffprobePath }],
      ['ffmpeg-missing', { ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: FFMPEG.ffprobePath }],
      ['ffmpeg-mismatch', { ffmpegPath: FFMPEG.ffprobePath, ffprobePath: FFMPEG.ffprobePath }],
    ] as const;
    for (const [code, ffmpeg] of attempts) {
      const output = join(EXPORTS, `refused-${code}.mp4`);
      await expect(
        exportMp4({
          document: variant(() => undefined).document,
          resolveAsset: referenceResolver,
          preset: '1080p',
          outputPath: output,
          ffmpeg,
          chromium,
        }),
      ).rejects.toMatchObject({ code });
      expect(existsSync(output)).toBe(false);
    }
  });

  it('refuses an audio asset shorter than its clip with the pinned ffprobe, before the first frame', async () => {
    const wav = generatedWav(48_000 * 5);
    const { document, resolveAsset } = variant(() => undefined, { 'asset-audio': wav });
    const output = join(EXPORTS, 'refused-audio.mp4');
    await expect(
      exportMp4({
        document,
        resolveAsset,
        preset: '1080p',
        outputPath: output,
        ffmpeg: FFMPEG,
        chromium,
      }),
    ).rejects.toMatchObject({ code: 'audio-invalid' });
    expect(existsSync(output)).toBe(false);
  });

  it('ends with custom-html-navigated when an element navigates at the last frame, and removes the output (D23.9, D29.7)', async () => {
    const { document } = variant((draft) => {
      const node = customHtmlNode(draft);
      node.html = (node.html ?? '').replace(
        "window.parent.postMessage({type:'kadrion:time-ack'",
        "if(data.requestId===299)setTimeout(function(){location.href='https://kadrion-nav.invalid/last'},0);window.parent.postMessage({type:'kadrion:time-ack'",
      );
    });
    expect(JSON.stringify(document)).toContain('kadrion-nav.invalid/last');
    const output = join(EXPORTS, 'refused-navigation.mp4');
    await expect(
      exportMp4({
        document,
        resolveAsset: referenceResolver,
        preset: '1080p',
        outputPath: output,
        ffmpeg: FFMPEG,
        chromium,
      }),
    ).rejects.toMatchObject({ code: 'custom-html-navigated' });
    expect(existsSync(output)).toBe(false);
  });
});

describe.skipIf(!available)(
  'memory of the export with the pinned FFmpeg (D29.3, report only)',
  () => {
    it(
      'reports the peak memory of Node.js and FFmpeg for 60 and 300 frames',
      { timeout: 600_000 },
      async () => {
        const chromium = await launchChromium();
        const rows: Record<string, unknown>[] = [];
        try {
          for (const frames of [60, 300]) {
            const { document } = variant((draft) => {
              (draft as unknown as { durationUs: number }).durationUs = (frames * 1_000_000) / 30;
              const [clip] = (draft as unknown as { clips: { durationUs: number }[] }).clips;
              if (clip !== undefined) clip.durationUs = (frames * 1_000_000) / 30;
            });
            let nodePeak = 0;
            let ffmpegPeakKb = 0;
            const sample = setInterval(() => {
              globalThis.gc?.();
              const { heapUsed, arrayBuffers } = process.memoryUsage();
              nodePeak = Math.max(nodePeak, heapUsed + arrayBuffers);
              for (const pid of existsSync('/proc') ? readdirSync('/proc') : []) {
                if (!/^\d+$/.test(pid)) continue;
                try {
                  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
                  if (!/^Name:\s+ffmpeg$/m.test(status)) continue;
                  const rss = Number(/^VmHWM:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0);
                  ffmpegPeakKb = Math.max(ffmpegPeakKb, rss);
                } catch {
                  // The process ended between listing and reading.
                }
              }
            }, 50);
            try {
              const result = await exportMp4({
                document,
                resolveAsset: referenceResolver,
                preset: '1080p',
                outputPath: join(EXPORTS, `memory-${String(frames)}.mp4`),
                ffmpeg: FFMPEG,
                chromium,
              });
              rows.push({ frames, nodePeakBytes: nodePeak, ffmpegPeakKb, stats: result.stats });
            } finally {
              clearInterval(sample);
              rmSync(join(EXPORTS, `memory-${String(frames)}.mp4`), { force: true });
            }
          }
        } finally {
          await chromium.browser.close();
        }
        writeReport('export-memory.json', rows);
        console.info(`Export memory (report only): ${JSON.stringify(rows)}`);
        expect(rows).toHaveLength(2);
      },
    );
  },
);

/** A WAV of `samples` silent samples at 48 kHz, mono, 16-bit. */
function generatedWav(samples: number): Uint8Array {
  const data = samples * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1)
      bytes[offset + index] = text.charCodeAt(index);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, data, true);
  return bytes;
}
