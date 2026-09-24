import { defineConfig } from 'vitest/config';

/**
 * The browser tests of D26–D28 (`node --run test:pinned`). They need the
 * Playwright-managed Chromium, so `check` does not run them. Golden frames are
 * asserted only in the pinned environment (D26.2); elsewhere the tests report
 * and prove nothing. One file at a time: each launches its own browser.
 */
export default defineConfig({
  test: {
    include: ['tests/pinned/**/*.pinned.test.ts'],
    passWithNoTests: false,
    // The memory tests of the export call the garbage collector (D29.3).
    execArgv: ['--expose-gc'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The raw report of the run, which tests/ci/write-pinned-summary.ts turns into
    // the Kadrion-owned .kadrion-out/pinned-test-summary.json (owner, 2026-09-24).
    // No retry: a flaky pass must not count as a pass.
    retry: 0,
    reporters: ['default', ['json', { outputFile: '.kadrion-out/vitest-pinned.json' }]],
  },
});
