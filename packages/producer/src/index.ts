/**
 * @kadrion/producer — Chromium/FFmpeg render orchestration.
 *
 * `renderFrames` renders frame times of a document to PNG in the pinned
 * Chromium and returns them with the render manifest (D26, D28). The launch,
 * the presentation barrier, and the capture are exported as well, because the
 * Player's browser test measures through exactly the same functions (D28.5).
 * `exportMp4` streams every frame of the grid into the pinned FFmpeg and writes an
 * H.264 MP4 with the audio clip muxed (D29). D26–D28 are accepted; D29 is
 * Proposed and may change until the project owner accepts it.
 */
export { PRODUCER_AGENT_SCRIPT } from './agent.js';
export { awaitPresented, captureFrame, presentationSessions } from './capture.js';
export type { PresentationSessions } from './capture.js';
export {
  CHROMIUM_ARGS,
  CHROMIUM_CHANNEL,
  CHROMIUM_REVISION,
  CHROMIUM_VERSION,
  DEVICE_SCALE_FACTOR,
  LOCALE,
  PINNED_IMAGE,
  PINNED_IMAGE_VARIABLE,
  PINNED_PLATFORM,
  PLAYWRIGHT_CORE_VERSION,
  TIMEZONE,
  contextOptions,
  environmentManifest,
  goldenRefusal,
  installedPlaywright,
  isPinned,
  launchChromium,
  networkFacts,
} from './environment.js';
export type {
  EnvironmentFacts,
  EnvironmentManifest,
  LaunchedChromium,
  NetworkFacts,
  LaunchOptions,
} from './environment.js';
export { ProducerError } from './errors.js';
export { exportMp4 } from './export.js';
export type { ExportRequest, ExportResult, ExportStats } from './export.js';
export {
  FFMPEG_ARCHIVE_SHA256,
  FFMPEG_ASSET,
  FFMPEG_RELEASE,
  FFMPEG_SHA256,
  FFMPEG_URL,
  FFPROBE_SHA256,
} from './ffmpeg.js';
export type { FfmpegPaths } from './ffmpeg.js';
export type { ProducerErrorCode } from './errors.js';
export { canonicalJson, MANIFEST_VERSION, sha256 } from './manifest.js';
export type {
  ExportManifest,
  ManifestAsset,
  ManifestAudio,
  ManifestFfmpeg,
  ManifestFrame,
  RenderIdentity,
  RenderManifest,
} from './manifest.js';
export { frameIndexOf, hostDocument, openRenderSession, renderFrames } from './render.js';
export type {
  RenderedFrame,
  RenderRequest,
  RenderResult,
  RenderSession,
  RenderSessionOptions,
  RenderTimeouts,
} from './render.js';
export { loadRuntimeBuild, verifiedScript } from './runtime.js';
export type { RuntimeBuild } from './runtime.js';
