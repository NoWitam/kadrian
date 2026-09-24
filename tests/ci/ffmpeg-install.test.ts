/**
 * The installation of the pinned FFmpeg (D29.1; owner, 2026-09-24), without a
 * network: the decompressor and `tar` are fakes that speak through the same
 * pipes, the download is a function, and the cache is a temporary directory.
 * Three paths: `xz`, Python's `lzma` when there is no `xz`, and neither. Every
 * failure must leave no staging directory and no target that could pass for an
 * installation. One block runs real processes, with `node` standing in for both
 * tools, because only a real pipe has backpressure: a decompressor with output
 * left must never block once `tar` is gone.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  archiveMembers,
  chooseDecompressor,
  extractArchive,
  FfmpegInstallError,
  installFfmpeg,
  PYTHON_LZMA,
  PYTHON_LZMA_SCRIPT,
  tarArguments,
  XZ,
  type InstallOptions,
  type Spawn,
  type SpawnedProcess,
} from './ffmpeg-install.js';

const ASSET = 'ffmpeg-n8.1.3-linux64-gpl-8.1.tar.xz';
const RELEASE = 'autobuild-2026-09-21-13-55';
const ROOT = 'ffmpeg-n8.1.3-linux64-gpl-8.1';
const STAGING = `.staging-${RELEASE}`;
const ARCHIVE = new TextEncoder().encode('the pinned archive');
const FFMPEG = 'the pinned ffmpeg';
const FFPROBE = 'the pinned ffprobe';

function hash(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** What the fake decompressor writes: the three members, as `tar` would find them. */
const STREAM = JSON.stringify({
  [`${ROOT}/bin/ffmpeg`]: FFMPEG,
  [`${ROOT}/bin/ffprobe`]: FFPROBE,
  [`${ROOT}/LICENSE.txt`]: 'GPL',
});

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: PassThrough | null;
  readonly stdout: PassThrough | null;
  killed = false;

  constructor(stdin: boolean, stdout: boolean) {
    super();
    this.stdin = stdin ? new PassThrough() : null;
    this.stdout = stdout ? new PassThrough() : null;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface Behaviour {
  /** What the decompressor writes; `STREAM` by default. */
  readonly stream?: string;
  readonly decompressorCode?: number;
  readonly tarCode?: number;
  /** Which process closes first when both finish. */
  readonly tarClosesFirst?: boolean;
  readonly decompressorSpawnError?: boolean;
  readonly tarSpawnError?: boolean;
  /** tar stops reading at once: its stdin fails with EPIPE, and it still exits. */
  readonly tarEpipe?: boolean;
  /** The bytes tar writes for bin/ffmpeg instead of the pinned ones. */
  readonly ffmpegBytes?: string;
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdio: readonly string[];
}

/** A `spawn` whose decompressor and tar exchange `STREAM` through a real pipe. */
function fakeSpawn(behaviour: Behaviour = {}): { spawn: Spawn; calls: Call[] } {
  const calls: Call[] = [];
  let finish: { decompressor?: () => void; tar?: () => void } = {};
  const ready = (): void => {
    if (finish.decompressor === undefined || finish.tar === undefined) return;
    const order = behaviour.tarClosesFirst
      ? [finish.tar, finish.decompressor]
      : [finish.decompressor, finish.tar];
    finish = {};
    for (const step of order) step();
  };
  const spawn: Spawn = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd, stdio: [...options.stdio] });
    if (command !== 'tar') {
      const process = new FakeProcess(false, true);
      if (behaviour.decompressorSpawnError === true) {
        // It never runs, so it never closes; tar still does.
        finish.decompressor = () => undefined;
        setImmediate(() =>
          process.emit(
            'error',
            Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }),
          ),
        );
        return process;
      }
      // It reads the archive it was given, from the cache directory.
      const archive = args[args.length - 1] ?? '';
      if (!existsSync(join(options.cwd, archive))) throw new Error(`no ${archive}`);
      setImmediate(() => {
        process.stdout?.end(behaviour.stream ?? STREAM);
        finish.decompressor = () => process.emit('close', behaviour.decompressorCode ?? 0, null);
        ready();
      });
      return process;
    }
    const process = new FakeProcess(true, false);
    if (behaviour.tarSpawnError === true) {
      finish.tar = () => undefined;
      setImmediate(() => {
        process.emit('error', new Error('spawn tar ENOENT'));
        ready();
      });
      return process;
    }
    if (behaviour.tarEpipe === true) {
      setImmediate(() => {
        process.stdin?.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        finish.tar = () => process.emit('close', behaviour.tarCode ?? 0, null);
        ready();
      });
      return process;
    }
    const chunks: Buffer[] = [];
    process.stdin?.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin?.on('end', () => {
      let code = behaviour.tarCode ?? 0;
      try {
        const members = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          string
        >;
        const staging = join(options.cwd, args[args.indexOf('-C') + 1] ?? '');
        if (code === 0) {
          for (const member of args.filter((arg) => arg.startsWith(`${ROOT}/`))) {
            const path = join(staging, ...member.split('/').slice(1));
            mkdirSync(join(path, '..'), { recursive: true });
            const bytes =
              member.endsWith('/bin/ffmpeg') && behaviour.ffmpegBytes !== undefined
                ? behaviour.ffmpegBytes
                : members[member];
            if (bytes === undefined) throw new Error(`no ${member} in the archive`);
            writeFileSync(path, bytes);
          }
        }
      } catch {
        // A truncated or corrupt stream: what GNU tar reports with exit code 2.
        code = 2;
      }
      finish.tar = () => process.emit('close', code, null);
      ready();
    });
    return process;
  };
  return { spawn, calls };
}

const caches: string[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) rmSync(cache, { recursive: true, force: true });
});

interface Setup {
  readonly cache: string;
  readonly options: InstallOptions;
  readonly calls: Call[];
  readonly probes: string[];
  readonly downloads: { count: number };
}

function setup(
  tools: readonly string[],
  behaviour: Behaviour = {},
  download: () => Promise<Uint8Array> = () => Promise.resolve(ARCHIVE),
): Setup {
  const cache = mkdtempSync(join(tmpdir(), 'kadrion-ffmpeg-'));
  caches.push(cache);
  const { spawn, calls } = fakeSpawn(behaviour);
  const probes: string[] = [];
  const downloads = { count: 0 };
  return {
    cache,
    calls,
    probes,
    downloads,
    options: {
      cache,
      asset: ASSET,
      release: RELEASE,
      archiveSha256: hash(ARCHIVE),
      ffmpegSha256: hash(FFMPEG),
      ffprobeSha256: hash(FFPROBE),
      download: () => {
        downloads.count += 1;
        return download();
      },
      probe: (command, args) => {
        probes.push([command, ...args].join(' '));
        return tools.includes(command);
      },
      spawn,
      log: () => undefined,
    },
  };
}

/** Everything in the cache directory, recursively, with the content of every file. */
function tree(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(path, 'utf8');
    }
  };
  walk(directory, '');
  return files;
}

const INSTALLED = {
  [ASSET]: 'the pinned archive',
  [`${RELEASE}/LICENSE.txt`]: 'GPL',
  [`${RELEASE}/bin/ffmpeg`]: FFMPEG,
  [`${RELEASE}/bin/ffprobe`]: FFPROBE,
};

async function refusal(promise: Promise<unknown>): Promise<FfmpegInstallError> {
  const reason: unknown = await promise.then(
    () => {
      throw new Error('it did not fail');
    },
    (error: unknown) => error,
  );
  expect(reason).toBeInstanceOf(FfmpegInstallError);
  return reason as FfmpegInstallError;
}

describe('the arguments of the extraction', () => {
  it('extract exactly the three members from standard input, without restoring the owner', () => {
    expect(archiveMembers(ASSET)).toEqual([
      `${ROOT}/bin/ffmpeg`,
      `${ROOT}/bin/ffprobe`,
      `${ROOT}/LICENSE.txt`,
    ]);
    expect(tarArguments(STAGING, ASSET)).toEqual([
      '-x',
      '-f',
      '-',
      '--no-same-owner',
      '-C',
      STAGING,
      '--strip-components=1',
      `${ROOT}/bin/ffmpeg`,
      `${ROOT}/bin/ffprobe`,
      `${ROOT}/LICENSE.txt`,
    ]);
  });

  it('decompress with xz -dc, or with an isolated python3 that streams through lzma', () => {
    expect(XZ.command).toBe('xz');
    expect(XZ.probe).toEqual(['--version']);
    expect(XZ.args(ASSET)).toEqual(['-dc', ASSET]);
    expect(PYTHON_LZMA.command).toBe('python3');
    expect(PYTHON_LZMA.probe).toEqual(['-I', '-c', 'import lzma']);
    expect(PYTHON_LZMA.args(ASSET)).toEqual(['-I', '-c', PYTHON_LZMA_SCRIPT, ASSET]);
    expect(PYTHON_LZMA_SCRIPT).toContain('lzma.open(sys.argv[1])');
    expect(PYTHON_LZMA_SCRIPT).toContain('shutil.copyfileobj(source, sys.stdout.buffer)');
  });

  it('prefer xz, fall back to python3 with lzma, and fail typed with neither', () => {
    expect(chooseDecompressor((command) => command === 'xz' || command === 'python3')).toBe(XZ);
    expect(chooseDecompressor((command) => command === 'python3')).toBe(PYTHON_LZMA);
    const probed: string[] = [];
    expect(() =>
      chooseDecompressor((command, args) => {
        probed.push([command, ...args].join(' '));
        return false;
      }),
    ).toThrow(expect.objectContaining({ code: 'no-decompressor' }) as Error);
    expect(probed).toEqual(['xz --version', 'python3 -I -c import lzma']);
  });
});

describe('installFfmpeg', () => {
  it('path 1: xz — verifies the archive, extracts into staging, verifies, and publishes', async () => {
    const run = setup(['xz', 'python3']);
    const installed = await installFfmpeg(run.options);
    expect(installed).toEqual({
      ffmpeg: join(run.cache, RELEASE, 'bin', 'ffmpeg'),
      ffprobe: join(run.cache, RELEASE, 'bin', 'ffprobe'),
      reused: false,
      decompressor: 'xz',
    });
    expect(run.downloads.count).toBe(1);
    expect(run.calls).toEqual([
      { command: 'xz', args: ['-dc', ASSET], cwd: run.cache, stdio: ['ignore', 'pipe', 'inherit'] },
      {
        command: 'tar',
        args: tarArguments(STAGING, ASSET),
        cwd: run.cache,
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    ]);
    expect(tree(run.cache)).toEqual(INSTALLED);
  });

  it('path 2: no xz — python3 with lzma decompresses the same stream', async () => {
    const run = setup(['python3']);
    const installed = await installFfmpeg(run.options);
    expect(installed.decompressor).toBe('python3');
    expect(run.probes).toEqual(['xz --version', 'python3 -I -c import lzma']);
    expect(run.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ['python3', '-I', '-c', PYTHON_LZMA_SCRIPT, ASSET],
      ['tar', ...tarArguments(STAGING, ASSET)],
    ]);
    expect(tree(run.cache)).toEqual(INSTALLED);
  });

  it('path 3: neither tool — a typed error, the stale staging removed, the old target untouched', async () => {
    const run = setup([]);
    writeFileSync(join(run.cache, ASSET), ARCHIVE);
    mkdirSync(join(run.cache, STAGING, 'bin'), { recursive: true });
    writeFileSync(join(run.cache, STAGING, 'bin', 'ffmpeg'), FFMPEG);
    // A partial installation of the old script: no ffprobe, no licence.
    mkdirSync(join(run.cache, RELEASE, 'bin'), { recursive: true });
    writeFileSync(join(run.cache, RELEASE, 'bin', 'ffmpeg'), FFMPEG);
    const before = tree(join(run.cache, RELEASE));
    const error = await refusal(installFfmpeg(run.options));
    expect(error.code).toBe('no-decompressor');
    expect(existsSync(join(run.cache, STAGING))).toBe(false);
    expect(tree(join(run.cache, RELEASE))).toEqual(before);
    expect(run.downloads.count).toBe(0);
    expect(run.calls).toEqual([]);
  });

  it('never extracts into the staging directory of an earlier run that did not finish', async () => {
    const run = setup(['xz']);
    mkdirSync(join(run.cache, STAGING, 'bin'), { recursive: true });
    writeFileSync(join(run.cache, STAGING, 'bin', 'left-over'), 'from a killed run');
    await installFfmpeg(run.options);
    expect(tree(run.cache)).toEqual(INSTALLED);
  });

  it('runs again safely: a verified installation is reused, with no download and no process', async () => {
    const run = setup(['xz']);
    await installFfmpeg(run.options);
    const again = await installFfmpeg(run.options);
    expect(again.reused).toBe(true);
    expect(again.decompressor).toBeNull();
    expect(run.downloads.count).toBe(1);
    expect(run.calls).toHaveLength(2);
    expect(tree(run.cache)).toEqual(INSTALLED);
  });

  it.each([
    [
      'a tampered ffmpeg',
      (cache: string) => {
        writeFileSync(join(cache, RELEASE, 'bin', 'ffmpeg'), 'x');
      },
    ],
    [
      'a missing licence',
      (cache: string) => {
        rmSync(join(cache, RELEASE, 'LICENSE.txt'));
      },
    ],
  ])(
    'replaces an installation with %s, downloading the archive again if it is gone',
    async (_, spoil) => {
      const run = setup(['xz']);
      await installFfmpeg(run.options);
      spoil(run.cache);
      rmSync(join(run.cache, ASSET));
      const again = await installFfmpeg(run.options);
      expect(again.reused).toBe(false);
      expect(run.downloads.count).toBe(2);
      expect(tree(run.cache)).toEqual(INSTALLED);
    },
  );

  it('refuses a cached archive of another hash before any process, and removes it', async () => {
    const run = setup(['xz']);
    writeFileSync(join(run.cache, ASSET), 'another archive');
    const error = await refusal(installFfmpeg(run.options));
    expect(error.code).toBe('archive-hash-mismatch');
    expect(error.message).toContain(hash('another archive'));
    expect(error.message).toContain(hash(ARCHIVE));
    expect(run.calls).toEqual([]);
    expect(run.downloads.count).toBe(0);
    expect(tree(run.cache)).toEqual({});
  });

  it('keeps no archive and no partial file when the download has another hash or fails', async () => {
    const wrong = setup(['xz'], {}, () => Promise.resolve(new TextEncoder().encode('tampered')));
    expect((await refusal(installFfmpeg(wrong.options))).code).toBe('archive-hash-mismatch');
    expect(tree(wrong.cache)).toEqual({});
    expect(wrong.calls).toEqual([]);
    const failed = setup(['xz'], {}, () => Promise.reject(new Error('offline')));
    const error = await refusal(installFfmpeg(failed.options));
    expect(error.code).toBe('download-failed');
    expect(error.message).toContain('offline');
    expect(tree(failed.cache)).toEqual({});
  });

  it.each<[string, Behaviour, string]>([
    [
      'the decompressor fails and tar closes first',
      { decompressorCode: 1, tarClosesFirst: true },
      'xz exited with 1',
    ],
    ['the decompressor fails and closes first', { decompressorCode: 1 }, 'xz exited with 1'],
    ['tar fails', { tarCode: 2 }, 'tar exited with 2'],
    [
      'the decompressor cannot start',
      { decompressorSpawnError: true },
      'xz failed: spawn xz ENOENT',
    ],
    ['tar cannot start', { tarSpawnError: true }, 'tar failed: spawn tar ENOENT'],
    [
      'a truncated stream ends with exit code 0',
      { stream: STREAM.slice(0, 20) },
      'tar exited with 2',
    ],
  ])('fails when %s, and leaves neither staging nor a target', async (_, behaviour, message) => {
    const run = setup(['xz'], behaviour);
    const error = await refusal(installFfmpeg(run.options));
    expect(error.code).toBe('extract-failed');
    expect(error.message).toContain(message);
    expect(tree(run.cache)).toEqual({ [ASSET]: 'the pinned archive' });
  });

  it('refuses extracted binaries of another hash, and publishes nothing', async () => {
    const run = setup(['xz'], { ffmpegBytes: 'a patched ffmpeg' });
    const error = await refusal(installFfmpeg(run.options));
    expect(error.code).toBe('binary-hash-mismatch');
    expect(error.message).toContain(`bin/ffmpeg of the archive has ${hash('a patched ffmpeg')}`);
    expect(tree(run.cache)).toEqual({ [ASSET]: 'the pinned archive' });
  });
});

describe('extractArchive with real processes (node standing in for the tools)', () => {
  /** A decompressor that writes 8 MiB and exits 0 only once the pipe took it all. */
  const DECOMPRESSOR =
    'process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 1), () => process.exit(0));';

  function nodeSpawn(tar: string): Spawn {
    return (command, _args, options) =>
      spawn(process.execPath, ['-e', command === 'tar' ? tar : DECOMPRESSOR], {
        cwd: options.cwd,
        stdio: [...options.stdio],
      });
  }

  it('resolves when tar reads the whole stream and exits 0', async () => {
    await expect(
      extractArchive(
        nodeSpawn("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"),
        XZ,
        ASSET,
        [],
        tmpdir(),
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('rejects, without hanging, when tar fails before reading anything', async () => {
    await expect(
      extractArchive(nodeSpawn('process.exit(2);'), XZ, ASSET, [], tmpdir()),
    ).rejects.toThrow('tar exited with 2');
  }, 30_000);

  it('does not hang when tar exits 0 after one chunk: the rest is drained', async () => {
    await expect(
      extractArchive(
        nodeSpawn("process.stdin.once('data', () => process.exit(0));"),
        XZ,
        ASSET,
        [],
        tmpdir(),
      ),
    ).resolves.toBeUndefined();
  }, 30_000);
});

describe('extractArchive', () => {
  it('resolves when tar stops reading (EPIPE) but both processes exit 0', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'kadrion-ffmpeg-'));
    caches.push(cache);
    writeFileSync(join(cache, ASSET), ARCHIVE);
    const { spawn } = fakeSpawn({ tarEpipe: true });
    await expect(
      extractArchive(spawn, XZ, ASSET, tarArguments(STAGING, ASSET), cache),
    ).resolves.toBeUndefined();
  });

  it('rejects when tar stops reading (EPIPE) and then fails', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'kadrion-ffmpeg-'));
    caches.push(cache);
    writeFileSync(join(cache, ASSET), ARCHIVE);
    const { spawn } = fakeSpawn({ tarEpipe: true, tarCode: 2 });
    await expect(
      extractArchive(spawn, XZ, ASSET, tarArguments(STAGING, ASSET), cache),
    ).rejects.toThrow('tar exited with 2');
  });
});
