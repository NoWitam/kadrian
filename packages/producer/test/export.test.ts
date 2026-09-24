/**
 * The MP4 export of D29 without a browser or FFmpeg: the pure parts of
 * `encode.ts`, the verification of `ffmpeg.ts` on a fake host, and `exportWith`
 * on a fake frame loop and a fake encoder. Expected arguments and sample counts
 * are written out by hand from D29, not derived from the implementation.
 */
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';

import { generateReferenceAssets, referenceComposition } from '@kadrion/test-fixtures';
import { frameToTimeUs, validateComposition, type ValidatedComposition } from '@kadrion/schema';
import type { Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import {
  audioGraph,
  audioPlan,
  encoderArgs,
  TIME_SCALE_PER_FRAME,
  FRAMES_IN_FLIGHT,
  FrameSink,
  presetSize,
  receiptHashes,
  samplesAt,
  videoGraph,
  type StartTimer,
} from '../src/encode.js';
import { documentsProblem, type FrameDocument } from '../src/capture.js';
import { CHROMIUM_VERSION } from '../src/environment.js';
import { exportWith, type ExportDependencies, type ExportRequest } from '../src/export.js';
import {
  FFMPEG_CONFIGURATION,
  FFMPEG_SHA256,
  FFPROBE_SHA256,
  verifyFfmpeg,
  type AudioProbe,
  type EncoderProcess,
  type FfmpegHost,
  type FfmpegTools,
} from '../src/ffmpeg.js';
import { customHtmlNodes, type FrameSequence } from '../src/render.js';

function validated(input: unknown): ValidatedComposition {
  const result = validateComposition(input);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.composition;
}

function variant(edit: (draft: Record<string, unknown>) => void): unknown {
  const draft = structuredClone(referenceComposition) as Record<string, unknown>;
  edit(draft);
  return draft;
}

const reference = validated(referenceComposition);
const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('presets (D29.5)', () => {
  it('keeps 1080x1920 for 1080p and scales to 720x1280 for 720p', () => {
    expect(presetSize(reference, '1080p')).toEqual({ name: '1080p', width: 1080, height: 1920 });
    expect(presetSize(reference, '720p')).toEqual({ name: '720p', width: 720, height: 1280 });
  });

  it.each([
    ['an unknown name', reference, '480p'],
    ['a name from the prototype', reference, 'toString'],
    [
      'upscaling',
      validated(variant((d) => Object.assign(d, { width: 720, height: 1280 }))),
      '1080p',
    ],
    [
      'a fractional height',
      validated(variant((d) => Object.assign(d, { width: 1000, height: 1920 }))),
      '720p',
    ],
    [
      'an odd height',
      validated(variant((d) => Object.assign(d, { width: 1080, height: 1917 }))),
      '1080p',
    ],
  ])('refuses %s with preset-unsupported', (_, composition, name) => {
    expect(() => presetSize(composition, name)).toThrow(
      expect.objectContaining({ code: 'preset-unsupported' }),
    );
  });

  it('writes the video graphs of D29.5', () => {
    expect(videoGraph(presetSize(reference, '1080p'))).toBe(
      '[0:v]scale=1080:1920:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p[v]',
    );
    expect(videoGraph(presetSize(reference, '720p'))).toBe(
      '[0:v]scale=720:1280:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p[v]',
    );
  });
});

describe('samples at 48 kHz (D29.6)', () => {
  it.each([
    [0, 0],
    [10, 0], // 0.48
    [11, 1], // 0.528
    [20_822, 999], // 999.456
    [20_823, 1000], // 999.504
    [20_833, 1000], // 999.984
    [2_500_000, 120_000],
    [10_000_000, 480_000],
    [3_600_000_000, 172_800_000],
    // Beyond 2^52 µs a floating-point product rounds; the integer rule does not.
    [4_503_599_627_370_510, 216_172_782_113_784],
  ])('maps %i µs to sample %i', (timeUs, sample) => {
    expect(samplesAt(timeUs)).toBe(sample);
  });

  it('refuses a time that is not a non-negative safe integer', () => {
    for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => samplesAt(bad)).toThrow(RangeError);
    }
  });

  it('plans the reference clip over the whole composition', () => {
    expect(audioPlan(reference)).toEqual({
      clipId: 'clip-audio',
      assetId: 'asset-audio',
      startSample: 0,
      sampleCount: 480_000,
      totalSamples: 480_000,
      audibleUs: 10_000_000,
    });
  });

  it('places a later clip and hears it only up to the end of the composition', () => {
    const late = validated(
      variant((draft) => {
        const [clip] = draft.clips as Record<string, unknown>[];
        Object.assign(clip ?? {}, { startUs: 2_500_011, durationUs: 10_000_000 });
      }),
    );
    const plan = audioPlan(late);
    expect(plan).toEqual({
      clipId: 'clip-audio',
      assetId: 'asset-audio',
      startSample: 120_001, // 120 000.528
      sampleCount: 480_000, // 600 001 − 120 001
      totalSamples: 480_000,
      audibleUs: 7_499_989,
    });
    expect(plan === null ? '' : audioGraph(plan)).toBe(
      '[1:a]aresample=48000,atrim=end_sample=480000,adelay=delays=120001S:all=1,apad=whole_len=480000,atrim=end_sample=480000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]',
    );
  });

  it('plans nothing without an audio clip', () => {
    expect(audioPlan(validated(variant((draft) => (draft.clips = []))))).toBeNull();
  });
});

describe('the arguments of FFmpeg (D29.4)', () => {
  const graph1080 =
    '[0:v]scale=1080:1920:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p[v]';
  const audio =
    '[1:a]aresample=48000,atrim=end_sample=480000,adelay=delays=0S:all=1,apad=whole_len=480000,atrim=end_sample=480000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]';

  it('are exactly the list of D29.4, with the output as the only file', () => {
    expect(
      encoderArgs({ fps: 30, videoGraph: graph1080, audioGraph: audio, output: '/out/v.mp4' }),
    ).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-threads',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      '-framerate',
      '30',
      '-i',
      'pipe:0',
      '-i',
      'pipe:3',
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      `${graph1080};${audio}`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-fps_mode',
      'passthrough',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-profile:v',
      'high',
      '-level:v',
      '4.0',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '1',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
      '-video_track_timescale',
      '15360',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-fflags',
      '+bitexact',
      '-flags:v',
      '+bitexact',
      '-flags:a',
      '+bitexact',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      '-y',
      '/out/v.mp4',
      '-map',
      '0:v',
      '-c:v',
      'copy',
      '-f',
      'framehash',
      '-hash',
      'sha256',
      'pipe:1',
    ]);
  });

  it('leave out the audio input, map, and encoder without a clip', () => {
    const args = encoderArgs({ fps: 30, videoGraph: graph1080, audioGraph: null, output: 'o.mp4' });
    expect(args).not.toContain('pipe:3');
    expect(args).not.toContain('[a]');
    expect(args).not.toContain('aac');
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(graph1080);
  });
});

describe('the receipt of FFmpeg (D29.3)', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);

  it('lists the hash of every packet in order and skips the header', () => {
    // The format the pinned build printed in the container: the digest is bare.
    const text = [
      '#format: frame checksums',
      '#version: 2',
      '#hash: SHA256',
      '#tb 0: 1/30',
      '#stream#, dts,        pts, duration,     size, hash',
      `0,          0,          0,        1,    35530, ${a}`,
      `0,          1,          1,        1,    35612, ${b}`,
      '',
    ].join('\n');
    expect(receiptHashes(text)).toEqual([`sha256:${a}`, `sha256:${b}`]);
  });

  it('refuses a line it does not understand, so a changed format is not an empty receipt', () => {
    expect(() => receiptHashes(`1, 0, 0, 1, 10, ${a}\n`)).toThrow(
      expect.objectContaining({ code: 'encode-failed' }),
    );
    expect(() => receiptHashes(`0, 0, 0, 1, 10, SHA256=${a}\n`)).toThrow(
      expect.objectContaining({ code: 'encode-failed' }),
    );
    expect(() => receiptHashes(`0, 0, 0, 1, 10, MD5=${a.slice(0, 32)}\n`)).toThrow(
      expect.objectContaining({ code: 'encode-failed' }),
    );
    expect(() => receiptHashes(`0, 0, 0, 1, 10, ${a.slice(0, 63)}\n`)).toThrow(
      expect.objectContaining({ code: 'encode-failed' }),
    );
  });
});

/** A timer the test expires by hand. */
function manualTimer(): { start: StartTimer; expireAll: () => void; pending: () => number } {
  const timers = new Set<() => void>();
  return {
    start(expire) {
      timers.add(expire);
      return () => timers.delete(expire);
    },
    expireAll() {
      for (const expire of [...timers]) {
        timers.delete(expire);
        expire();
      }
    },
    pending: () => timers.size,
  };
}

/** A pipe that accepts a chunk only when the test says so. */
function heldPipe(): { stream: Writable; chunks: Uint8Array[]; release: () => void } {
  const chunks: Uint8Array[] = [];
  const held: (() => void)[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Uint8Array, _encoding, callback) {
      chunks.push(chunk);
      held.push(() => {
        callback();
      });
    },
  });
  return { stream, chunks, release: () => held.shift()?.() };
}

const settled = async (promise: Promise<unknown>): Promise<string> => {
  const marker = Symbol('pending');
  const result = await Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise((resolve) =>
      setImmediate(() => {
        resolve(marker);
      }),
    ),
  ]);
  return result === marker ? 'pending' : String(result);
};

describe('the frame sink (D29.3)', () => {
  it('admits FRAMES_IN_FLIGHT frames and holds the next until the pipe takes one', async () => {
    expect(FRAMES_IN_FLIGHT).toBe(2);
    const pipe = heldPipe();
    const timer = manualTimer();
    const sink = new FrameSink(pipe.stream, 1_000, timer.start);
    await sink.write(new Uint8Array([1]));
    await sink.write(new Uint8Array([2]));
    const third = sink.write(new Uint8Array([3]));
    expect(await settled(third)).toBe('pending');
    pipe.release();
    await third;
    expect(sink.maxInFlight).toBe(2);
    expect(sink.written).toBe(3);
    const end = sink.end();
    expect(await settled(end)).toBe('pending');
    pipe.release();
    pipe.release();
    await end;
    expect(pipe.chunks.map((chunk) => chunk[0])).toEqual([1, 2, 3]);
  });

  it('fails with encode-failed when the pipe accepts nothing in time, and stays failed', async () => {
    const pipe = heldPipe();
    const timer = manualTimer();
    const sink = new FrameSink(pipe.stream, 1_000, timer.start);
    await sink.write(new Uint8Array([1]));
    await sink.write(new Uint8Array([2]));
    const third = sink.write(new Uint8Array([3]));
    timer.expireAll();
    await expect(third).rejects.toMatchObject({ code: 'encode-failed' });
    await expect(sink.write(new Uint8Array([4]))).rejects.toMatchObject({ code: 'encode-failed' });
    expect(sink.written).toBe(2);
  });

  it('fails with encode-failed when the pipe breaks', async () => {
    const pipe = heldPipe();
    const sink = new FrameSink(pipe.stream, 1_000, manualTimer().start);
    await sink.write(new Uint8Array([1]));
    await sink.write(new Uint8Array([2]));
    const third = sink.write(new Uint8Array([3]));
    pipe.stream.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(third).rejects.toMatchObject({ code: 'encode-failed' });
  });
});

/** A host that answers like the pinned build; each test changes one thing. */
function pinnedHost(change: Partial<FfmpegHost> = {}, log: string[] = []): FfmpegHost {
  return {
    platform: 'linux',
    arch: 'x64',
    isFile: (path) => {
      log.push(`isFile ${path}`);
      return true;
    },
    sha256: (path) => {
      log.push(`sha256 ${path}`);
      return Promise.resolve(path.endsWith('ffprobe') ? FFPROBE_SHA256 : FFMPEG_SHA256);
    },
    run: (path, args) => {
      log.push(`run ${path} ${args.join(' ')}`);
      if (args.includes('-encoders')) {
        return Promise.resolve({
          code: 0,
          stdout:
            ' V....D libx264              libx264 H.264\n A....D aac                  AAC (Advanced Audio Coding)\n',
          stderr: '',
        });
      }
      const name = path.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg';
      const years = name === 'ffprobe' ? '2007-2026' : '2000-2026';
      return Promise.resolve({
        code: 0,
        stdout: `${name} version n8.1.3-20260921 Copyright (c) ${years} the FFmpeg developers\nbuilt with gcc\nconfiguration: ${FFMPEG_CONFIGURATION}\n`,
        stderr: '',
      });
    },
    ...change,
  };
}

const PATHS = {
  ffmpegPath: '/opt/kadrion-ffmpeg/ffmpeg',
  ffprobePath: '/opt/kadrion-ffmpeg/ffprobe',
};

describe('verification of the pinned FFmpeg (D29.1)', () => {
  it('accepts the pinned build and reports its identity', async () => {
    await expect(verifyFfmpeg(PATHS, pinnedHost())).resolves.toEqual({
      ffmpegSha256: FFMPEG_SHA256,
      ffprobeSha256: FFPROBE_SHA256,
      version: 'n8.1.3-20260921',
      configuration: FFMPEG_CONFIGURATION,
      encoders: ['libx264', 'aac'],
    });
  });

  it.each([
    ['a bare name, which PATH would resolve', { ...PATHS, ffmpegPath: 'ffmpeg' }],
    ['a relative path', { ...PATHS, ffprobePath: 'bin/ffprobe' }],
  ])('refuses %s with ffmpeg-missing before touching anything', async (_, paths) => {
    const log: string[] = [];
    await expect(verifyFfmpeg(paths, pinnedHost({}, log))).rejects.toMatchObject({
      code: 'ffmpeg-missing',
    });
    expect(log.filter((line) => !line.startsWith('isFile'))).toEqual([]);
  });

  it('refuses a missing file with ffmpeg-missing', async () => {
    await expect(
      verifyFfmpeg(PATHS, pinnedHost({ isFile: (path) => !path.endsWith('ffprobe') })),
    ).rejects.toMatchObject({ code: 'ffmpeg-missing' });
  });

  it('refuses another platform before hashing', async () => {
    const log: string[] = [];
    await expect(verifyFfmpeg(PATHS, pinnedHost({ platform: 'win32' }, log))).rejects.toMatchObject(
      {
        code: 'ffmpeg-mismatch',
      },
    );
    expect(log.some((line) => line.startsWith('sha256'))).toBe(false);
  });

  it.each([
    [
      'another ffmpeg',
      (path: string) => (path.endsWith('ffmpeg') ? `sha256:${'0'.repeat(64)}` : FFPROBE_SHA256),
    ],
    [
      'another ffprobe',
      (path: string) => (path.endsWith('ffprobe') ? `sha256:${'0'.repeat(64)}` : FFMPEG_SHA256),
    ],
  ])('refuses %s by checksum, before running anything', async (_, sha) => {
    const log: string[] = [];
    await expect(
      verifyFfmpeg(PATHS, pinnedHost({ sha256: (path) => Promise.resolve(sha(path)) }, log)),
    ).rejects.toMatchObject({ code: 'ffmpeg-mismatch' });
    expect(log.some((line) => line.startsWith('run'))).toBe(false);
  });

  const replaced = (
    from: string,
    to: string,
    when: (args: readonly string[], path: string) => boolean,
  ) =>
    pinnedHost({
      run: async (path, args) => {
        const result = await pinnedHost().run(path, args);
        return when(args, path) ? { ...result, stdout: result.stdout.replace(from, to) } : result;
      },
    });

  it.each([
    [
      'another ffmpeg version',
      replaced(
        'n8.1.3-20260921',
        'n8.1.2',
        (a, p) => a.includes('-version') && p.endsWith('ffmpeg'),
      ),
    ],
    [
      'another ffprobe version',
      replaced(
        'n8.1.3-20260921',
        'n8.1.2',
        (a, p) => a.includes('-version') && p.endsWith('ffprobe'),
      ),
    ],
    ['another configuration', replaced('--enable-libx264 ', '', (a) => a.includes('-version'))],
    [
      'no libx264',
      replaced('libx264              libx264', 'libx265              libx265', (a) =>
        a.includes('-encoders'),
      ),
    ],
    ['no aac', replaced(' aac ', ' mp3 ', (a) => a.includes('-encoders'))],
    [
      'a failing -version',
      pinnedHost({
        run: (path, args) =>
          pinnedHost()
            .run(path, args)
            .then((r) => ({ ...r, code: args.includes('-version') ? 1 : 0 })),
      }),
    ],
  ])('refuses %s with ffmpeg-mismatch', async (_, host) => {
    await expect(verifyFfmpeg(PATHS, host)).rejects.toMatchObject({ code: 'ffmpeg-mismatch' });
  });
});

const ASSETS = Object.fromEntries(generateReferenceAssets().map((asset) => [asset.id, asset]));
const AUDIO_BYTES = ASSETS['asset-audio']?.bytes ?? new Uint8Array();
/** The WAV fixture as ffprobe counts it from a pipe: 480 000 samples at 48 kHz. */
const WAV_PROBE: AudioProbe = { audioStreams: 1, sampleRate: 48_000, samples: 480_000n };

/** A frame's bytes: distinct per index, and as large as the test wants. */
function frameBytes(index: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, index);
  return bytes;
}

interface FakeRun {
  readonly dependencies: ExportDependencies;
  readonly log: string[];
  /** SHA-256 hex of every frame the encoder read, in order; the bytes are not kept. */
  readonly received: string[];
  readonly audioReceived: Uint8Array[];
  readonly timer: ReturnType<typeof manualTimer>;
  deliveredFrames: number;
  args: readonly string[];
}

interface FakeOptions {
  readonly frameSize?: number;
  readonly probe?: AudioProbe;
  /** Never accept a frame: the stalled encoder of D29.3. */
  readonly stall?: boolean;
  /** Never read the audio pipe: FFmpeg that stops reading without closing it. */
  readonly stallAudio?: boolean;
  readonly exitCode?: number;
  readonly receipt?: (hashes: readonly string[]) => readonly string[];
  readonly packets?: (frames: number) => number;
  readonly timestamps?: (wanted: readonly number[]) => number[];
  readonly failAt?: { readonly index: number; readonly code: string };
  readonly toolsFail?: string;
  readonly onFrame?: (index: number) => void;
}

function fakeRun(options: FakeOptions = {}): FakeRun {
  const run: FakeRun = {
    log: [],
    received: [],
    audioReceived: [],
    timer: manualTimer(),
    deliveredFrames: 0,
    args: [],
    dependencies: undefined as unknown as ExportDependencies,
  };
  const sequence: FrameSequence = async (prepared, frames, deliver) => {
    run.log.push(`load ${prepared.composition.schemaVersion}`);
    for (const { index, timeUs } of frames) {
      if (options.failAt?.index === index) {
        throw Object.assign(new Error('failed'), { code: options.failAt.code });
      }
      run.deliveredFrames += 1;
      options.onFrame?.(index);
      await deliver({ index, timeUs, png: frameBytes(index, options.frameSize ?? 16) });
    }
    return { blockedRequests: [] };
  };
  const tools: FfmpegTools = {
    identity: {
      ffmpegSha256: FFMPEG_SHA256,
      ffprobeSha256: FFPROBE_SHA256,
      version: 'n8.1.3-20260921',
      configuration: FFMPEG_CONFIGURATION,
      encoders: ['libx264', 'aac'],
    },
    probeAudio(bytes) {
      run.log.push(`probe ${String(bytes.length)}`);
      return Promise.resolve(options.probe ?? WAV_PROBE);
    },
    countVideoPackets(file) {
      run.log.push(`count ${file}`);
      return Promise.resolve((options.packets ?? ((n) => n))(run.received.length));
    },
    videoTimestamps(file) {
      run.log.push(`timestamps ${file}`);
      const wanted = run.received.map((_, index) => index * TIME_SCALE_PER_FRAME);
      return Promise.resolve((options.timestamps ?? ((given) => [...given]))(wanted));
    },
    spawnEncoder(args, withAudio) {
      run.log.push(`spawn audio=${String(withAudio)}`);
      run.args = args;
      let exit: (value: { code: number | null; stderr: string }) => void = () => undefined;
      const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        exit = resolve;
      });
      const video = new Writable({
        highWaterMark: 1,
        write(chunk: Uint8Array, _encoding, callback) {
          if (options.stall === true) return;
          run.received.push(hex(chunk));
          setImmediate(callback);
        },
        final(callback) {
          callback();
          setImmediate(() => {
            exit({ code: options.exitCode ?? 0, stderr: 'fake stderr' });
          });
        },
      });
      const audio = withAudio
        ? new Writable({
            write(chunk: Uint8Array, _encoding, callback) {
              if (options.stallAudio === true) return;
              run.audioReceived.push(new Uint8Array(chunk));
              callback();
            },
          })
        : null;
      const encoder: EncoderProcess = {
        video,
        audio,
        get receipt() {
          const hashes = (options.receipt ?? ((h) => h))(run.received);
          return Promise.resolve(
            hashes.map((h, i) => `0, ${String(i)}, ${String(i)}, 1, 16, ${h}`).join('\n'),
          );
        },
        exited,
        kill() {
          run.log.push('kill');
          exit({ code: null, stderr: 'killed' });
        },
      };
      return encoder;
    },
  };
  (run as { dependencies: ExportDependencies }).dependencies = {
    tools: () => {
      run.log.push('tools');
      return options.toolsFail === undefined
        ? Promise.resolve(tools)
        : Promise.reject(Object.assign(new Error('no ffmpeg'), { code: options.toolsFail }));
    },
    browser: () => {
      run.log.push('browser');
      return Promise.resolve({
        chromium: { browser: {} as Browser, reportedVersion: CHROMIUM_VERSION },
        sequence,
        close: () => {
          run.log.push('close');
          return Promise.resolve();
        },
      });
    },
    removeFile: (path) => {
      run.log.push(`remove ${path}`);
      return Promise.resolve();
    },
    startTimer: run.timer.start,
  };
  return run;
}

function request(change: Partial<ExportRequest> = {}): ExportRequest {
  return {
    document: referenceComposition,
    resolveAsset: ({ id }) => ASSETS[id] ?? null,
    preset: '1080p',
    outputPath: '/out/video-1080p.mp4',
    ffmpeg: PATHS,
    ...change,
  };
}

describe('the export on a fake frame loop and encoder (D29.3)', () => {
  it('pipes every frame of the grid in order, hashes those bytes, and muxes the verified audio', async () => {
    const run = fakeRun();
    const result = await exportWith(request(), run.dependencies);
    const { manifest } = result;
    expect(manifest.frames).toHaveLength(300);
    manifest.frames.forEach((frame, index) => {
      expect(frame).toEqual({
        index,
        timeUs: frameToTimeUs(index, 30),
        sha256: `sha256:${hex(frameBytes(index, 16))}`,
      });
    });
    expect(run.received).toEqual(manifest.frames.map(({ sha256 }) => sha256.slice(7)));
    expect(Buffer.concat(run.audioReceived).equals(Buffer.from(AUDIO_BYTES))).toBe(true);
    expect(result.stats).toEqual({ framesWritten: 300, maxFramesInFlight: 2 });
    expect(run.log).toEqual([
      'tools',
      `probe ${String(AUDIO_BYTES.length)}`,
      'browser',
      'spawn audio=true',
      'load 0.1',
      `count ${result.outputPath}`,
      `timestamps ${result.outputPath}`,
      'close',
    ]);
    expect(run.args).toContain(result.outputPath);
    expect(manifest.ffmpeg.args).not.toContain(result.outputPath);
    expect(manifest.ffmpeg.args).toContain('<output>');
    expect(manifest.preset).toEqual({
      name: 'mp4-1080p',
      width: 1080,
      height: 1920,
      sourceWidth: 1080,
      sourceHeight: 1920,
      fps: 30,
      deviceScaleFactor: 1,
      videoGraph:
        '[0:v]scale=1080:1920:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p[v]',
    });
    expect(manifest.audio).toEqual({
      clipId: 'clip-audio',
      assetId: 'asset-audio',
      sampleRate: 48_000,
      startSample: 0,
      sampleCount: 480_000,
      totalSamples: 480_000,
      channelLayout: 'stereo',
      codec: 'aac',
      bitrate: '128k',
    });
  });

  it('names the environment in one identity block that agrees with the other fields (D29.9)', async () => {
    const { manifest } = await exportWith(request(), fakeRun().dependencies);
    // The declared image of D26.2 when the run is pinned (the container), else nothing.
    const declared = manifest.environment.pinned
      ? (/@(sha256:[0-9a-f]{64})$/.exec(manifest.environment.image ?? '')?.[1] ?? null)
      : null;
    expect(manifest.identity).toEqual({
      playwrightImageDigest: declared,
      playwrightVersion: manifest.chromium.playwrightCore,
      chromiumRevision: manifest.chromium.revision,
      ffmpegSha256: manifest.ffmpeg.ffmpegSha256,
      ffprobeSha256: manifest.ffmpeg.ffprobeSha256,
      ffmpegVersion: manifest.ffmpeg.version,
      ffmpegBuildConfiguration: manifest.ffmpeg.configuration,
    });
    expect(manifest.manifestVersion).toBe(2);
    expect(JSON.stringify(manifest)).not.toContain('/out/');
  });

  it('exports the 720p preset from the same frames', async () => {
    const run1080 = fakeRun();
    const run720 = fakeRun();
    const a = await exportWith(request(), run1080.dependencies);
    const b = await exportWith(
      request({ preset: '720p', outputPath: '/out/v720.mp4' }),
      run720.dependencies,
    );
    expect(b.manifest.frames).toEqual(a.manifest.frames);
    expect(b.manifest.preset.width).toBe(720);
    expect(run720.args).toContain(
      '[0:v]scale=720:1280:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p[v];[1:a]aresample=48000,atrim=end_sample=480000,adelay=delays=0S:all=1,apad=whole_len=480000,atrim=end_sample=480000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]',
    );
  });

  it('exports without an audio stream when the document has no clip', async () => {
    const run = fakeRun();
    const { manifest } = await exportWith(
      request({ document: variant((draft) => (draft.clips = [])) }),
      run.dependencies,
    );
    expect(manifest.audio).toBeNull();
    expect(run.log).toContain('spawn audio=false');
    expect(run.log.some((line) => line.startsWith('probe'))).toBe(false);
  });

  it.each([
    ['preset-unsupported', { preset: '4k' }, {}],
    ['invalid-document', { document: { schemaVersion: '0.1' } }, {}],
    ['asset-missing', { resolveAsset: () => null }, {}],
    ['ffmpeg-missing', {}, { toolsFail: 'ffmpeg-missing' }],
    ['audio-invalid', {}, { probe: { ...WAV_PROBE, samples: 479_999n } }],
    ['audio-invalid', {}, { probe: { ...WAV_PROBE, audioStreams: 2 } }],
    ['audio-invalid', {}, { probe: { ...WAV_PROBE, sampleRate: null } }],
  ] as const)(
    'fails with %s before a browser opens or FFmpeg starts',
    async (code, change, options) => {
      const run = fakeRun(options);
      await expect(exportWith(request(change), run.dependencies)).rejects.toMatchObject({ code });
      expect(run.log).not.toContain('browser');
      expect(run.log.some((line) => line.startsWith('spawn'))).toBe(false);
    },
  );

  it('refuses a clip that starts at or after the end of the composition (D29.6)', async () => {
    const late = variant((draft) => {
      const [clip] = draft.clips as Record<string, unknown>[];
      Object.assign(clip ?? {}, { startUs: 10_000_000, durationUs: 1_000_000 });
    });
    const run = fakeRun();
    await expect(exportWith(request({ document: late }), run.dependencies)).rejects.toMatchObject({
      code: 'audio-invalid',
    });
    expect(run.log).not.toContain('browser');
  });

  it('accepts an asset exactly as long as the part of the clip that is heard', async () => {
    // 440 000 samples = 9 166 666.67 µs: too short for the reference clip…
    await expect(
      exportWith(request(), fakeRun({ probe: { ...WAV_PROBE, samples: 440_000n } }).dependencies),
    ).rejects.toMatchObject({ code: 'audio-invalid' });
    // …but the clip moved to 2.5 s is heard for 7.5 s = 360 000 samples only.
    const late = variant((draft) => {
      const [clip] = draft.clips as Record<string, unknown>[];
      Object.assign(clip ?? {}, { startUs: 2_500_000, durationUs: 10_000_000 });
    });
    await expect(
      exportWith(
        request({ document: late }),
        fakeRun({ probe: { ...WAV_PROBE, samples: 360_000n } }).dependencies,
      ),
    ).resolves.toBeDefined();
    await expect(
      exportWith(
        request({ document: late }),
        fakeRun({ probe: { ...WAV_PROBE, samples: 359_999n } }).dependencies,
      ),
    ).rejects.toMatchObject({ code: 'audio-invalid' });
  });

  it('renders at most FRAMES_IN_FLIGHT + 1 frames into an encoder that accepts nothing, then fails', async () => {
    const run = fakeRun({ stall: true });
    const pending = exportWith(request(), run.dependencies);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.deliveredFrames).toBe(FRAMES_IN_FLIGHT + 1);
    run.timer.expireAll();
    await expect(pending).rejects.toMatchObject({ code: 'encode-failed' });
    expect(run.deliveredFrames).toBe(FRAMES_IN_FLIGHT + 1);
    const [kill, remove, close] = run.log.slice(-3);
    expect([kill, close]).toEqual(['kill', 'close']);
    expect(remove).toMatch(/^remove .*video-1080p.mp4$/);
  });

  it('fails with encode-failed when FFmpeg stops reading the audio without closing the pipe', async () => {
    const run = fakeRun({ stallAudio: true });
    const pending = exportWith(request(), run.dependencies);
    await new Promise((resolve) => setTimeout(resolve, 50));
    run.timer.expireAll();
    await expect(pending).rejects.toMatchObject({ code: 'encode-failed' });
    expect(run.log).toContain('kill');
  });

  it.each([
    ['FFmpeg exits with an error', { exitCode: 1 }],
    ['the receipt misses a frame', { receipt: (h: readonly string[]) => h.slice(1) }],
    [
      'the receipt has other bytes',
      { receipt: (h: readonly string[]) => h.map((x, i) => (i === 150 ? 'f'.repeat(64) : x)) },
    ],
    [
      'the receipt is reordered',
      { receipt: (h: readonly string[]) => [h[1] ?? '', h[0] ?? '', ...h.slice(2)] },
    ],
    ['the output has another packet count', { packets: (n: number) => n - 1 }],
    [
      'a frame of the output is at another presentation time',
      { timestamps: (w: readonly number[]) => w.map((pts, at) => (at === 150 ? pts + 512 : pts)) },
    ],
    [
      'the output repeats a presentation time',
      {
        timestamps: (w: readonly number[]) =>
          w.map((pts, at) => (at === 150 ? (w[149] ?? 0) : pts)),
      },
    ],
  ])('fails with encode-failed and removes the output when %s', async (_, options) => {
    const run = fakeRun(options);
    await expect(exportWith(request(), run.dependencies)).rejects.toMatchObject({
      code: 'encode-failed',
    });
    expect(run.log.some((line) => line.startsWith('remove'))).toBe(true);
    expect(run.log.at(-1)).toBe('close');
  });

  it('ends on a navigated element with its code, kills FFmpeg, and removes the output (D23.9)', async () => {
    const run = fakeRun({ failAt: { index: 150, code: 'custom-html-navigated' } });
    await expect(exportWith(request(), run.dependencies)).rejects.toMatchObject({
      code: 'custom-html-navigated',
    });
    expect(run.deliveredFrames).toBe(150);
    expect(run.log).toContain('kill');
    expect(run.log.some((line) => line.startsWith('remove'))).toBe(true);
  });
});

describe('memory of the export (D29.3, specification §5 P5)', () => {
  it('premise: the garbage collector can be called', () => {
    expect(typeof globalThis.gc).toBe('function');
  });

  it(
    'keeps no frame: live memory does not grow with the number of frames',
    { timeout: 120_000 },
    async () => {
      const size = 4 * 1024 * 1024;
      const peaks: number[] = [];
      const measure = async (frames: number): Promise<number> => {
        let peak = 0;
        const document = variant((draft) => {
          draft.durationUs = Math.round((frames * 1_000_000) / 30);
          draft.clips = [];
        });
        const run = fakeRun({
          frameSize: size,
          onFrame: (index) => {
            if (index % 10 === 9) {
              globalThis.gc?.();
              peak = Math.max(peak, process.memoryUsage().arrayBuffers);
            }
          },
        });
        // The reference animations end within the shortened document; only its length matters here.
        await exportWith(request({ document }), run.dependencies).catch((reason: unknown) => {
          throw reason;
        });
        return peak;
      };
      globalThis.gc?.();
      const baseline = process.memoryUsage().arrayBuffers;
      peaks.push(await measure(30), await measure(300));
      const [short = 0, long = 0] = peaks;
      // Keeping every frame would grow the peak by the 270 extra frames of 4 MB; the window
      // of D29.3 holds three. A quarter of that growth is far above the collector's slack and
      // far below what retention would cost.
      const retained = (300 - 30) * size;
      expect(long - short).toBeLessThan(retained / 4);
      expect(long - baseline).toBeLessThan(retained / 4);
    },
  );
});

describe('the documents of the Custom HTML frames (D29.7)', () => {
  const shell = (loaderId: string): FrameDocument => ({ loaderId, url: 'about:srcdoc' });
  const one = new Map([['frame-a', shell('load-1')]]);

  it('counts the Custom HTML nodes of a composition, and none when there are none', () => {
    expect(customHtmlNodes(reference)).toBe(1);
    const two = validated(
      variant((draft) => {
        const [scene] = draft.scenes as Record<string, unknown>[];
        const nodes = (scene?.nodes ?? []) as Record<string, unknown>[];
        const element = nodes.find(({ type }) => type === 'custom-html');
        nodes.push({ ...structuredClone(element), id: 'node-second' });
      }),
    );
    expect(customHtmlNodes(two)).toBe(2);
    const none = validated(
      variant((draft) => {
        const [scene] = draft.scenes as Record<string, unknown>[];
        if (scene !== undefined) {
          scene.nodes = (scene.nodes as Record<string, unknown>[]).filter(
            ({ type }) => type !== 'custom-html',
          );
        }
      }),
    );
    expect(customHtmlNodes(none)).toBe(0);
  });

  it('counts an element inside a group, which schema 0.1 cannot express yet', () => {
    // Groups hold image and text nodes only (D16), so this document is forged on
    // purpose: the count must not depend on where an element sits in the tree.
    const nested = {
      scenes: [
        {
          nodes: [
            { type: 'group', children: [{ type: 'custom-html' }, { type: 'text' }] },
            { type: 'custom-html' },
          ],
        },
      ],
    } as unknown as ValidatedComposition;
    expect(customHtmlNodes(nested)).toBe(2);
  });

  it('accepts as many shells as the composition has nodes, and the same ones again', () => {
    expect(documentsProblem(1, null, one)).toBeNull();
    expect(documentsProblem(1, one, new Map([['frame-a', shell('load-1')]]))).toBeNull();
    expect(documentsProblem(0, null, new Map())).toBeNull();
  });

  it('refuses a page that shows another number of frames than the composition has', () => {
    // The fail-open case: a frame the Producer cannot see is not an empty check.
    expect(documentsProblem(1, null, new Map())).toContain('0 Custom HTML frames');
    expect(documentsProblem(1, null, new Map([...one, ['frame-b', shell('load-2')]]))).toContain(
      '2 Custom HTML frames',
    );
  });

  it('refuses a document that is not the shell, or another document than the first frame', () => {
    expect(
      documentsProblem(
        1,
        null,
        new Map([['frame-a', { loaderId: 'load-1', url: 'chrome-error://chromewebdata/' }]]),
      ),
    ).toContain('instead of its shell');
    expect(documentsProblem(1, one, new Map([['frame-a', shell('load-2')]]))).toContain(
      'loaded another document',
    );
    expect(documentsProblem(1, one, new Map([['frame-b', shell('load-1')]]))).toContain('is gone');
  });
});
