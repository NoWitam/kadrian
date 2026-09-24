/**
 * The render manifest (specification §8, D28.7): what makes "pinned"
 * observable. It holds no wall-clock value, so the manifest of a render is as
 * reproducible as its frames.
 */
import { createHash } from 'node:crypto';

import type { EnvironmentManifest } from './environment.js';

/** 2 since PR-07: `environment.network` (D28.9) and the export manifest (D29.9). */
export const MANIFEST_VERSION = 2;

/** `sha256:` and 64 lowercase hex digits of the bytes, the format of D14. */
export function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * JSON with object keys sorted by UTF-16 code units, arrays in order, and no
 * whitespace; numbers and strings as `JSON.stringify` writes them. A validated
 * document holds only JSON values (D16), so this is total over it.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  // `undefined` for a function, a symbol, or `undefined`, which no JSON document holds.
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError('A document holds JSON values only.');
  return text;
}

export interface ManifestAsset {
  readonly id: string;
  readonly type: string;
  readonly mediaType: string;
  readonly contentHash: string;
  /** The family a font is registered under (D22.6, D27.1). */
  readonly family?: string;
}

export interface ManifestFrame {
  readonly index: number;
  readonly timeUs: number;
  /** SHA-256 of the PNG bytes of the frame. */
  readonly sha256: string;
}

export interface RenderManifest {
  readonly manifestVersion: number;
  readonly compositionHash: string;
  readonly schemaVersion: string;
  readonly runtime: {
    readonly contentHash: string;
    readonly bundler: string;
    readonly compiler: string;
  };
  readonly chromium: {
    readonly playwrightCore: string;
    readonly revision: string;
    readonly expectedVersion: string;
    readonly reportedVersion: string;
    readonly channel: string;
    readonly args: readonly string[];
  };
  readonly environment: EnvironmentManifest;
  readonly assets: readonly ManifestAsset[];
  readonly preset: {
    readonly name: 'frames-png';
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly deviceScaleFactor: number;
  };
  readonly durationUs: number;
  /** Frames of the composition, not of this render (D13.2). */
  readonly frameCount: number;
  readonly frames: readonly ManifestFrame[];
  /**
   * What Custom HTML frames tried to load: blocked by the page policy and aborted
   * by the Producer, recorded without failing the render (D28.1).
   */
  readonly blockedRequests: readonly string[];
  /** A render of frames runs no FFmpeg; an export records it (D29.9). */
  readonly ffmpeg: null;
}

/** The pinned FFmpeg of an export and what it was asked to do (D29.1, D29.4). */
export interface ManifestFfmpeg {
  readonly release: string;
  readonly asset: string;
  readonly url: string;
  readonly archiveSha256: string;
  readonly ffmpegSha256: string;
  readonly ffprobeSha256: string;
  readonly version: string;
  readonly configuration: string;
  readonly encoders: readonly string[];
  /** The arguments, with the output path written as `<output>`. */
  readonly args: readonly string[];
}

/** The audio mux of D29.6, in samples at 48 kHz. */
export interface ManifestAudio {
  readonly clipId: string;
  readonly assetId: string;
  readonly sampleRate: number;
  readonly startSample: number;
  readonly sampleCount: number;
  readonly totalSamples: number;
  readonly channelLayout: string;
  readonly codec: string;
  readonly bitrate: string;
}

/** The one block that names the render environment (D29.9). */
export interface RenderIdentity {
  /** The digest of the declared pinned image (D26.2), or `null` when the run is not pinned. */
  readonly playwrightImageDigest: string | null;
  readonly playwrightVersion: string;
  readonly chromiumRevision: string;
  readonly ffmpegSha256: string;
  readonly ffprobeSha256: string;
  readonly ffmpegVersion: string;
  readonly ffmpegBuildConfiguration: string;
}

/** The manifest of an MP4 export (D29.9): the render manifest with FFmpeg, audio, and identity. */
export interface ExportManifest extends Omit<RenderManifest, 'preset' | 'ffmpeg'> {
  readonly preset: {
    readonly name: 'mp4-1080p' | 'mp4-720p';
    readonly width: number;
    readonly height: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly fps: number;
    readonly deviceScaleFactor: number;
    readonly videoGraph: string;
  };
  readonly ffmpeg: ManifestFfmpeg;
  readonly audio: ManifestAudio | null;
  readonly identity: RenderIdentity;
}
