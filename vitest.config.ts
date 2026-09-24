import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Package tests live in packages/<name>/test (own non-emitting tsconfig);
    // repository-level checks live in tests/.
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    // The browser tests need Chromium and run with `node --run test:pinned` (D26).
    exclude: ['**/node_modules/**', 'tests/pinned/**'],
    passWithNoTests: false,
    // The memory tests of the export call the garbage collector (D29.3).
    execArgv: ['--expose-gc'],
  },
});
