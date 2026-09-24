/**
 * The runtime build the Producer executes (D21, D28.2): the artifact and its
 * manifest as `@kadrion/renderer-dom` exports them, verified before use. The
 * Player verifies the same bytes against the same hash (D25.5).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { ProducerError } from './errors.js';
import { sha256 } from './manifest.js';

export interface RuntimeBuild {
  readonly script: string;
  readonly contentHash: string;
  readonly bundler: string;
  readonly compiler: string;
}

interface RuntimeManifestFile {
  readonly contentHash: string;
  readonly bundler: string;
  readonly compiler: string;
}

/** Checks bytes against a hash and returns them as the text of one script (D25.2, D25.5). */
export function verifiedScript(bytes: Uint8Array, contentHash: string): string {
  const actual = sha256(bytes);
  if (actual !== contentHash) {
    throw new ProducerError(
      'runtime-hash-mismatch',
      `The runtime build has ${actual}, not ${contentHash}.`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProducerError('runtime-unsafe', 'The runtime build is not UTF-8.');
  }
}

/** The artifact of `@kadrion/renderer-dom`, verified against its manifest. */
export function loadRuntimeBuild(): RuntimeBuild {
  const require = createRequire(import.meta.url);
  const artifact = require.resolve('@kadrion/renderer-dom/runtime-build/kadrion-runtime.js');
  const manifestPath = require.resolve('@kadrion/renderer-dom/runtime-build/kadrion-runtime.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeManifestFile;
  const bytes = new Uint8Array(readFileSync(artifact));
  return {
    script: verifiedScript(bytes, manifest.contentHash),
    contentHash: manifest.contentHash,
    bundler: manifest.bundler,
    compiler: manifest.compiler,
  };
}
