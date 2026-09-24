/**
 * `node --run ffmpeg:fetch` (D29.1): downloads the pinned FFmpeg build into
 * `.kadrion-cache/ffmpeg/` unless it is there, refuses an archive or binaries
 * with other checksums, and prints the two paths to mount read-only into the
 * pinned container. It needs a network; the render that uses the binaries does
 * not (D28.9). Self-contained, because it runs with `--experimental-strip-types`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  FFMPEG_ARCHIVE_SHA256,
  FFMPEG_ASSET,
  FFMPEG_RELEASE,
  FFMPEG_SHA256,
  FFMPEG_URL,
  FFPROBE_SHA256,
} from '@kadrion/producer';

const cache = fileURLToPath(new URL('../../.kadrion-cache/ffmpeg/', import.meta.url));
const archive = join(cache, FFMPEG_ASSET);
const target = join(cache, FFMPEG_RELEASE);

const sha256 = (path: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

function refuse(message: string): never {
  console.error(`Refusing the FFmpeg build: ${message} See docs/adr/D29-mp4-export.md, 29.1.`);
  process.exit(1);
}

mkdirSync(cache, { recursive: true });
if (!existsSync(archive)) {
  console.log(`Downloading ${FFMPEG_URL}`);
  const response = await fetch(FFMPEG_URL);
  if (!response.ok) refuse(`the download answered ${String(response.status)}.`);
  writeFileSync(`${archive}.part`, new Uint8Array(await response.arrayBuffer()));
  renameSync(`${archive}.part`, archive);
}
const archiveHash = sha256(archive);
if (archiveHash !== FFMPEG_ARCHIVE_SHA256) {
  refuse(`${FFMPEG_ASSET} has ${archiveHash}, not ${FFMPEG_ARCHIVE_SHA256}.`);
}
mkdirSync(target, { recursive: true });
const root = FFMPEG_ASSET.replace(/\.tar\.xz$/, '');
// Relative names from the cache directory: GNU tar would take "G:" of a Windows path for a host.
const extracted = spawnSync(
  'tar',
  [
    '-xJf',
    FFMPEG_ASSET,
    '-C',
    FFMPEG_RELEASE,
    '--strip-components=1',
    `${root}/bin/ffmpeg`,
    `${root}/bin/ffprobe`,
    `${root}/LICENSE.txt`,
  ],
  { stdio: 'inherit', cwd: cache },
);
if (extracted.status !== 0) refuse('tar could not extract the archive.');
const ffmpeg = join(target, 'bin', 'ffmpeg');
const ffprobe = join(target, 'bin', 'ffprobe');
if (sha256(ffmpeg) !== FFMPEG_SHA256) refuse(`bin/ffmpeg has ${sha256(ffmpeg)}.`);
if (sha256(ffprobe) !== FFPROBE_SHA256) refuse(`bin/ffprobe has ${sha256(ffprobe)}.`);
console.log(`ffmpeg ${ffmpeg} ${FFMPEG_SHA256}`);
console.log(`ffprobe ${ffprobe} ${FFPROBE_SHA256}`);
