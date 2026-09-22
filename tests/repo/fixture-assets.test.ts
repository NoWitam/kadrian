import { describe, expect, it } from 'vitest';

import { listFiles, readJson } from './repo.js';

/** The binary formats that `.gitattributes` lists. */
const BINARY_ASSET = /\.(png|jpe?g|webp|gif|mp3|wav|ogg|m4a|mp4|woff2?|ttf|otf)$/i;
/** No real content hashes to 56 leading zeros, so such a value can only be a placeholder (D14). */
const PLACEHOLDER_HASH = /^sha256:0{56}/;

interface ReferenceComposition {
  assets: { id: string; contentHash: string }[];
}

const reference = readJson(
  'packages',
  'test-fixtures',
  'src',
  'compositions',
  'reference.json',
) as ReferenceComposition;
const hashes = reference.assets.map((asset) => asset.contentHash);
const placeholders = hashes.filter((hash) => PLACEHOLDER_HASH.test(hash));
const binaries = listFiles('packages', 'test-fixtures').filter(
  (file) => BINARY_ASSET.test(file) && !/\/(dist|node_modules)\//.test(file),
);

describe('fixture assets (D14)', () => {
  it('pins every asset with its own hash', () => {
    expect(hashes).toHaveLength(3);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  // Tripwire: the pull request that adds the binaries must replace the placeholders.
  it('ships no binary asset while a placeholder hash is in place', () => {
    expect(placeholders.length > 0 ? binaries : []).toEqual([]);
  });
});
