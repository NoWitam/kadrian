/**
 * The update command of D26.5 refuses to write golden frames outside the
 * pinned environment. The test runs it with an image reference that is not the
 * pinned one, so it refuses in every environment, the container included.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { GOLDEN_DIRECTORY, repoRoot } from './support.js';

const run = promisify(execFile);

describe('node --run goldens:update (D26.5)', () => {
  it('refuses to write outside the pinned environment and leaves the directory as it was', async () => {
    const before = existsSync(GOLDEN_DIRECTORY) ? readdirSync(GOLDEN_DIRECTORY).sort() : null;
    const outcome = await run(
      process.execPath,
      ['--experimental-strip-types', join(repoRoot, 'tests', 'pinned', 'update-goldens.ts')],
      {
        cwd: repoRoot,
        env: { ...process.env, KADRION_PINNED_IMAGE: 'mcr.microsoft.com/playwright:not-pinned' },
      },
    ).then(
      () => ({ code: 0, stderr: '' }),
      (reason: unknown) => reason as { code: number; stderr: string },
    );
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('Refusing to write golden frames');
    const after = existsSync(GOLDEN_DIRECTORY) ? readdirSync(GOLDEN_DIRECTORY).sort() : null;
    expect(after).toEqual(before);
  });
});
