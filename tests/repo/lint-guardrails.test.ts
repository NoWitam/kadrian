/**
 * Feeds violating source text to the linter and asserts the rejection
 * (specification §6.1, binding). The real `eslint.config.js` is used, with typed
 * linting, so the text is linted under the path of an existing source file: the
 * project service refuses a file that belongs to no tsconfig project.
 *
 * The lists below are deliberately independent of the lists in the
 * configuration: an entry deleted there must fail here.
 */
import { existsSync } from 'node:fs';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

import { repoPath, repoRoot } from './repo.js';

const RUNTIME_SOURCE = repoPath('packages', 'runtime', 'src', 'index.ts');
const PRODUCER_SOURCE = repoPath('packages', 'producer', 'src', 'index.ts');
const SCHEMA_SOURCE = repoPath('packages', 'schema', 'src', 'index.ts');
const SCHEMA_VALIDATOR = repoPath('packages', 'schema', 'src', 'validate.ts');
const SCHEMA_TEST = repoPath('packages', 'schema', 'test', 'types.test.ts');

const GUARD_RULES = ['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax'];

interface Verdict {
  /** Messages of the guard rules only, as `ruleId: message`. */
  readonly rejections: readonly string[];
  readonly fatalErrors: number;
  readonly warnings: readonly string[];
}

const eslint = new ESLint({ cwd: repoRoot });

async function lint(source: string, filePath: string): Promise<Verdict> {
  const results = await eslint.lintText(source, { filePath });
  const messages = results.flatMap((result) => result.messages);
  return {
    rejections: messages
      .filter((message) => message.severity === 2 && GUARD_RULES.includes(message.ruleId ?? ''))
      .map((message) => `${message.ruleId ?? ''}: ${message.message}`),
    fatalErrors: results.reduce((count, result) => count + result.fatalErrorCount, 0),
    warnings: messages.filter((message) => message.severity === 1).map(({ message }) => message),
  };
}

// The first typed lint starts the TypeScript project service, which takes seconds.
beforeAll(async () => {
  for (const file of [RUNTIME_SOURCE, PRODUCER_SOURCE, SCHEMA_SOURCE, SCHEMA_VALIDATOR]) {
    expect(existsSync(file), file).toBe(true);
  }
  await lint('export {};\n', RUNTIME_SOURCE);
}, 120_000);

const GLOBALS = 'no-restricted-globals';
const PROPERTIES = 'no-restricted-properties';

/** [what is banned, the rule that must reject it, a module that uses it] */
const violations: readonly (readonly [banned: string, rule: string, source: string])[] = [
  ['Date', GLOBALS, 'export const now = Date.now();'],
  ['Date', GLOBALS, 'export const today = new Date();'],
  ['Date', GLOBALS, 'export const clock = Date;'],
  ['Temporal', GLOBALS, 'export const now = Temporal.Now.instant();'],
  ['performance', GLOBALS, 'export const now = performance.now();'],
  ['Math.random', PROPERTIES, 'export const noise = Math.random();'],
  ['Math.random', PROPERTIES, "export const noise = Math['random']();"],
  ['Math.random', PROPERTIES, 'const { random } = Math;\nexport const noise = random();'],
  [
    'crypto.getRandomValues',
    PROPERTIES,
    'export const n = crypto.getRandomValues(new Uint8Array(1));',
  ],
  ['crypto.randomUUID', PROPERTIES, 'export const id = crypto.randomUUID();'],
  // Aliases: the member is banned on any object.
  ['random', PROPERTIES, 'const m = Math;\nexport const noise = m.random();'],
  ['now', PROPERTIES, 'export const read = (clock: { now(): number }): number => clock.now();'],
  [
    'hrtime',
    PROPERTIES,
    'export const read = (p: { hrtime(): number[] }): number[] => p.hrtime();',
  ],
  [
    'timeOrigin',
    PROPERTIES,
    'export const read = (p: { timeOrigin: number }): number => p.timeOrigin;',
  ],
  [
    'getRandomValues',
    PROPERTIES,
    'const c = crypto;\nexport const n = c.getRandomValues(new Uint8Array(1));',
  ],
  ['setTimeout', GLOBALS, 'export const handle = setTimeout(() => undefined, 1);'],
  ['setInterval', GLOBALS, 'export const handle = setInterval(() => undefined, 1);'],
  ['setImmediate', GLOBALS, 'export const handle = setImmediate(() => undefined);'],
  ['clearTimeout', GLOBALS, 'clearTimeout(1);\nexport {};'],
  ['clearInterval', GLOBALS, 'clearInterval(1);\nexport {};'],
  ['clearImmediate', GLOBALS, 'clearImmediate(undefined);\nexport {};'],
  [
    'requestAnimationFrame',
    GLOBALS,
    'export const handle = requestAnimationFrame(() => undefined);',
  ],
  ['cancelAnimationFrame', GLOBALS, 'cancelAnimationFrame(1);\nexport {};'],
  ['requestIdleCallback', GLOBALS, 'export const handle = requestIdleCallback(() => undefined);'],
  ['cancelIdleCallback', GLOBALS, 'cancelIdleCallback(1);\nexport {};'],
  ['globalThis.Date', PROPERTIES, 'export const now = globalThis.Date.now();'],
  ['globalThis.performance', PROPERTIES, 'export const now = globalThis.performance.now();'],
  [
    'globalThis.setTimeout',
    PROPERTIES,
    'export const handle = globalThis.setTimeout(() => undefined, 1);',
  ],
  [
    'window.requestAnimationFrame',
    PROPERTIES,
    'export const handle = window.requestAnimationFrame(() => undefined);',
  ],
  ['self.setInterval', PROPERTIES, 'export const handle = self.setInterval(() => undefined, 1);'],
  [
    'global.setImmediate',
    PROPERTIES,
    'export const handle = global.setImmediate(() => undefined);',
  ],
];

const deterministicSource = [
  'export const lerp = (a: number, b: number, elapsed: number, span: number): number =>',
  '  a + ((b - a) * elapsed) / span;',
  'export const floor = Math.floor(2.5);',
  '',
].join('\n');

describe('determinism guardrail (specification §6.1)', { timeout: 120_000 }, () => {
  it.each(violations)('rejects %s (%s) in the runtime sources', async (banned, rule, source) => {
    const verdict = await lint(`${source}\n`, RUNTIME_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections.filter((line) => line.startsWith(`${rule}: `))).not.toEqual([]);
    expect(verdict.rejections.join('\n')).toContain(`'${banned}'`);
  });

  it.each([
    ['a block comment', '/* eslint-disable */\nexport const now = Date.now();\n'],
    [
      'a rule-specific block comment',
      '/* eslint-disable no-restricted-globals */\nexport const now = Date.now();\n',
    ],
    [
      'a line comment',
      '// eslint-disable-next-line no-restricted-globals\nexport const now = Date.now();\n',
    ],
  ])('cannot be switched off by %s', async (_, source) => {
    const verdict = await lint(source, RUNTIME_SOURCE);
    expect(verdict.rejections.join('\n')).toContain("'Date'");
    // `lint` runs with --max-warnings=0, so the ignored comment fails it too.
    expect(verdict.warnings.join('\n')).toContain('noInlineConfig');
  });

  it('accepts deterministic arithmetic', async () => {
    const verdict = await lint(deterministicSource, RUNTIME_SOURCE);
    expect(verdict).toEqual({ rejections: [], fatalErrors: 0, warnings: [] });
  });

  // The Producer orchestrates processes and may wait on a wall clock
  // (specification §7): the ban is scoped to the runtime sources.
  it.each(violations)('does not reject %s (%s) outside the runtime sources', async (...row) => {
    const verdict = await lint(`${row[2]}\n`, PRODUCER_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections).toEqual([]);
  });
});

interface CalculatedConfig {
  readonly rules?: Readonly<Record<string, readonly unknown[] | undefined>>;
  readonly linterOptions?: { readonly noInlineConfig?: boolean };
}

/** What the configuration says for a path; the file does not have to exist. */
async function scopeOf(...segments: string[]) {
  const config = (await eslint.calculateConfigForFile(repoPath(...segments))) as
    CalculatedConfig | undefined;
  const severity = (rule: string): unknown => config?.rules?.[rule]?.[0] ?? 0;
  return {
    determinism: [severity(GLOBALS), severity(PROPERTIES)],
    noInlineConfig: config?.linterOptions?.noInlineConfig ?? false,
    brand: severity('no-restricted-syntax'),
  };
}

// The text-based tests above lint under two paths only. A `files` glob narrowed to
// those paths, or to one directory level, would pass them; these assertions would not.
describe('scope of the guardrails', { timeout: 120_000 }, () => {
  it.each([
    ['packages', 'runtime', 'src', 'evaluate.ts'],
    ['packages', 'runtime', 'src', 'deeply', 'nested', 'module.ts'],
  ])('covers the runtime source %s/%s/%s/%s', async (...segments) => {
    expect(await scopeOf(...segments)).toEqual({
      determinism: [2, 2],
      noInlineConfig: true,
      brand: 2,
    });
  });

  it.each(['ai-sdk', 'cli', 'editor-sdk', 'player', 'producer', 'schema', 'test-fixtures'])(
    'guards the brand, but bans no clock, in the sources of %s',
    async (name) => {
      for (const segments of [['index.ts'], ['deeply', 'nested', 'module.ts']]) {
        expect(await scopeOf('packages', name, 'src', ...segments)).toEqual({
          determinism: [0, 0],
          noInlineConfig: false,
          brand: 2,
        });
      }
    },
  );

  it('lets the validator attach the brand, and tests stub clocks and forge documents', async () => {
    const free = { determinism: [0, 0], noInlineConfig: false, brand: 0 };
    expect(await scopeOf('packages', 'schema', 'src', 'validate.ts')).toEqual(free);
    expect(await scopeOf('packages', 'runtime', 'test', 'determinism.test.ts')).toEqual(free);
    expect(await scopeOf('tests', 'repo', 'lint-guardrails.test.ts')).toEqual(free);
  });
});

const forgeries: readonly (readonly [name: string, source: string])[] = [
  ['a type assertion', 'export const forge = (input: unknown) => input as ValidatedComposition;'],
  [
    'a double assertion',
    'export const forge = (input: object) => input as unknown as ValidatedComposition;',
  ],
  [
    'an assertion to a wrapped type',
    'export const forge = (input: unknown) => input as readonly ValidatedComposition[];',
  ],
  [
    'an angle-bracket assertion',
    'export const forge = (input: unknown) => <ValidatedComposition>input;',
  ],
  [
    'a type predicate',
    'export const forge = (input: unknown): input is ValidatedComposition => input !== null;',
  ],
  [
    'an assertion function',
    'export function forge(input: unknown): asserts input is ValidatedComposition {\n  if (input === null) throw new Error();\n}',
  ],
];

const withImport = (source: string, specifier: string): string =>
  `import type { ValidatedComposition } from '${specifier}';\n${source}\n`;

describe('brand of a validated composition (specification Q17)', { timeout: 120_000 }, () => {
  it.each(forgeries)('cannot be forged by %s in a package source', async (_, source) => {
    for (const [file, specifier] of [
      [SCHEMA_SOURCE, './types.js'],
      [RUNTIME_SOURCE, '@kadrion/schema'],
    ] as const) {
      const verdict = await lint(withImport(source, specifier), file);
      expect(verdict.fatalErrors).toBe(0);
      expect(verdict.rejections.join('\n')).toContain(
        'no-restricted-syntax: Only validateComposition',
      );
    }
  });

  it('cannot be forged through a namespace import either', async () => {
    const source =
      "import type * as schema from '@kadrion/schema';\nexport const forge = (input: unknown) => input as schema.ValidatedComposition;\n";
    const verdict = await lint(source, RUNTIME_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections.join('\n')).toContain(
      'no-restricted-syntax: Only validateComposition',
    );
  });

  it('is attached by the validator, the one place that is allowed to', async () => {
    const [, source] = forgeries[0] ?? ['', ''];
    const verdict = await lint(withImport(source, './types.js'), SCHEMA_VALIDATOR);
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections).toEqual([]);
  });

  it('may be forged by tests, which need invalid documents', async () => {
    const [, source] = forgeries[0] ?? ['', ''];
    const verdict = await lint(withImport(source, '../src/index.js'), SCHEMA_TEST);
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections).toEqual([]);
  });

  it('may be named as a parameter or a return type', async () => {
    const source = withImport(
      'export const read = (composition: ValidatedComposition): ValidatedComposition => composition;',
      '@kadrion/schema',
    );
    const verdict = await lint(source, RUNTIME_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections).toEqual([]);
  });
});
