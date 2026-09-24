/**
 * `node --experimental-strip-types tests/ci/write-ci-identity.ts` (owner,
 * 2026-09-24): writes `.kadrion-out/ci-identity.json` in the CI job, after the
 * pinned tests and their summary, so that it can bind their reports by hash.
 *
 * It writes only when every check of `collectCiIdentity` passes; otherwise it
 * prints the problems and fails, and the missing file is an evidence error. It
 * reads the environment by the exact names of `IDENTITY_ENV` only and never
 * writes the environment itself. It cannot run outside GitHub Actions: without
 * the GITHUB_* variables it fails, by design.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { FFMPEG_SHA256, FFPROBE_SHA256, PINNED_IMAGE } from '@kadrion/producer';
import { referenceComposition } from '@kadrion/test-fixtures';

import { distManifest, distTreeSha256, servedDist } from '../parity/parity.ts';

import {
  CiIdentityError,
  collectCiIdentity,
  IDENTITY_ENV,
  type CiIdentityIo,
} from './ci-identity.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

const io: CiIdentityIo = {
  env: (name) => (IDENTITY_ENV.includes(name) ? process.env[name] : undefined),
  // The checkout belongs to the runner's user and the container runs as root:
  // name the workspace as safe for this one command.
  git: (args) =>
    execFileSync('git', ['-c', `safe.directory=${root.replace(/[\\/]$/, '')}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  readFile: (path) => new Uint8Array(readFileSync(join(root, ...path.split('/')))),
  readAbsolute: (path) => {
    if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path.`);
    return new Uint8Array(readFileSync(path));
  },
  run: (executable, args) => {
    const result = spawnSync(executable, [...args], { encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout };
  },
  platform: process.platform,
  arch: process.arch,
  now: () => new Date(),
  playerDistTreeSha256: () =>
    distTreeSha256(
      distManifest(
        servedDist((path) => new Uint8Array(readFileSync(join(root, ...path.split('/'))))),
      ),
    ),
};

const assets = (
  referenceComposition as { assets: { id: string; type: string; contentHash: string }[] }
).assets;

try {
  const identity = collectCiIdentity(io, {
    pinnedImage: PINNED_IMAGE,
    ffmpegSha256: FFMPEG_SHA256,
    ffprobeSha256: FFPROBE_SHA256,
    fonts: assets
      .filter((asset) => asset.type === 'font')
      .map(({ id, contentHash }) => ({ id, contentHash })),
  });
  writeFileSync(
    join(root, '.kadrion-out', 'ci-identity.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  console.log(
    `ci-identity.json: ${identity.commitSha}, run ${String(identity.runId)} attempt ${String(identity.runAttempt)}.`,
  );
} catch (reason) {
  if (!(reason instanceof CiIdentityError)) throw reason;
  console.error(reason.message);
  process.exitCode = 1;
}
