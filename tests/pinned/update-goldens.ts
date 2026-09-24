/**
 * `node --run goldens:update` (D26.5): renders the golden timestamps of the
 * reference composition with the Producer and writes the golden frames and
 * their manifest into `packages/test-fixtures/src/golden-frames/`. It refuses
 * to write anything unless the environment is the pinned container (D26.2)
 * without a network (D28.9);
 * the diff of the images is reviewed like code. Self-contained, because it
 * runs with `--experimental-strip-types`, which resolves no `.js` to `.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  environmentManifest,
  goldenRefusal,
  launchChromium,
  renderFrames,
  sha256,
} from '@kadrion/producer';
import {
  generateReferenceAssets,
  goldenTimestamps,
  referenceComposition,
} from '@kadrion/test-fixtures';

const directory = fileURLToPath(
  new URL('../../packages/test-fixtures/src/golden-frames/', import.meta.url),
);
const assets = Object.fromEntries(generateReferenceAssets().map((asset) => [asset.id, asset]));

const chromium = await launchChromium();
try {
  const environment = environmentManifest(chromium.reportedVersion, { width: 1080, height: 1920 });
  const refusal = goldenRefusal(environment);
  if (refusal !== null) {
    console.error(`Refusing to write golden frames: ${refusal}.`);
    process.exitCode = 1;
  } else {
    const result = await renderFrames({
      document: referenceComposition,
      resolveAsset: ({ id }) => assets[id] ?? null,
      timesUs: goldenTimestamps.map(({ timeUs }) => timeUs),
      chromium,
    });
    mkdirSync(directory, { recursive: true });
    const frames = result.frames.map(({ index, timeUs, png }) => {
      const file = `reference-${String(timeUs)}.png`;
      writeFileSync(join(directory, file), png);
      return { file, timeUs, index, sha256: sha256(png) };
    });
    const manifest = { render: result.manifest, environment, frames };
    writeFileSync(
      join(directory, 'reference.golden-frames.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    for (const frame of frames) console.log(`${frame.file} ${frame.sha256}`);
  }
} finally {
  await chromium.browser.close();
}
