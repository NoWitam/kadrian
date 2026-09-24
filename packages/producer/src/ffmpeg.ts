/**
 * The pinned FFmpeg (D29.1): the constants of the one build the Producer runs,
 * its verification before any render, and the processes it starts. The paths
 * are always given by the caller and must be absolute: a bare name would make
 * the operating system search `PATH`, and an FFmpeg found by chance is never
 * used. Nothing here reads the environment.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import type { Writable } from 'node:stream';

import { ProducerError } from './errors.js';

export const FFMPEG_RELEASE = 'autobuild-2026-09-21-13-55';
export const FFMPEG_ASSET = 'ffmpeg-n8.1.3-linux64-gpl-8.1.tar.xz';
export const FFMPEG_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${FFMPEG_ASSET}`;
export const FFMPEG_ARCHIVE_SHA256 =
  'sha256:dfe7728e01099e22a6fc7a65355ed4f1b65468e1dbe0015f07c45286b486cc59';
export const FFMPEG_SHA256 =
  'sha256:b8404b6fe11bfa0d4970d031b6eb8108d230075e3f3be5fde7fada250f003c54';
export const FFPROBE_SHA256 =
  'sha256:a037cf8856a567f6c8e25837786bd8dbfb27f57738d9c42331c48a46f423f270';
export const FFMPEG_VERSION = 'n8.1.3-20260921';
export const FFMPEG_VERSION_LINE = `ffmpeg version ${FFMPEG_VERSION} Copyright (c) 2000-2026 the FFmpeg developers`;
export const FFPROBE_VERSION_LINE = `ffprobe version ${FFMPEG_VERSION} Copyright (c) 2007-2026 the FFmpeg developers`;
export const FFMPEG_CONFIGURATION =
  "--prefix=/ffbuild/prefix --pkg-config-flags=--static --pkg-config=pkg-config --cross-prefix=x86_64-ffbuild-linux-gnu- --arch=x86_64 --target-os=linux --enable-gpl --enable-version3 --disable-debug --enable-iconv --enable-zlib --enable-libxml2 --enable-libsoxr --enable-openssl --enable-libvmaf --enable-fontconfig --enable-libharfbuzz --enable-libfreetype --enable-libfribidi --enable-vulkan --enable-libshaderc --enable-libdav1d --enable-libvorbis --enable-librav1e --enable-librsvg --enable-libxcb --enable-xlib --enable-libpulse --enable-gmp --enable-lzma --enable-liblcevc-dec --enable-opencl --enable-amf --enable-libaom --enable-avisynth --enable-chromaprint --enable-libdavs2 --enable-libdvdread --enable-libdvdnav --disable-libfdk-aac --enable-ffnvcodec --enable-cuda-llvm --enable-frei0r --enable-libgme --enable-libkvazaar --enable-libaribb24 --enable-libaribcaption --enable-libass --enable-libbluray --enable-libjxl --enable-libmp3lame --enable-libopus --enable-libplacebo --enable-librist --enable-libssh --enable-libtheora --enable-libvpx --enable-libwebp --enable-libzmq --enable-lv2 --enable-libvpl --enable-openal --enable-liboapv --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenh264 --enable-libopenjpeg --enable-libopenmpt --enable-librubberband --disable-schannel --enable-sdl2 --enable-libsnappy --enable-libsrt --enable-libsvtav1 --enable-libtwolame --enable-libuavs3d --enable-libdrm --enable-vaapi --enable-libvidstab --enable-libvvenc --disable-whisper --enable-libx264 --enable-libx265 --enable-libxavs2 --enable-libxvid --enable-libzimg --enable-libzvbi --extra-cflags=-DLIBTWOLAME_STATIC --extra-cxxflags= --extra-libs='-lgomp -ldl' --extra-ldflags=-pthread --extra-ldexeflags= --cc=x86_64-ffbuild-linux-gnu-gcc --cxx=x86_64-ffbuild-linux-gnu-g++ --ar=x86_64-ffbuild-linux-gnu-gcc-ar --ranlib=x86_64-ffbuild-linux-gnu-gcc-ranlib --nm=x86_64-ffbuild-linux-gnu-gcc-nm --extra-version=20260921";
/** The encoders the export uses; `-encoders` must list both (D29.1). */
export const REQUIRED_ENCODERS: readonly string[] = Object.freeze(['libx264', 'aac']);
/** The platform of the pinned binaries (D29.1). */
export const FFMPEG_PLATFORM = 'linux/x64';

export interface FfmpegPaths {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
}

/** What the verification found; the manifest records it (D29.9). */
export interface FfmpegIdentity {
  readonly ffmpegSha256: string;
  readonly ffprobeSha256: string;
  readonly version: string;
  readonly configuration: string;
  readonly encoders: readonly string[];
}

/** What a process printed and how it ended. */
export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The operating-system calls of the verification, replaced by tests. */
export interface FfmpegHost {
  readonly platform: string;
  readonly arch: string;
  isFile(path: string): boolean;
  sha256(path: string): Promise<string>;
  run(path: string, args: readonly string[]): Promise<ProcessResult>;
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolve(`sha256:${hash.digest('hex')}`);
      });
  });
}

function runProcess(path: string, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      path,
      [...args],
      { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (reason, stdout, stderr) => {
        const code = reason === null ? 0 : typeof reason.code === 'number' ? reason.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export const systemHost: FfmpegHost = {
  platform: process.platform,
  arch: process.arch,
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  sha256: sha256OfFile,
  run: runProcess,
};

function mismatch(message: string): ProducerError {
  return new ProducerError('ffmpeg-mismatch', message);
}

/**
 * Verifies the two executables in the order of D29.1 and returns what the
 * manifest records: absolute and present (`ffmpeg-missing`); the platform, the
 * checksums, the version lines, the configuration, and the encoders
 * (`ffmpeg-mismatch`).
 */
export async function verifyFfmpeg(
  paths: FfmpegPaths,
  host: FfmpegHost = systemHost,
): Promise<FfmpegIdentity> {
  for (const [name, path] of [
    ['ffmpeg', paths.ffmpegPath],
    ['ffprobe', paths.ffprobePath],
  ] as const) {
    if (!isAbsolute(path)) {
      throw new ProducerError(
        'ffmpeg-missing',
        `The ${name} executable must be given as an absolute path; PATH is never searched (got ${JSON.stringify(path)}).`,
      );
    }
    if (!host.isFile(path)) {
      throw new ProducerError('ffmpeg-missing', `There is no ${name} executable at ${path}.`);
    }
  }
  if (`${host.platform}/${host.arch}` !== FFMPEG_PLATFORM) {
    throw mismatch(
      `The pinned FFmpeg runs on ${FFMPEG_PLATFORM} only, not on ${host.platform}/${host.arch}.`,
    );
  }
  const ffmpegSha256 = await host.sha256(paths.ffmpegPath);
  if (ffmpegSha256 !== FFMPEG_SHA256) {
    throw mismatch(`ffmpeg has ${ffmpegSha256}, not the pinned ${FFMPEG_SHA256}.`);
  }
  const ffprobeSha256 = await host.sha256(paths.ffprobePath);
  if (ffprobeSha256 !== FFPROBE_SHA256) {
    throw mismatch(`ffprobe has ${ffprobeSha256}, not the pinned ${FFPROBE_SHA256}.`);
  }
  const version = await host.run(paths.ffmpegPath, ['-hide_banner', '-version']);
  const lines = version.stdout.split('\n').map((line) => line.trimEnd());
  if (version.code !== 0 || lines[0] !== FFMPEG_VERSION_LINE) {
    throw mismatch(`ffmpeg reports "${lines[0] ?? ''}", not "${FFMPEG_VERSION_LINE}".`);
  }
  const configuration = lines
    .find((line) => line.startsWith('configuration: '))
    ?.slice('configuration: '.length);
  if (configuration !== FFMPEG_CONFIGURATION) {
    throw mismatch('ffmpeg reports another build configuration than the pinned one.');
  }
  const probe = await host.run(paths.ffprobePath, ['-hide_banner', '-version']);
  const probeLine = probe.stdout.split('\n')[0]?.trimEnd();
  if (probe.code !== 0 || probeLine !== FFPROBE_VERSION_LINE) {
    throw mismatch(`ffprobe reports "${probeLine ?? ''}", not "${FFPROBE_VERSION_LINE}".`);
  }
  const listed = await host.run(paths.ffmpegPath, ['-hide_banner', '-encoders']);
  for (const encoder of REQUIRED_ENCODERS) {
    const pattern = new RegExp(`^\\s*[VA][A-Z.]{5}\\s+${encoder}\\s`, 'm');
    if (listed.code !== 0 || !pattern.test(listed.stdout)) {
      throw mismatch(`ffmpeg does not list the encoder ${encoder}.`);
    }
  }
  return {
    ffmpegSha256,
    ffprobeSha256,
    version: FFMPEG_VERSION,
    configuration,
    encoders: REQUIRED_ENCODERS,
  };
}

/** One running FFmpeg of an export (D29.3). */
export interface EncoderProcess {
  /** Frames: standard input, `pipe:0`. */
  readonly video: Writable;
  /** The audio asset's bytes: `pipe:3`, or `null` without audio. */
  readonly audio: Writable | null;
  /** Everything FFmpeg printed on standard output: the receipt of D29.3. */
  readonly receipt: Promise<string>;
  /** Resolves when the process has exited, with the end of its standard error. */
  readonly exited: Promise<{ readonly code: number | null; readonly stderr: string }>;
  kill(): void;
}

/**
 * What the audio asset is, as the pinned `ffprobe` reads it from a pipe (D29.6).
 * A container read from a pipe need not state its length — a WAV does not,
 * because its size is unknown — so the samples are counted by decoding.
 */
export interface AudioProbe {
  readonly audioStreams: number;
  readonly sampleRate: number | null;
  /** Decoded samples of the first audio stream, at `sampleRate`. */
  readonly samples: bigint;
}

/** The running parts of the pinned FFmpeg that an export needs; tests replace them. */
export interface FfmpegTools {
  readonly identity: FfmpegIdentity;
  probeAudio(bytes: Uint8Array): Promise<AudioProbe>;
  countVideoPackets(file: string): Promise<number>;
  /** The presentation time of every video frame of a file, in its time base. */
  videoTimestamps(file: string): Promise<number[]>;
  spawnEncoder(args: readonly string[], withAudio: boolean): EncoderProcess;
}

const STDERR_TAIL = 16 * 1024;

function collect(stream: NodeJS.ReadableStream | null, tail: number | null): Promise<string> {
  return new Promise((resolve) => {
    if (stream === null) {
      resolve('');
      return;
    }
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      text += chunk;
      if (tail !== null && text.length > tail) text = text.slice(-tail);
    });
    stream.on('error', () => undefined);
    stream.on('end', () => {
      resolve(text);
    });
  });
}

/** Runs ffprobe over the bytes on a pipe and hands every line of its output to `onLine`. */
function probeLines(
  ffprobePath: string,
  args: readonly string[],
  bytes: Uint8Array,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [...args, '-i', 'pipe:0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderr = collect(child.stderr, STDERR_TAIL);
    // Lines are handed on as they arrive, so a long asset costs no memory here.
    let rest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const parts = `${rest}${chunk}`.split('\n');
      rest = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    });
    child.stdout.on('error', () => undefined);
    // ffprobe may stop reading once it knows enough; that is not an error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(bytes);
    child.on('error', reject);
    child.on('close', (code) => {
      if (rest !== '') onLine(rest);
      void stderr.then((err) => {
        if (code === 0) resolve();
        else {
          reject(
            new ProducerError(
              'audio-invalid',
              `ffprobe cannot read the audio asset: ${err.trim()}`,
            ),
          );
        }
      });
    });
  });
}

/**
 * What the asset is, measured from the pipe (D29.6): how many audio streams it
 * has, the sample rate of the first, and how many samples decoding it yields.
 * The samples are summed line by line, so the length of the asset costs no memory.
 */
async function probeAudioWith(ffprobePath: string, bytes: Uint8Array): Promise<AudioProbe> {
  const streams: string[] = [];
  await probeLines(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=sample_rate',
      '-of',
      'csv=p=0',
    ],
    bytes,
    (line) => {
      if (line.trim() !== '') streams.push(line.trim());
    },
  );
  let samples = 0n;
  await probeLines(
    ffprobePath,
    [
      ...['-v', 'error', '-select_streams', 'a:0', '-count_frames'],
      ...['-show_entries', 'frame=nb_samples', '-of', 'csv=p=0'],
    ],
    bytes,
    (line) => {
      const count = Number(line.split(',')[0]?.trim());
      if (Number.isSafeInteger(count) && count > 0) samples += BigInt(count);
    },
  );
  const rate = Number(streams[0]?.split(',')[0]);
  return {
    audioStreams: streams.length,
    sampleRate: Number.isSafeInteger(rate) && rate > 0 ? rate : null,
    samples,
  };
}

/** The tools of a verified pinned FFmpeg (D29.1). */
export async function pinnedFfmpeg(
  paths: FfmpegPaths,
  host: FfmpegHost = systemHost,
): Promise<FfmpegTools> {
  const identity = await verifyFfmpeg(paths, host);
  return {
    identity,
    probeAudio: (bytes) => probeAudioWith(paths.ffprobePath, bytes),
    async countVideoPackets(file) {
      const result = await host.run(paths.ffprobePath, [
        ...['-v', 'error', '-select_streams', 'v:0', '-count_packets'],
        ...['-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file],
      ]);
      const count = Number(result.stdout.trim());
      if (result.code !== 0 || !Number.isSafeInteger(count)) {
        throw new ProducerError(
          'encode-failed',
          `ffprobe cannot read the output: ${result.stderr.trim()}`,
        );
      }
      return count;
    },
    async videoTimestamps(file) {
      const result = await host.run(paths.ffprobePath, [
        ...['-v', 'error', '-select_streams', 'v:0'],
        ...['-show_entries', 'frame=pts', '-of', 'csv=p=0', file],
      ]);
      if (result.code !== 0) {
        throw new ProducerError(
          'encode-failed',
          `ffprobe cannot read the frames of the output: ${result.stderr.trim()}`,
        );
      }
      // The first frame carries side data, which csv output writes as one more, empty field.
      return result.stdout
        .trim()
        .split('\n')
        .map((line) => Number(line.split(',')[0]?.trim()));
    },
    spawnEncoder(args, withAudio) {
      const child = spawn(paths.ffmpegPath, [...args], {
        stdio: ['pipe', 'pipe', 'pipe', withAudio ? 'pipe' : 'ignore'],
        windowsHide: true,
      });
      const receipt = collect(child.stdout, null);
      const stderr = collect(child.stderr, STDERR_TAIL);
      const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        child.on('error', (reason) => {
          void stderr.then((text) => {
            resolve({ code: null, stderr: `${text}${String(reason)}` });
          });
        });
        child.on('close', (code) => {
          void stderr.then((text) => {
            resolve({ code, stderr: text });
          });
        });
      });
      const audio = withAudio ? (child.stdio[3] as Writable | null) : null;
      if (child.stdin === null) {
        child.kill('SIGKILL');
        throw new ProducerError('encode-failed', 'FFmpeg has no standard input.');
      }
      return {
        video: child.stdin,
        audio,
        receipt,
        exited,
        kill() {
          child.kill('SIGKILL');
        },
      };
    },
  };
}
