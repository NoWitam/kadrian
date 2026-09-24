/**
 * The command line of D28.8 and D29.10:
 *
 *   kadrion render-frames --composition <file> --assets <file> --out <dir> --times <t,…>
 *   kadrion export --composition <file> --assets <file> --out <dir> --preset <1080p|720p>
 *                  [--ffmpeg <path>] [--ffprobe <path>]
 *
 * `render-frames` renders frame times of a composition to `frame-<index>.png` and
 * writes `render-manifest.json`. `export` writes `video-<preset>.mp4` and
 * `video-<preset>.render-manifest.json` with the pinned FFmpeg, whose paths come
 * from the flags or from `KADRION_FFMPEG` and `KADRION_FFPROBE`, never from
 * `PATH` (D29.1). The asset file maps asset IDs to `{ path, mediaType }`,
 * with paths relative to that file: where bytes live is the host's business,
 * never the document's (D14). The CLI knows no golden timestamp (D12).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import {
  exportMp4,
  ProducerError,
  renderFrames,
  type ExportRequest,
  type ExportResult,
  type RenderRequest,
  type RenderResult,
} from '@kadrion/producer';

export const EXIT_OK = 0;
export const EXIT_PRODUCER_ERROR = 1;
export const EXIT_USAGE = 2;

export const USAGE = [
  'Usage: kadrion render-frames --composition <file> --assets <file> --out <dir> --times <t,...>',
  '       kadrion export --composition <file> --assets <file> --out <dir> --preset <1080p|720p> [--ffmpeg <path>] [--ffprobe <path>]',
].join('\n');

/** Where `kadrion export` finds the pinned executables without flags (D29.10). */
export const FFMPEG_VARIABLE = 'KADRION_FFMPEG';
export const FFPROBE_VARIABLE = 'KADRION_FFPROBE';

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export type Render = (request: RenderRequest) => Promise<RenderResult>;
export type Export = (request: ExportRequest) => Promise<ExportResult>;

/** What the commands run on; tests replace them. */
export interface CliHosts {
  readonly render: Render;
  readonly exportMp4: Export;
  readonly env: Readonly<Record<string, string | undefined>>;
}

class UsageError extends Error {}

interface AssetEntry {
  readonly path: string;
  readonly mediaType: string;
}

/** The asset map: an object of `{ path, mediaType }` entries, nothing else. */
export function parseAssetMap(text: string): ReadonlyMap<string, AssetEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('The asset file is not JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('The asset file must map asset IDs to { path, mediaType }.');
  }
  const entries = new Map<string, AssetEntry>();
  for (const [id, value] of Object.entries(parsed)) {
    const entry = value as Partial<Record<string, unknown>> | null;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Object.keys(entry).sort().join(',') !== 'mediaType,path' ||
      typeof entry.path !== 'string' ||
      entry.path === '' ||
      typeof entry.mediaType !== 'string'
    ) {
      throw new UsageError(`The asset "${id}" must be { path, mediaType }.`);
    }
    entries.set(id, { path: entry.path, mediaType: entry.mediaType });
  }
  return entries;
}

/** Times as written: comma-separated non-negative integers, in the order given. */
export function parseTimes(text: string): number[] {
  const parts = text.split(',');
  if (parts.some((part) => !/^\d+$/.test(part))) {
    throw new UsageError('--times takes comma-separated integer microseconds, such as 0,2500000.');
  }
  return parts.map(Number);
}

/** `frame-000075.png`: six digits hold every frame index of the spike's durations. */
export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(6, '0')}.png`;
}

/** The document and a resolver over the asset file (D14): shared by both commands. */
async function readInputs(
  composition: string,
  assets: string,
): Promise<{ readonly document: unknown; readonly resolveAsset: RenderRequest['resolveAsset'] }> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(composition, 'utf8'));
  } catch (reason) {
    throw new UsageError(`Cannot read the composition: ${String(reason)}`);
  }
  const assetFile = resolve(assets);
  let assetText: string;
  try {
    assetText = await readFile(assetFile, 'utf8');
  } catch (reason) {
    throw new UsageError(`Cannot read the asset file: ${String(reason)}`);
  }
  const map = parseAssetMap(assetText);
  return {
    document,
    resolveAsset: async ({ id }) => {
      const entry = map.get(id);
      if (entry === undefined) return null;
      const bytes = await readFile(resolve(dirname(assetFile), entry.path));
      return { bytes: new Uint8Array(bytes), mediaType: entry.mediaType };
    },
  };
}

async function renderCommand(args: readonly string[], io: CliIo, render: Render): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      composition: { type: 'string' },
      assets: { type: 'string' },
      out: { type: 'string' },
      times: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const { composition, assets, out, times } = values;
  if (
    composition === undefined ||
    assets === undefined ||
    out === undefined ||
    times === undefined
  ) {
    throw new UsageError('--composition, --assets, --out, and --times are required.');
  }
  const timesUs = parseTimes(times);
  const inputs = await readInputs(composition, assets);
  const result = await render({ ...inputs, timesUs });
  await mkdir(out, { recursive: true });
  for (const frame of result.frames) {
    await writeFile(join(out, frameFileName(frame.index)), frame.png);
  }
  await writeFile(
    join(out, 'render-manifest.json'),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
  );
  for (const frame of result.manifest.frames) {
    io.out(`${frameFileName(frame.index)} ${String(frame.timeUs)} ${frame.sha256}`);
  }
  io.out(`render-manifest.json runtime ${result.manifest.runtime.contentHash}`);
  return EXIT_OK;
}

/** `video-1080p.mp4`, and its manifest next to it (D29.10). */
export function exportFileNames(preset: string): {
  readonly video: string;
  readonly manifest: string;
} {
  return { video: `video-${preset}.mp4`, manifest: `video-${preset}.render-manifest.json` };
}

async function exportCommand(args: readonly string[], io: CliIo, hosts: CliHosts): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      composition: { type: 'string' },
      assets: { type: 'string' },
      out: { type: 'string' },
      preset: { type: 'string' },
      ffmpeg: { type: 'string' },
      ffprobe: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const { composition, assets, out, preset } = values;
  if (
    composition === undefined ||
    assets === undefined ||
    out === undefined ||
    preset === undefined
  ) {
    throw new UsageError('--composition, --assets, --out, and --preset are required.');
  }
  if (!/^[0-9a-z]+$/.test(preset)) throw new UsageError('--preset takes a name such as 1080p.');
  // Flags first, then the environment; never PATH. The Producer requires absolute paths.
  const ffmpegPath = values.ffmpeg ?? hosts.env[FFMPEG_VARIABLE];
  const ffprobePath = values.ffprobe ?? hosts.env[FFPROBE_VARIABLE];
  if (ffmpegPath === undefined || ffprobePath === undefined) {
    throw new ProducerError(
      'ffmpeg-missing',
      `Give --ffmpeg and --ffprobe, or set ${FFMPEG_VARIABLE} and ${FFPROBE_VARIABLE}; PATH is never searched.`,
    );
  }
  const inputs = await readInputs(composition, assets);
  await mkdir(out, { recursive: true });
  const names = exportFileNames(preset);
  const result = await hosts.exportMp4({
    ...inputs,
    preset,
    outputPath: join(out, names.video),
    ffmpeg: { ffmpegPath, ffprobePath },
  });
  await writeFile(join(out, names.manifest), `${JSON.stringify(result.manifest, null, 2)}\n`);
  io.out(
    `${names.video} ${String(result.manifest.frames.length)} frames ${result.manifest.preset.name} ffmpeg ${result.manifest.ffmpeg.version}`,
  );
  io.out(`${names.manifest} runtime ${result.manifest.runtime.contentHash}`);
  return EXIT_OK;
}

/** Runs the CLI and returns its exit code; nothing here calls `process.exit`. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  hosts: Partial<CliHosts> = {},
): Promise<number> {
  const [command, ...rest] = argv;
  const given: CliHosts = {
    render: hosts.render ?? renderFrames,
    exportMp4: hosts.exportMp4 ?? exportMp4,
    env: hosts.env ?? process.env,
  };
  try {
    if (command === 'render-frames') return await renderCommand(rest, io, given.render);
    if (command === 'export') return await exportCommand(rest, io, given);
    throw new UsageError(USAGE);
  } catch (reason) {
    if (reason instanceof ProducerError) {
      io.err(`error ${reason.code}: ${reason.message}`);
      return EXIT_PRODUCER_ERROR;
    }
    if (
      reason instanceof UsageError ||
      String((reason as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS_')
    ) {
      io.err((reason as Error).message);
      if ((reason as Error).message !== USAGE) io.err(USAGE);
      return EXIT_USAGE;
    }
    throw reason;
  }
}
