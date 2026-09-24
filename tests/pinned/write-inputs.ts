/**
 * Writes the inputs of the reference export (D29.11) into one directory: the
 * reference composition, its generated assets, and the asset map of D28.8. The
 * reference run mounts that directory read-only into the container that runs
 * `kadrion export`, so every input exists before the render starts.
 * Self-contained, because it runs with `--experimental-strip-types`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { generateReferenceAssets, referenceComposition } from '@kadrion/test-fixtures';

const [directory] = process.argv.slice(2);
if (directory === undefined) {
  console.error('Usage: node --experimental-strip-types tests/pinned/write-inputs.ts <dir>');
  process.exit(2);
}
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'composition.json'), `${JSON.stringify(referenceComposition)}\n`);
const map: Record<string, { path: string; mediaType: string }> = {};
for (const asset of generateReferenceAssets()) {
  writeFileSync(join(directory, asset.id), asset.bytes);
  map[asset.id] = { path: asset.id, mediaType: asset.mediaType };
}
writeFileSync(join(directory, 'assets.json'), `${JSON.stringify(map, null, 2)}\n`);
console.log(`inputs ${directory}`);
