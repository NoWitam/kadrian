/**
 * The MP4 export (D29): every frame of the grid, rendered by the frame loop of
 * `renderFrames` (D29.3), goes as PNG bytes straight into the pinned FFmpeg,
 * which encodes H.264 in MP4 and muxes the audio clip. At most one rendered
 * frame and `FRAMES_IN_FLIGHT` written frames exist at any time; no frame is
 * ever written to a file. Everything that can be checked before the page opens
 * is checked first, and every failure kills FFmpeg and removes the output.
 */
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';

import type { AssetResolver } from '@kadrion/renderer-dom';
import { frameCount, frameToTimeUs } from '@kadrion/schema';

import {
  AUDIO_BITRATE,
  AUDIO_CHANNEL_LAYOUT,
  AUDIO_CODEC,
  audioGraph,
  audioPlan,
  encoderArgs,
  FrameSink,
  OUTPUT_PLACEHOLDER,
  presetSize,
  realTimer,
  receiptHashes,
  SAMPLE_RATE,
  TIME_SCALE_PER_FRAME,
  type StartTimer,
  videoGraph,
} from './encode.js';
import {
  CHROMIUM_REVISION,
  hostNetworkInterfaces,
  launchChromium,
  PLAYWRIGHT_CORE_VERSION,
  type LaunchedChromium,
} from './environment.js';
import { asProducerError, ProducerError } from './errors.js';
import {
  FFMPEG_ARCHIVE_SHA256,
  FFMPEG_ASSET,
  FFMPEG_RELEASE,
  FFMPEG_URL,
  pinnedFfmpeg,
  type EncoderProcess,
  type FfmpegPaths,
  type FfmpegTools,
} from './ffmpeg.js';
import { sha256, type ExportManifest, type ManifestFrame } from './manifest.js';
import {
  chromiumSequence,
  manifestBase,
  validated,
  verifiedAssets,
  type FrameSequence,
  type GridFrame,
  type PreparedRender,
  type RenderTimeouts,
} from './render.js';
import { loadRuntimeBuild, type RuntimeBuild } from './runtime.js';

export interface ExportRequest extends RenderTimeouts {
  readonly document: unknown;
  readonly resolveAsset: AssetResolver;
  /** `1080p` or `720p` (D29.5). */
  readonly preset: string;
  /** Where FFmpeg writes the MP4; removed again when the export fails. */
  readonly outputPath: string;
  /** Absolute paths of the pinned executables (D29.1); `PATH` is never searched. */
  readonly ffmpeg: FfmpegPaths;
  /** A browser from `launchChromium` to reuse; otherwise one is launched and closed. */
  readonly chromium?: LaunchedChromium;
  readonly runtime?: RuntimeBuild;
  /** How long FFmpeg may take to accept a frame, and to finish after the last one. */
  readonly encoderTimeoutMs?: number;
}

export interface ExportStats {
  /** Frames accepted into the window of D29.3. */
  readonly framesWritten: number;
  /** The most frames that were in flight at once; never above `FRAMES_IN_FLIGHT`. */
  readonly maxFramesInFlight: number;
}

export interface ExportResult {
  readonly outputPath: string;
  readonly manifest: ExportManifest;
  readonly stats: ExportStats;
}

/** A browser for one export: its frame loop, and how to let it go. */
export interface ExportBrowser {
  readonly chromium: LaunchedChromium;
  readonly sequence: FrameSequence;
  close(): Promise<void>;
}

/** What `exportMp4` runs on; tests pass fakes (not exported by the package). */
export interface ExportDependencies {
  readonly tools: (paths: FfmpegPaths) => Promise<FfmpegTools>;
  readonly browser: (request: ExportRequest) => Promise<ExportBrowser>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly startTimer: StartTimer;
  /** The host's interface names for the manifest (D28.9); `exportMp4` reads the host. */
  readonly networkInterfaces: () => readonly string[];
}

function encodeFailed(message: string): ProducerError {
  return new ProducerError('encode-failed', message);
}

/** Every frame of the grid, one at a time: nothing is kept (D29.3). */
function* grid(fps: number, count: number): Generator<GridFrame> {
  for (let index = 0; index < count; index += 1) yield { index, timeUs: frameToTimeUs(index, fps) };
}

/** Writes the audio bytes and ends the pipe. FFmpeg may stop reading once it has what it needs. */
function writeAudio(stream: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    stream.on('error', (reason: NodeJS.ErrnoException) => {
      // FFmpeg closes the audio pipe once its filters have every sample they need.
      if (reason.code === 'EPIPE' || reason.code === 'ECONNRESET') resolveWrite();
      else reject(encodeFailed(`The audio could not be written: ${String(reason)}`));
    });
    stream.end(bytes, () => {
      resolveWrite();
    });
  });
}

function within<T>(
  work: Promise<T>,
  milliseconds: number,
  startTimer: StartTimer,
  what: string,
): Promise<T> {
  return new Promise<T>((resolveWork, reject) => {
    const cancel = startTimer(() => {
      reject(encodeFailed(`FFmpeg did not ${what} within ${String(milliseconds)} ms.`));
    }, milliseconds);
    work.then(
      (value) => {
        cancel();
        resolveWork(value);
      },
      (reason: unknown) => {
        cancel();
        reject(asProducerError(reason));
      },
    );
  });
}

/** The audio of the document, checked with the pinned ffprobe before the render (D29.6). */
async function checkedAudio(
  prepared: PreparedRender,
  tools: FfmpegTools,
): Promise<{
  readonly plan: NonNullable<ReturnType<typeof audioPlan>>;
  readonly bytes: Uint8Array;
} | null> {
  const plan = audioPlan(prepared.composition);
  if (plan === null) return null;
  const asset = prepared.assets.find(({ id }) => id === plan.assetId);
  if (asset === undefined) {
    throw new ProducerError('audio-invalid', `The audio asset "${plan.assetId}" was not resolved.`);
  }
  const probe = await tools.probeAudio(asset.bytes);
  if (probe.audioStreams !== 1) {
    throw new ProducerError(
      'audio-invalid',
      `The audio asset "${plan.assetId}" has ${String(probe.audioStreams)} audio streams, not 1.`,
    );
  }
  if (probe.sampleRate === null) {
    throw new ProducerError(
      'audio-invalid',
      `The audio asset "${plan.assetId}" has no sample rate that ffprobe could read.`,
    );
  }
  if (plan.audibleUs === 0) {
    throw new ProducerError(
      'audio-invalid',
      `The clip "${plan.clipId}" starts at or after the end of the composition, so none of it would be heard; silence is not an export.`,
    );
  }
  if (probe.samples * 1_000_000n < BigInt(plan.audibleUs) * BigInt(probe.sampleRate)) {
    throw new ProducerError(
      'audio-invalid',
      `The audio asset "${plan.assetId}" is shorter than the ${String(plan.audibleUs)} µs of its clip that are heard.`,
    );
  }
  return { plan, bytes: asset.bytes };
}

/** The export on the given dependencies; `exportMp4` passes the real ones. */
export async function exportWith(
  request: ExportRequest,
  dependencies: ExportDependencies,
): Promise<ExportResult> {
  const composition = validated(request.document);
  const size = presetSize(composition, request.preset);
  const assets = await verifiedAssets(composition, request.resolveAsset);
  const tools = await dependencies.tools(request.ffmpeg);
  const prepared: PreparedRender = {
    composition,
    assets,
    runtime: request.runtime ?? loadRuntimeBuild(),
  };
  const audio = await checkedAudio(prepared, tools);
  const outputPath = resolve(request.outputPath);
  const timeoutMs = request.encoderTimeoutMs ?? 30_000;
  const { fps } = composition;
  const count = frameCount(composition.durationUs, fps);
  const video = videoGraph(size);
  const args = encoderArgs({
    fps,
    videoGraph: video,
    audioGraph: audio === null ? null : audioGraph(audio.plan),
    output: outputPath,
  });
  const browser = await dependencies.browser(request);
  let encoder: EncoderProcess | null = null;
  try {
    encoder = tools.spawnEncoder(args, audio !== null);
    const sink = new FrameSink(encoder.video, timeoutMs, dependencies.startTimer);
    const audioWritten =
      audio === null || encoder.audio === null
        ? Promise.resolve()
        : writeAudio(encoder.audio, audio.bytes);
    // A rejection is picked up below; until then it must not count as unhandled.
    audioWritten.catch(() => undefined);
    const frames: ManifestFrame[] = [];
    const { blockedRequests } = await browser.sequence(
      prepared,
      grid(fps, count),
      async (frame) => {
        // The hash is of exactly the bytes that go into the pipe (D29.3).
        const bytes = frame.png;
        frames.push({ index: frame.index, timeUs: frame.timeUs, sha256: sha256(bytes) });
        await sink.write(bytes);
      },
    );
    await sink.end();
    await within(audioWritten, timeoutMs, dependencies.startTimer, 'read the audio');
    const exited = await within(encoder.exited, timeoutMs, dependencies.startTimer, 'finish');
    if (exited.code !== 0) {
      throw encodeFailed(`FFmpeg exited with ${String(exited.code)}: ${exited.stderr.trim()}`);
    }
    const received = receiptHashes(await encoder.receipt);
    const sent = frames.map(({ sha256: hash }) => hash);
    if (received.length !== sent.length || received.some((hash, index) => hash !== sent[index])) {
      throw encodeFailed(
        `FFmpeg read ${String(received.length)} frames that do not match the ${String(sent.length)} rendered ones.`,
      );
    }
    const packets = await tools.countVideoPackets(outputPath);
    if (packets !== count) {
      throw encodeFailed(`The MP4 holds ${String(packets)} video packets, not ${String(count)}.`);
    }
    // Frame i at i × 512 in the time base of 29.4: a dropped, repeated, or shifted
    // frame changes this list even when the count still matches.
    const timestamps = await tools.videoTimestamps(outputPath);
    const wanted = frames.map(({ index }) => index * TIME_SCALE_PER_FRAME);
    if (timestamps.length !== wanted.length || timestamps.some((pts, at) => pts !== wanted[at])) {
      throw encodeFailed(
        `The MP4 holds other presentation times than frames 0…${String(count - 1)} at ${String(TIME_SCALE_PER_FRAME)} each.`,
      );
    }
    const { identity } = tools;
    const base = manifestBase(prepared, browser.chromium, dependencies.networkInterfaces());
    const image = base.environment.pinned ? base.environment.image : null;
    const manifest: ExportManifest = {
      ...base,
      preset: {
        name: `mp4-${size.name}`,
        width: size.width,
        height: size.height,
        sourceWidth: composition.width,
        sourceHeight: composition.height,
        fps,
        deviceScaleFactor: 1,
        videoGraph: video,
      },
      frames,
      blockedRequests,
      ffmpeg: {
        release: FFMPEG_RELEASE,
        asset: FFMPEG_ASSET,
        url: FFMPEG_URL,
        archiveSha256: FFMPEG_ARCHIVE_SHA256,
        ffmpegSha256: identity.ffmpegSha256,
        ffprobeSha256: identity.ffprobeSha256,
        version: identity.version,
        configuration: identity.configuration,
        encoders: identity.encoders,
        args: args.map((arg) => (arg === outputPath ? OUTPUT_PLACEHOLDER : arg)),
      },
      audio:
        audio === null
          ? null
          : {
              clipId: audio.plan.clipId,
              assetId: audio.plan.assetId,
              sampleRate: SAMPLE_RATE,
              startSample: audio.plan.startSample,
              sampleCount: audio.plan.sampleCount,
              totalSamples: audio.plan.totalSamples,
              channelLayout: AUDIO_CHANNEL_LAYOUT,
              codec: AUDIO_CODEC,
              bitrate: AUDIO_BITRATE,
            },
      identity: {
        playwrightImageDigest:
          image === null ? null : (/@(sha256:[0-9a-f]{64})$/.exec(image)?.[1] ?? null),
        playwrightVersion: PLAYWRIGHT_CORE_VERSION,
        chromiumRevision: CHROMIUM_REVISION,
        ffmpegSha256: identity.ffmpegSha256,
        ffprobeSha256: identity.ffprobeSha256,
        ffmpegVersion: identity.version,
        ffmpegBuildConfiguration: identity.configuration,
      },
    };
    return {
      outputPath,
      manifest,
      stats: { framesWritten: sink.written, maxFramesInFlight: sink.maxInFlight },
    };
  } catch (reason) {
    if (encoder !== null) {
      encoder.kill();
      await encoder.exited;
    }
    // A failure to remove the partial output must not replace the reason for it.
    await dependencies.removeFile(outputPath).catch(() => undefined);
    throw asProducerError(reason);
  } finally {
    await browser.close();
  }
}

/**
 * Exports `document` as an H.264 MP4 at `preset` to `outputPath` with the
 * pinned FFmpeg (D29), and returns the export manifest of D29.9.
 */
export function exportMp4(request: ExportRequest): Promise<ExportResult> {
  return exportWith(request, {
    tools: (paths) => pinnedFfmpeg(paths),
    async browser(given) {
      const chromium = given.chromium ?? (await launchChromium());
      return {
        chromium,
        sequence: chromiumSequence(chromium, given),
        async close() {
          if (given.chromium === undefined) await chromium.browser.close();
        },
      };
    },
    removeFile: (path) => rm(path, { force: true }),
    startTimer: realTimer,
    networkInterfaces: () => hostNetworkInterfaces(),
  });
}
