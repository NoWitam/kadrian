/**
 * The installation of the pinned FFmpeg build (D29.1), without the network and
 * the processes, which the caller injects: `tests/pinned/fetch-ffmpeg.ts` passes
 * the real ones, `ffmpeg-install.test.ts` fakes them.
 *
 * The first CI run failed here (owner, 2026-09-24): the pinned Playwright image
 * has no `xz`, so `tar -xJf` could not decompress the archive, and GNU tar run
 * as root tries to give the files the archive's owner (uid 1001), which fails
 * where root cannot. Hence, in this order:
 *
 * 1. The archive must hash to its pin before anything reads it.
 * 2. It is decompressed by `xz -dc` if `xz` runs, otherwise by Python's `lzma`
 *    (`python3` is in the pinned image, pinned by its digest); with neither,
 *    the installation fails with `no-decompressor`.
 * 3. The stream goes to `tar -x -f - --no-same-owner`, both processes started by
 *    `spawn`, never through a shell; both must exit 0.
 * 4. Only `bin/ffmpeg`, `bin/ffprobe`, and `LICENSE.txt` are extracted, into a
 *    staging directory next to the target.
 * 5. Both binaries must hash to their pins; only then is the staging directory
 *    renamed to the target. Any failure removes the staging directory. A run
 *    killed between the removal of an old target and the rename can leave a
 *    partial one behind, but it is never accepted: see below.
 *
 * A published target is reused only when both binaries still hash to their
 * pins and `LICENSE.txt` is there, so running the script again is safe. Names
 * are relative to the cache directory, because GNU tar takes the `G:` of a
 * Windows path for a remote host; the flags work with Windows' own `tar.exe`
 * (bsdtar) as well.
 *
 * Node built-ins only, so `fetch-ffmpeg.ts` can run it with
 * `--experimental-strip-types`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

export const FFMPEG_INSTALL_ERROR_CODES = Object.freeze([
  'download-failed',
  'archive-hash-mismatch',
  'no-decompressor',
  'extract-failed',
  'binary-hash-mismatch',
] as const);

export type FfmpegInstallErrorCode = (typeof FFMPEG_INSTALL_ERROR_CODES)[number];

export class FfmpegInstallError extends Error {
  readonly code: FfmpegInstallErrorCode;

  constructor(code: FfmpegInstallErrorCode, message: string) {
    super(message);
    this.name = 'FfmpegInstallError';
    this.code = code;
  }
}

export interface Decompressor {
  readonly name: 'xz' | 'python3';
  readonly command: string;
  /** How to find out whether it runs: exit 0 means it does. */
  readonly probe: readonly string[];
  /** Decompresses `archive` to standard output. */
  args(archive: string): string[];
}

/**
 * Streams an .xz file to standard output. `-I` isolates Python from the
 * environment and the working directory, which could otherwise shadow `lzma`.
 */
export const PYTHON_LZMA_SCRIPT =
  'import lzma, shutil, sys\nwith lzma.open(sys.argv[1]) as source:\n    shutil.copyfileobj(source, sys.stdout.buffer)';

export const XZ: Decompressor = Object.freeze({
  name: 'xz',
  command: 'xz',
  probe: Object.freeze(['--version']),
  args: (archive: string) => ['-dc', archive],
});

export const PYTHON_LZMA: Decompressor = Object.freeze({
  name: 'python3',
  command: 'python3',
  probe: Object.freeze(['-I', '-c', 'import lzma']),
  args: (archive: string) => ['-I', '-c', PYTHON_LZMA_SCRIPT, archive],
});

/** Whether `command args` ran and exited 0; a missing command or a signal is `false`. */
export type Probe = (command: string, args: readonly string[]) => boolean;

/** `xz` if it runs, otherwise Python's `lzma`, otherwise a typed error. */
export function chooseDecompressor(probe: Probe): Decompressor {
  for (const candidate of [XZ, PYTHON_LZMA]) {
    if (probe(candidate.command, candidate.probe)) return candidate;
  }
  throw new FfmpegInstallError(
    'no-decompressor',
    'Neither `xz` nor `python3` with its `lzma` module runs here, so the .tar.xz archive cannot be decompressed.',
  );
}

/** The members of the archive that are extracted, and nothing else. */
export function archiveMembers(asset: string): string[] {
  const root = asset.replace(/\.tar\.xz$/, '');
  return [`${root}/bin/ffmpeg`, `${root}/bin/ffprobe`, `${root}/LICENSE.txt`];
}

/** `tar` reads the decompressed stream and never restores the archive's owner. */
export function tarArguments(staging: string, asset: string): string[] {
  return [
    '-x',
    '-f',
    '-',
    '--no-same-owner',
    '-C',
    staging,
    '--strip-components=1',
    ...archiveMembers(asset),
  ];
}

/** The part of a child process that the extraction uses. */
export interface SpawnedProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  kill(): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): this;
}

export type Spawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly stdio: readonly ['ignore' | 'pipe', 'pipe' | 'inherit', 'inherit'];
  },
) => SpawnedProcess;

/**
 * Runs `decompressor | tar` without a shell. Resolves only when both processes
 * have closed with exit code 0; otherwise rejects with `extract-failed`, naming
 * each process that failed.
 */
export function extractArchive(
  spawn: Spawn,
  decompressor: Decompressor,
  archive: string,
  tarArgs: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const failures: string[] = [];
    const closed = new Set<string>();
    const settle = (name: string, failure: string | null): void => {
      if (closed.has(name)) return;
      closed.add(name);
      if (failure !== null) failures.push(failure);
      if (closed.size < 2) return;
      if (failures.length === 0) resolve();
      else {
        reject(
          new FfmpegInstallError(
            'extract-failed',
            `The archive could not be extracted: ${failures.join('; ')}.`,
          ),
        );
      }
    };
    const outcome = (name: string, code: number | null, signal: string | null): string | null =>
      code === 0
        ? null
        : `${name} exited with ${code === null ? `signal ${String(signal)}` : String(code)}`;

    let source: SpawnedProcess;
    let sink: SpawnedProcess;
    try {
      source = spawn(decompressor.command, decompressor.args(archive), {
        cwd,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    } catch (reason) {
      reject(
        new FfmpegInstallError(
          'extract-failed',
          `${decompressor.command} could not start: ${reason instanceof Error ? reason.message : String(reason)}.`,
        ),
      );
      return;
    }
    try {
      sink = spawn('tar', tarArgs, { cwd, stdio: ['pipe', 'inherit', 'inherit'] });
    } catch (reason) {
      source.kill();
      reject(
        new FfmpegInstallError(
          'extract-failed',
          `tar could not start: ${reason instanceof Error ? reason.message : String(reason)}.`,
        ),
      );
      return;
    }

    source.on('error', (error) => {
      // The decompressor never started: tar must see the end of its input.
      sink.stdin?.end();
      settle(decompressor.command, `${decompressor.command} failed: ${error.message}`);
    });
    source.on('close', (code, signal) => {
      settle(decompressor.command, outcome(decompressor.command, code, signal));
    });
    sink.on('error', (error) => {
      source.kill();
      settle('tar', `tar failed: ${error.message}`);
    });
    // Once tar is gone, nothing reads the pipe: a decompressor with output left
    // would block on it for ever. So the rest is drained (and, after a failure,
    // the decompressor is stopped), and the exit codes decide.
    const drain = (): void => {
      source.stdout?.unpipe();
      source.stdout?.resume();
    };
    sink.on('close', (code, signal) => {
      drain();
      if (code !== 0) source.kill();
      settle('tar', outcome('tar', code, signal));
    });
    // Node may report a tar that stopped reading as EPIPE before it closes.
    sink.stdin?.on('error', drain);
    if (source.stdout !== null && sink.stdin !== null) source.stdout.pipe(sink.stdin);
    else sink.stdin?.end();
  });
}

export interface InstallOptions {
  /** The cache directory, `.kadrion-cache/ffmpeg/`. */
  readonly cache: string;
  readonly asset: string;
  readonly release: string;
  readonly archiveSha256: string;
  readonly ffmpegSha256: string;
  readonly ffprobeSha256: string;
  /** The archive's bytes from the network; called only when no archive is cached. */
  download(): Promise<Uint8Array>;
  readonly probe: Probe;
  readonly spawn: Spawn;
  readonly log: (line: string) => void;
}

export interface Installed {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  /** Whether a verified installation was already there. */
  readonly reused: boolean;
  readonly decompressor: Decompressor['name'] | null;
}

function sha256(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Whether `directory` holds both pinned binaries, each with its pinned hash, and the licence. */
function verified(directory: string, options: InstallOptions): boolean {
  const ffmpeg = join(directory, 'bin', 'ffmpeg');
  const ffprobe = join(directory, 'bin', 'ffprobe');
  return (
    existsSync(ffmpeg) &&
    existsSync(ffprobe) &&
    existsSync(join(directory, 'LICENSE.txt')) &&
    sha256(ffmpeg) === options.ffmpegSha256 &&
    sha256(ffprobe) === options.ffprobeSha256
  );
}

/** A verified archive in the cache: downloaded if missing, and never kept with another hash. */
async function verifiedArchive(options: InstallOptions): Promise<void> {
  const archive = join(options.cache, options.asset);
  if (existsSync(archive)) {
    const found = sha256(archive);
    if (found !== options.archiveSha256) {
      // It can never be used; the next run downloads it again.
      rmSync(archive, { force: true });
      throw new FfmpegInstallError(
        'archive-hash-mismatch',
        `The cached ${options.asset} has ${found}, not ${options.archiveSha256}; it was removed.`,
      );
    }
    return;
  }
  const part = `${archive}.part`;
  try {
    let bytes: Uint8Array;
    try {
      bytes = await options.download();
    } catch (reason) {
      if (reason instanceof FfmpegInstallError) throw reason;
      throw new FfmpegInstallError(
        'download-failed',
        `The download failed: ${reason instanceof Error ? reason.message : String(reason)}.`,
      );
    }
    const found = sha256Of(bytes);
    if (found !== options.archiveSha256) {
      throw new FfmpegInstallError(
        'archive-hash-mismatch',
        `The downloaded ${options.asset} has ${found}, not ${options.archiveSha256}.`,
      );
    }
    writeFileSync(part, bytes);
    renameSync(part, archive);
  } finally {
    rmSync(part, { force: true });
  }
}

/** Installs the pinned FFmpeg into `<cache>/<release>`, or reuses a verified installation. */
export async function installFfmpeg(options: InstallOptions): Promise<Installed> {
  const target = join(options.cache, options.release);
  const stagingName = `.staging-${options.release}`;
  const staging = join(options.cache, stagingName);
  const paths = {
    ffmpeg: join(target, 'bin', 'ffmpeg'),
    ffprobe: join(target, 'bin', 'ffprobe'),
  };
  mkdirSync(options.cache, { recursive: true });
  // A staging directory of an earlier run that did not finish is never used.
  rmSync(staging, { recursive: true, force: true });
  try {
    if (existsSync(target) && verified(target, options)) {
      options.log(`Already installed and verified: ${target}`);
      return { ...paths, reused: true, decompressor: null };
    }
    await verifiedArchive(options);
    const decompressor = chooseDecompressor(options.probe);
    options.log(`Extracting with ${decompressor.name}`);
    mkdirSync(staging);
    await extractArchive(
      options.spawn,
      decompressor,
      options.asset,
      tarArguments(stagingName, options.asset),
      options.cache,
    );
    for (const [name, pin] of [
      ['ffmpeg', options.ffmpegSha256],
      ['ffprobe', options.ffprobeSha256],
    ] as const) {
      const path = join(staging, 'bin', name);
      const found = existsSync(path) ? sha256(path) : 'nothing';
      if (found !== pin) {
        throw new FfmpegInstallError(
          'binary-hash-mismatch',
          `bin/${name} of the archive has ${found}, not ${pin}.`,
        );
      }
    }
    if (!existsSync(join(staging, 'LICENSE.txt'))) {
      throw new FfmpegInstallError('extract-failed', 'The archive gave no LICENSE.txt.');
    }
    // Publish: an old or unverified target goes first, then one rename.
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return { ...paths, reused: false, decompressor: decompressor.name };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
