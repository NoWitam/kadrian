/**
 * The pure parts of the MP4 export (D29): the preset sizes, the sample
 * arithmetic of the audio, the filter graphs and arguments of FFmpeg, the
 * receipt FFmpeg prints, and the sink that bounds the frames in flight. Nothing
 * here starts a process or touches a file.
 */
import type { Writable } from 'node:stream';

import type { ValidatedComposition } from '@kadrion/schema';

import { ProducerError } from './errors.js';

/** The presets of D07, named by their short side (D29.5). */
export const PRESETS = Object.freeze({ '1080p': 1080, '720p': 720 } as const);
export type PresetName = keyof typeof PRESETS;

export interface PresetSize {
  readonly name: PresetName;
  readonly width: number;
  readonly height: number;
}

/** The output size of a preset for a composition, or `preset-unsupported` (D29.5). */
export function presetSize(composition: ValidatedComposition, name: string): PresetSize {
  if (!Object.hasOwn(PRESETS, name)) {
    throw new ProducerError(
      'preset-unsupported',
      `The preset must be one of ${Object.keys(PRESETS).join(', ')}, got ${JSON.stringify(name)}.`,
    );
  }
  const preset = name as PresetName;
  const shortSide = PRESETS[preset];
  const { width, height } = composition;
  const source = Math.min(width, height);
  if (shortSide > source) {
    throw new ProducerError(
      'preset-unsupported',
      `The preset ${preset} would upscale a composition of ${String(width)}x${String(height)}.`,
    );
  }
  const scaledWidth = (width * shortSide) / source;
  const scaledHeight = (height * shortSide) / source;
  if (
    !Number.isInteger(scaledWidth) ||
    !Number.isInteger(scaledHeight) ||
    scaledWidth % 2 !== 0 ||
    scaledHeight % 2 !== 0
  ) {
    throw new ProducerError(
      'preset-unsupported',
      `The preset ${preset} gives ${String(scaledWidth)}x${String(scaledHeight)}, not two even integers.`,
    );
  }
  return { name: preset, width: scaledWidth, height: scaledHeight };
}

/** The output sample rate of the audio (D29.6). */
export const SAMPLE_RATE = 48_000;
export const AUDIO_CHANNEL_LAYOUT = 'stereo';
export const AUDIO_CODEC = 'aac';
export const AUDIO_BITRATE = '128k';

/**
 * The nearest sample at `SAMPLE_RATE` to a time in microseconds, an exact half
 * rounded up: ⌊(us × 48 000 + 500 000) / 1 000 000⌋, in BigInt, so that no
 * floating-point value takes part (D29.6).
 */
export function samplesAt(timeUs: number): number {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
    throw new RangeError(`A time must be a non-negative safe integer, got ${String(timeUs)}.`);
  }
  return Number((BigInt(timeUs) * BigInt(SAMPLE_RATE) + 500_000n) / 1_000_000n);
}

/** The mux of the one audio clip of a composition, in output samples (D29.6). */
export interface AudioPlan {
  readonly clipId: string;
  readonly assetId: string;
  readonly startSample: number;
  readonly sampleCount: number;
  readonly totalSamples: number;
  /** How much of the asset is heard: the clip up to the end of the composition. */
  readonly audibleUs: number;
}

export function audioPlan(composition: ValidatedComposition): AudioPlan | null {
  const [clip] = composition.clips;
  if (clip === undefined) return null;
  const startSample = samplesAt(clip.startUs);
  const endSample = samplesAt(clip.startUs + clip.durationUs);
  return {
    clipId: clip.id,
    assetId: clip.assetId,
    startSample,
    sampleCount: endSample - startSample,
    totalSamples: samplesAt(composition.durationUs),
    audibleUs: Math.max(0, Math.min(clip.durationUs, composition.durationUs - clip.startUs)),
  };
}

/** The video graph of D29.5: RGB to BT.709 limited range, square pixels, 4:2:0. */
export function videoGraph(size: PresetSize): string {
  // Always with its size, even when it equals the composition's: one form, one code path.
  const scale = `scale=${String(size.width)}:${String(size.height)}:flags=lanczos`;
  return `[0:v]${scale}:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p[v]`;
}

/** The audio graph of D29.6: resample, cut to the clip, place it, pad, and cut to the composition. */
export function audioGraph(plan: AudioPlan): string {
  return [
    `[1:a]aresample=${String(SAMPLE_RATE)}`,
    `atrim=end_sample=${String(plan.sampleCount)}`,
    `adelay=delays=${String(plan.startSample)}S:all=1`,
    `apad=whole_len=${String(plan.totalSamples)}`,
    `atrim=end_sample=${String(plan.totalSamples)}`,
    `aformat=sample_fmts=fltp:sample_rates=${String(SAMPLE_RATE)}:channel_layouts=${AUDIO_CHANNEL_LAYOUT}[a]`,
  ].join(',');
}

/** The time base of the video track is `fps × TIME_SCALE_PER_FRAME` (D29.4). */
export const TIME_SCALE_PER_FRAME = 512;

/** What the output path is replaced with in the manifest (D29.4). */
export const OUTPUT_PLACEHOLDER = '<output>';

export interface EncoderArgsOptions {
  readonly fps: number;
  readonly videoGraph: string;
  readonly audioGraph: string | null;
  readonly output: string;
}

/** The arguments of D29.4, in order. The only file they name is the output. */
export function encoderArgs(options: EncoderArgsOptions): string[] {
  const fps = String(options.fps);
  const audio = options.audioGraph;
  return [
    ...['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1'],
    ...['-f', 'image2pipe', '-c:v', 'png', '-framerate', fps, '-i', 'pipe:0'],
    ...(audio === null ? [] : ['-i', 'pipe:3']),
    '-filter_complex_threads',
    '1',
    '-filter_complex',
    audio === null ? options.videoGraph : `${options.videoGraph};${audio}`,
    ...['-map', '[v]', ...(audio === null ? [] : ['-map', '[a]'])],
    ...['-fps_mode', 'passthrough'],
    ...['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'],
    ...['-profile:v', 'high', '-level:v', '4.0', '-pix_fmt', 'yuv420p', '-threads', '1'],
    ...['-color_primaries', 'bt709', '-color_trc', 'bt709'],
    ...['-colorspace', 'bt709', '-color_range', 'tv'],
    ...['-video_track_timescale', String(options.fps * TIME_SCALE_PER_FRAME)],
    ...(audio === null
      ? []
      : ['-c:a', AUDIO_CODEC, '-b:a', AUDIO_BITRATE, '-ar', String(SAMPLE_RATE), '-ac', '2']),
    ...['-map_metadata', '-1', '-map_chapters', '-1'],
    ...['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'],
    ...['-movflags', '+faststart', '-f', 'mp4', '-y', options.output],
    ...['-map', '0:v', '-c:v', 'copy', '-f', 'framehash', '-hash', 'sha256', 'pipe:1'],
  ];
}

/**
 * The SHA-256 of every packet FFmpeg read, from its `framehash` output (D29.3),
 * in the manifest's format. A line that is neither a comment nor a packet is
 * an error, so a changed format cannot pass as an empty receipt. The format of
 * the pinned build, measured: `0, <dts>, <pts>, <duration>, <size>, <hex>`.
 */
export function receiptHashes(text: string): string[] {
  const hashes: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^0,\s*-?\d+,\s*-?\d+,\s*\d+,\s*\d+,\s*([0-9a-f]{64})$/.exec(trimmed);
    if (match === null) {
      throw new ProducerError(
        'encode-failed',
        `FFmpeg printed an unexpected receipt line: ${trimmed}`,
      );
    }
    hashes.push(`sha256:${match[1] ?? ''}`);
  }
  return hashes;
}

/** At most this many frames are written but not yet handed to the pipe (D29.3). */
export const FRAMES_IN_FLIGHT = 2;

/** A host timer, lent so that tests control it. */
export type StartTimer = (expire: () => void, milliseconds: number) => () => void;

export const realTimer: StartTimer = (expire, milliseconds) => {
  const timer = setTimeout(expire, milliseconds);
  return () => {
    clearTimeout(timer);
  };
};

/**
 * Writes frames to a stream with a bounded window (D29.3): a frame is in
 * flight from `write` until the stream's callback reports it handed on, and
 * `write` resolves only once the frame is inside a window of
 * `FRAMES_IN_FLIGHT`. A window that does not open in time, a stream error, or
 * a failed write rejects with `encode-failed`, and so does every call after it.
 */
export class FrameSink {
  #inFlight = 0;
  #maxInFlight = 0;
  #written = 0;
  #failure: ProducerError | null = null;
  #waiters: (() => void)[] = [];
  readonly #stream: Writable;
  readonly #timeoutMs: number;
  readonly #startTimer: StartTimer;

  constructor(stream: Writable, timeoutMs: number, startTimer: StartTimer = realTimer) {
    this.#stream = stream;
    this.#timeoutMs = timeoutMs;
    this.#startTimer = startTimer;
    stream.on('error', (reason: unknown) => {
      this.#fail(`FFmpeg stopped reading frames: ${String(reason)}`);
    });
  }

  /** The largest number of frames that were in flight at once. */
  get maxInFlight(): number {
    return this.#maxInFlight;
  }

  /** How many frames were accepted into the window. */
  get written(): number {
    return this.#written;
  }

  #fail(message: string): void {
    this.#failure ??= new ProducerError('encode-failed', message);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async #window(limit: number): Promise<void> {
    while (this.#failure === null && this.#inFlight > limit) {
      await new Promise<void>((resolve) => {
        const cancel = this.#startTimer(() => {
          this.#fail(`FFmpeg accepted no frame for ${String(this.#timeoutMs)} ms.`);
        }, this.#timeoutMs);
        this.#waiters.push(() => {
          cancel();
          resolve();
        });
      });
    }
    if (this.#failure !== null) throw this.#failure;
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.#window(FRAMES_IN_FLIGHT - 1);
    this.#inFlight += 1;
    this.#written += 1;
    this.#maxInFlight = Math.max(this.#maxInFlight, this.#inFlight);
    this.#stream.write(bytes, (reason) => {
      this.#inFlight -= 1;
      if (reason) this.#fail(`A frame could not be written: ${String(reason)}`);
      for (const wake of this.#waiters.splice(0)) wake();
    });
  }

  /** Waits until every frame is handed on, then ends the stream. */
  async end(): Promise<void> {
    await this.#window(0);
    this.#stream.end();
  }
}
