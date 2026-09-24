/**
 * @kadrion/cli — local rendering and diagnostics.
 *
 * `runCli` implements `kadrion render-frames` (D28.8) and `kadrion export` (D29.10)
 * on top of the Producer's `renderFrames` and `exportMp4`; `bin.ts` is the
 * executable.
 */
export {
  EXIT_OK,
  EXIT_PRODUCER_ERROR,
  EXIT_USAGE,
  exportFileNames,
  FFMPEG_VARIABLE,
  FFPROBE_VARIABLE,
  frameFileName,
  parseAssetMap,
  parseTimes,
  runCli,
  USAGE,
} from './cli.js';
export type { CliHosts, CliIo, Export, Render } from './cli.js';
