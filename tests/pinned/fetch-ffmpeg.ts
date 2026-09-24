/**
 * `node --run ffmpeg:fetch` (D29.1): installs the pinned FFmpeg build into
 * `.kadrion-cache/ffmpeg/<release>/` unless a verified installation is there,
 * refuses an archive or binaries with other checksums, and prints the two
 * paths to mount read-only into the pinned container. It needs a network; the
 * render that uses the binaries does not (D28.9). How the archive is verified,
 * decompressed, extracted, and published is `ffmpeg-install.ts`. In GitHub
 * Actions a failure also leaves `.kadrion-out/diagnostics/pinned-ffmpeg.json`
 * (`tests/ci/diagnostic.ts`), which is never evidence. Self-contained, because
 * it runs with `--experimental-strip-types`.
 */
import { spawn, spawnSync } from 'node:child_process';
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

import { writeCiDiagnostic } from '../ci/diagnostic.ts';

import { FfmpegInstallError, installFfmpeg } from '../ci/ffmpeg-install.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

try {
  const installed = await installFfmpeg({
    cache: fileURLToPath(new URL('../../.kadrion-cache/ffmpeg/', import.meta.url)),
    asset: FFMPEG_ASSET,
    release: FFMPEG_RELEASE,
    archiveSha256: FFMPEG_ARCHIVE_SHA256,
    ffmpegSha256: FFMPEG_SHA256,
    ffprobeSha256: FFPROBE_SHA256,
    async download() {
      console.log(`Downloading ${FFMPEG_URL}`);
      const response = await fetch(FFMPEG_URL);
      if (!response.ok) {
        throw new FfmpegInstallError(
          'download-failed',
          `The download answered ${String(response.status)}.`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    probe: (command, args) => {
      const result = spawnSync(command, [...args], { stdio: 'ignore' });
      return result.error === undefined && result.status === 0;
    },
    spawn: (command, args, options) =>
      spawn(command, [...args], { cwd: options.cwd, stdio: [...options.stdio] }),
    log: (line) => {
      console.log(line);
    },
  });
  console.log(`ffmpeg ${installed.ffmpeg} ${FFMPEG_SHA256}`);
  console.log(`ffprobe ${installed.ffprobe} ${FFPROBE_SHA256}`);
} catch (reason) {
  const code = reason instanceof FfmpegInstallError ? reason.code : 'unexpected';
  // The error first: a diagnostic that cannot be written must not hide it.
  console.error(
    `Refusing the FFmpeg build (${code}): ${reason instanceof Error ? reason.message : String(reason)} See docs/adr/D29-mp4-export.md, 29.1.`,
  );
  process.exitCode = 1;
  writeCiDiagnostic(root, 'pinned-ffmpeg', code, process.env);
}
