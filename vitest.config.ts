import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Package tests live in packages/<name>/test (own non-emitting tsconfig);
    // repository-level checks live in tests/.
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: false,
  },
});
