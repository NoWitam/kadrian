import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Determinism guardrail (specification §6.1, binding). Runtime state is derived
 * from `(composition, timeUs)` only, so the runtime sources may not reach a
 * clock, a timer, a frame callback, or a random source. The static rules and the
 * dynamic clock-independence tests of the runtime complement each other: the
 * rules also see code that no test exercises and references captured when a
 * module loads, the tests also see what hides behind an alias.
 * `tests/repo/lint-guardrails.test.ts` proves that every entry rejects.
 */
const DETERMINISM =
  'Runtime state is derived from (composition, timeUs) only (AGENTS.md, specification §6.1).';

const NONDETERMINISTIC_GLOBALS = [
  'Date',
  'Temporal',
  'performance',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
];

const NONDETERMINISTIC_PROPERTIES = [
  { object: 'Math', property: 'random' },
  { object: 'crypto', property: 'getRandomValues' },
  { object: 'crypto', property: 'randomUUID' },
  // The same members on any object, which closes aliases such as `const m = Math`.
  ...['random', 'now', 'hrtime', 'timeOrigin', 'getRandomValues', 'randomUUID'].map((property) => ({
    property,
  })),
  // The same globals, reached through the global object.
  ...['globalThis', 'window', 'self', 'global'].flatMap((object) =>
    NONDETERMINISTIC_GLOBALS.map((property) => ({ object, property })),
  ),
];

/**
 * Only `validateComposition` may produce a `ValidatedComposition` (specification
 * Q17, D19). The brand is static, so a type assertion or a type predicate could
 * forge it; both are rejected in every package source except the validator.
 */
const BRAND =
  ':matches([typeName.name="ValidatedComposition"], [typeName.right.name="ValidatedComposition"])';

export default defineConfig(
  globalIgnores(['**/dist/**', '**/coverage/**']),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Every TypeScript file must belong to exactly one tsconfig project;
        // a file outside all projects is a lint error, not a silent skip.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['packages/runtime/src/**/*.ts'],
    // An inline `eslint-disable` must not be able to switch the guardrail off:
    // inline configuration has no effect here and is itself reported.
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-restricted-globals': [
        'error',
        ...NONDETERMINISTIC_GLOBALS.map((name) => ({ name, message: DETERMINISM })),
      ],
      'no-restricted-properties': [
        'error',
        ...NONDETERMINISTIC_PROPERTIES.map((entry) => ({ ...entry, message: DETERMINISM })),
      ],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/schema/src/validate.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `:matches(TSAsExpression, TSTypeAssertion, TSTypePredicate) TSTypeReference${BRAND}`,
          message:
            'Only validateComposition may produce a ValidatedComposition (specification Q17). Validate the document instead of asserting its type.',
        },
      ],
    },
  },
  {
    // Plain JavaScript config files are linted without type information.
    files: ['*.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
