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

import { readText, repoPath, repoRoot } from './repo.js';

const RUNTIME_SOURCE = repoPath('packages', 'runtime', 'src', 'index.ts');
const RENDERER_SOURCE = repoPath('packages', 'renderer-dom', 'src', 'index.ts');
const PRODUCER_SOURCE = repoPath('packages', 'producer', 'src', 'index.ts');
const PLAYER_SOURCE = repoPath('packages', 'player', 'src', 'index.ts');
const SCHEMA_SOURCE = repoPath('packages', 'schema', 'src', 'index.ts');
const SCHEMA_VALIDATOR = repoPath('packages', 'schema', 'src', 'validate.ts');
/** The one file with the named exception of D24.3. */
const SCHEMA_MEMO = repoPath('packages', 'schema', 'src', 'validate-structure.ts');
/** The packages of the runtime build, whose every source the determinism guardrail binds (D20, D24). */
const DETERMINISTIC_SOURCES = [RUNTIME_SOURCE, RENDERER_SOURCE, SCHEMA_SOURCE];
/** The Producer may wait on a wall clock (§7); the Player owns the preview clock (D20). */
const HOST_SOURCES = [PRODUCER_SOURCE, PLAYER_SOURCE];
const SCHEMA_TEST = repoPath('packages', 'schema', 'test', 'types.test.ts');
/** The command bus, whose purity guardrail is a rule of its own (§9, D30.11). */
const EDITOR_SOURCE = repoPath('packages', 'editor-sdk', 'src', 'index.ts');
/** The AI tool contract, which shares the purity lists and adds its own rules (D31.7, D31.8). */
const AI_SOURCE = repoPath('packages', 'ai-sdk', 'src', 'index.ts');

const GUARD_RULES = [
  'no-restricted-globals',
  'no-restricted-imports',
  'no-restricted-properties',
  'no-restricted-syntax',
];

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
  for (const file of [
    ...DETERMINISTIC_SOURCES,
    ...HOST_SOURCES,
    SCHEMA_VALIDATOR,
    SCHEMA_MEMO,
    EDITOR_SOURCE,
    AI_SOURCE,
  ]) {
    expect(existsSync(file), file).toBe(true);
  }
  await lint('export {};\n', RUNTIME_SOURCE);
}, 120_000);

const GLOBALS = 'no-restricted-globals';
const PROPERTIES = 'no-restricted-properties';
const SYNTAX = 'no-restricted-syntax';
/** What the module-state rules report; they name no identifier. */
const HISTORY = 'No module state';
/** What the ban on weak collections reports (D24.4). */
const WEAK = 'No weak collections';

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
  // The host page, its scheduler, and the network (D20, D22.4).
  ['document', GLOBALS, "export const element = document.createElement('div');"],
  ['window', GLOBALS, 'export const view = window;'],
  ['self', GLOBALS, 'export const view = self;'],
  ['globalThis', GLOBALS, 'export const view = globalThis;'],
  ['queueMicrotask', GLOBALS, 'queueMicrotask(() => undefined);\nexport {};'],
  ['MutationObserver', GLOBALS, 'export const observer = new MutationObserver(() => undefined);'],
  ['ResizeObserver', GLOBALS, 'export const observer = new ResizeObserver(() => undefined);'],
  [
    'IntersectionObserver',
    GLOBALS,
    'export const observer = new IntersectionObserver(() => undefined);',
  ],
  ['fetch', GLOBALS, "export const response = fetch('https://example.invalid/');"],
  ['XMLHttpRequest', GLOBALS, 'export const request = new XMLHttpRequest();'],
  ['Image', GLOBALS, 'export const image = new Image();'],
  ['FontFace', GLOBALS, "export const face = new FontFace('f', 'url(x)');"],
  [
    'getComputedStyle',
    GLOBALS,
    'export const style = (element: Element) => getComputedStyle(element);',
  ],
  ['Intl', GLOBALS, 'export const now = new Intl.DateTimeFormat().format();'],
  // Reached through the element the renderer is given.
  [
    'defaultView',
    PROPERTIES,
    'export const view = (element: Element) => element.ownerDocument.defaultView;',
  ],
  [
    'requestAnimationFrame',
    PROPERTIES,
    'export const frame = (view: { requestAnimationFrame(f: () => void): number }) =>\n  view.requestAnimationFrame(() => undefined);',
  ],
  [
    'setTimeout',
    PROPERTIES,
    'export const later = (view: { setTimeout(f: () => void): number }) =>\n  view.setTimeout(() => undefined);',
  ],
  // Web Animations run on the clock of the page.
  ['animate', PROPERTIES, 'export const run = (element: Element) => element.animate([], 1);'],
  [
    'getAnimations',
    PROPERTIES,
    'export const running = (element: Element) => element.getAnimations();',
  ],
  ['timeline', PROPERTIES, 'export const clock = (root: Element) => root.ownerDocument.timeline;'],
  ['timeStamp', PROPERTIES, 'export const when = (event: Event): number => event.timeStamp;'],
  // Ways from a frame's contentWindow back to the host window (D23, D24.5).
  [
    'parent',
    PROPERTIES,
    'export const host = (frame: HTMLIFrameElement) => frame.contentWindow?.parent;',
  ],
  [
    'top',
    PROPERTIES,
    'export const host = (frame: HTMLIFrameElement) => frame.contentWindow?.top;',
  ],
  [
    'opener',
    PROPERTIES,
    'export const host = (frame: HTMLIFrameElement) => frame.contentWindow?.opener as unknown;',
  ],
  [
    'frames',
    PROPERTIES,
    'export const all = (frame: HTMLIFrameElement) => frame.contentWindow?.frames;',
  ],
  [
    'contentDocument',
    PROPERTIES,
    'export const inner = (frame: HTMLIFrameElement) => frame.contentDocument;',
  ],
  // Weak collections hide memory outside the DOM or observe garbage collection (D24.4).
  [WEAK, SYNTAX, 'export const seen = (): WeakSet<object> => new WeakSet<object>();'],
  [WEAK, SYNTAX, 'export const memo = (): WeakMap<object, number> => new WeakMap();'],
  [WEAK, SYNTAX, 'export const make = (): object => Reflect.construct(WeakMap, []) as object;'],
  [WEAK, SYNTAX, 'export const hold = (value: object) => new WeakRef(value);'],
  [WEAK, SYNTAX, 'export const watch = () => new FinalizationRegistry<string>(() => undefined);'],
  // Module state that could remember earlier frames.
  [HISTORY, SYNTAX, 'let last = 0;\nexport const next = (): number => (last += 1);'],
  [HISTORY, SYNTAX, 'var last = 0;\nexport const read = (): number => last;'],
  [HISTORY, SYNTAX, 'export let last = 0;'],
  [HISTORY, SYNTAX, 'const cache = new Map<string, number>();\nexport const read = () => cache;'],
  [HISTORY, SYNTAX, 'export const cache = new WeakMap<object, number>();'],
  [HISTORY, SYNTAX, 'export class Memo {\n  static last = 0;\n}'],
  [HISTORY, SYNTAX, 'export class Memo {\n  static readonly cache = new Map<string, number>();\n}'],
  [HISTORY, SYNTAX, 'export default new Map<string, number>();'],
];

const deterministicSource = [
  'export const lerp = (a: number, b: number, elapsed: number, span: number): number =>',
  '  a + ((b - a) * elapsed) / span;',
  'export const floor = Math.floor(2.5);',
  // Local state, constant tables, readonly statics, and the DOM through a given element.
  'export function count(items: readonly number[]): number {',
  '  let total = 0;',
  '  for (const item of items) total += item;',
  '  return total;',
  '}',
  "export const ORDER: readonly string[] = ['a', 'b'];",
  'export class Limits {',
  '  static readonly MAX = 3;',
  '}',
  "export const make = (root: Element): Element => root.ownerDocument.createElement('div');",
  '',
].join('\n');

describe('determinism guardrail (specification §6.1, D20)', { timeout: 120_000 }, () => {
  it.each(violations)(
    'rejects %s (%s) in the runtime, renderer, and schema sources',
    async (banned, rule, source) => {
      for (const file of DETERMINISTIC_SOURCES) {
        const verdict = await lint(`${source}\n`, file);
        expect(verdict.fatalErrors).toBe(0);
        const lines = verdict.rejections.filter((line) => line.startsWith(`${rule}: `));
        expect(lines, file).not.toEqual([]);
        expect(lines.join('\n')).toContain(rule === SYNTAX ? banned : `'${banned}'`);
      }
    },
  );

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
    for (const file of DETERMINISTIC_SOURCES) {
      const verdict = await lint(source, file);
      expect(verdict.rejections.join('\n')).toContain("'Date'");
      // `lint` runs with --max-warnings=0, so the ignored comment fails it too.
      expect(verdict.warnings.join('\n')).toContain('noInlineConfig');
    }
  });

  it('accepts deterministic arithmetic, local state, and a DOM reached through its element', async () => {
    for (const file of DETERMINISTIC_SOURCES) {
      const verdict = await lint(deterministicSource, file);
      expect(verdict).toEqual({ rejections: [], fatalErrors: 0, warnings: [] });
    }
  });

  // The Producer orchestrates processes and may wait on a wall clock (§7); the
  // Player owns the preview clock and may use requestAnimationFrame (D20). The
  // Player's network ban (D25.8) is tested on its own below.
  it.each(violations)('does not reject %s (%s) in the hosts', async (...row) => {
    for (const file of HOST_SOURCES) {
      if (file === PLAYER_SOURCE && NETWORK_NAMES.includes(row[0])) continue;
      const verdict = await lint(`${row[2]}\n`, file);
      expect(verdict.fatalErrors).toBe(0);
      expect(verdict.rejections).toEqual([]);
    }
  });
});

interface CalculatedConfig {
  readonly rules?: Readonly<Record<string, readonly unknown[] | undefined>>;
  readonly linterOptions?: { readonly noInlineConfig?: boolean };
}

/** The messages that `no-restricted-syntax` is configured with for a path. */
async function syntaxMessagesOf(...segments: string[]): Promise<string[]> {
  const config = (await eslint.calculateConfigForFile(repoPath(...segments))) as
    CalculatedConfig | undefined;
  const [, ...entries] = config?.rules?.['no-restricted-syntax'] ?? [];
  return entries.map((entry) => String((entry as { message?: unknown }).message));
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
    ['packages', 'renderer-dom', 'src', 'render.ts'],
    ['packages', 'renderer-dom', 'src', 'deeply', 'nested', 'module.ts'],
    ['packages', 'schema', 'src', 'index.ts'],
    ['packages', 'schema', 'src', 'validate-structure.ts'],
    ['packages', 'schema', 'src', 'deeply', 'nested', 'module.ts'],
  ])('covers the source %s/%s/%s/%s', async (...segments) => {
    expect(await scopeOf(...segments)).toEqual({
      determinism: [2, 2],
      noInlineConfig: true,
      brand: 2,
    });
    // One block sets no-restricted-syntax for these files; it must keep the brand rule.
    const messages = await syntaxMessagesOf(...segments);
    expect(messages.some((message) => message.startsWith('Only validateComposition'))).toBe(true);
    expect(messages.filter((message) => message.startsWith(HISTORY))).toHaveLength(7);
    expect(messages.filter((message) => message.startsWith(WEAK))).toHaveLength(1);
  });

  it('binds the validator like every other schema source, except for the brand', async () => {
    expect(await scopeOf('packages', 'schema', 'src', 'validate.ts')).toEqual({
      determinism: [2, 2],
      noInlineConfig: true,
      brand: 2,
    });
    const messages = await syntaxMessagesOf('packages', 'schema', 'src', 'validate.ts');
    expect(messages.some((message) => message.startsWith('Only validateComposition'))).toBe(false);
    expect(messages.filter((message) => message.startsWith(HISTORY))).toHaveLength(7);
    expect(messages.filter((message) => message.startsWith(WEAK))).toHaveLength(1);
  });

  it.each(['cli', 'test-fixtures'])(
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

  it('guards the brand, bans no clock, and allows no inline configuration in the Producer (D29.3)', async () => {
    for (const segments of [['index.ts'], ['deeply', 'nested', 'module.ts']]) {
      expect(await scopeOf('packages', 'producer', 'src', ...segments)).toEqual({
        determinism: [0, 0],
        noInlineConfig: true,
        brand: 2,
      });
    }
  });

  it('lets tests and build scripts stub clocks and forge documents', async () => {
    const free = { determinism: [0, 0], noInlineConfig: false, brand: 0 };
    expect(await scopeOf('packages', 'schema', 'test', 'composition-schema.test.ts')).toEqual(free);
    expect(await scopeOf('packages', 'runtime', 'test', 'determinism.test.ts')).toEqual(free);
    expect(await scopeOf('packages', 'renderer-dom', 'test', 'clocks.ts')).toEqual(free);
    expect(await scopeOf('packages', 'renderer-dom', 'scripts', 'build-runtime.ts')).toEqual(free);
    expect(await scopeOf('tests', 'repo', 'lint-guardrails.test.ts')).toEqual(free);
  });
});

/** What the Player may not reach (D25.8); listed apart from the configuration on purpose. */
const NETWORK_NAMES = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
  'sendBeacon',
];

const networkViolations: readonly (readonly [banned: string, rule: string, source: string])[] = [
  ['fetch', GLOBALS, "export const load = () => fetch('https://example.invalid/');"],
  ['XMLHttpRequest', GLOBALS, 'export const request = () => new XMLHttpRequest();'],
  ['WebSocket', GLOBALS, "export const open = () => new WebSocket('wss://example.invalid/');"],
  ['EventSource', GLOBALS, "export const listen = () => new EventSource('/events');"],
  ['Worker', GLOBALS, "export const run = () => new Worker('worker.js');"],
  ['SharedWorker', GLOBALS, "export const run = () => new SharedWorker('worker.js');"],
  ['importScripts', GLOBALS, "export const pull = () => {\n  importScripts('x.js');\n};"],
  [
    'sendBeacon',
    PROPERTIES,
    "export const send = (n: Navigator) => n.sendBeacon('https://example.invalid/');",
  ],
  [
    'fetch',
    PROPERTIES,
    "export const load = (view: Window) => view.fetch('https://example.invalid/');",
  ],
  // The member form of the transports: `no-restricted-globals` sees the bare
  // name only, so a host object handed in carries them straight past it.
  [
    'WebSocket',
    PROPERTIES,
    "export const open = (host: { WebSocket: new (url: string) => unknown }) =>\n  new host.WebSocket('wss://example.invalid/');",
  ],
  [
    'EventSource',
    PROPERTIES,
    "export const listen = (host: { EventSource: new (url: string) => unknown }) =>\n  new host.EventSource('/events');",
  ],
  [
    'Worker',
    PROPERTIES,
    "export const run = (host: { Worker: new (url: string) => unknown }) =>\n  new host.Worker('worker.js');",
  ],
  [
    'The Player loads nothing',
    SYNTAX,
    "export const load = () => import('https://example.invalid/x.js');",
  ],
];

describe('network guardrail of the Player (D25.8)', { timeout: 120_000 }, () => {
  it.each(networkViolations)(
    'rejects %s (%s) in the Player sources',
    async (banned, rule, source) => {
      const verdict = await lint(`${source}\n`, PLAYER_SOURCE);
      expect(verdict.fatalErrors).toBe(0);
      const lines = verdict.rejections.filter((line) => line.startsWith(`${rule}: `));
      expect(lines).not.toEqual([]);
      expect(lines.join('\n')).toContain(rule === SYNTAX ? banned : `'${banned}'`);
    },
  );

  it('still lets the Player own the preview clock', async () => {
    const source = [
      'export const tick = (view: Window, f: () => void): number => view.requestAnimationFrame(f);',
      'export const now = (): number => performance.now();',
      'export const later = (f: () => void): number => window.setTimeout(f, 1);',
      '',
    ].join('\n');
    expect(await lint(source, PLAYER_SOURCE)).toEqual({
      rejections: [],
      fatalErrors: 0,
      warnings: [],
    });
  });

  it('cannot be switched off inline', async () => {
    const verdict = await lint(
      "// eslint-disable-next-line no-restricted-globals\nexport const load = () => fetch('x');\n",
      PLAYER_SOURCE,
    );
    expect(verdict.rejections.join('\n')).toContain("'fetch'");
    expect(verdict.warnings.join('\n')).toContain('noInlineConfig');
  });

  it.each([['index.ts'], ['deeply', 'nested', 'module.ts']])(
    'covers the Player source %s, keeps its brand rule, and bans no clock',
    async (...segments) => {
      const config = (await eslint.calculateConfigForFile(
        repoPath('packages', 'player', 'src', ...segments),
      )) as CalculatedConfig | undefined;
      const names = (config?.rules?.['no-restricted-globals'] ?? [])
        .slice(1)
        .map((entry) => (entry as { name: string }).name);
      expect(names.sort()).toEqual(NETWORK_NAMES.filter((name) => name !== 'sendBeacon').sort());
      expect(config?.linterOptions?.noInlineConfig).toBe(true);
      const messages = await syntaxMessagesOf('packages', 'player', 'src', ...segments);
      expect(messages.some((message) => message.startsWith('Only validateComposition'))).toBe(true);
    },
  );
});

/** Ways to write a file from the Producer (D29.3), each with the name the rule reports. */
const fileWrites: readonly (readonly [string, string])[] = [
  ["import { writeFile } from 'node:fs/promises';\nexport const f = writeFile;", 'writeFile'],
  ["import { writeFileSync } from 'node:fs';\nexport const f = writeFileSync;", 'writeFileSync'],
  [
    "import { createWriteStream } from 'fs';\nexport const f = createWriteStream;",
    'createWriteStream',
  ],
  ["import { mkdtemp } from 'fs/promises';\nexport const f = mkdtemp;", 'mkdtemp'],
  ["import { open } from 'node:fs/promises';\nexport const f = open;", 'open'],
  ["import fs from 'node:fs';\nexport const f = fs;", 'default'],
  ["import * as fs from 'node:fs';\nexport const f = fs;", 'node:fs'],
];

describe('the Producer writes no file (D29.3)', { timeout: 120_000 }, () => {
  it.each(fileWrites)('rejects %s', async (source, banned) => {
    const verdict = await lint(`${source}\n`, PRODUCER_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    const lines = verdict.rejections.filter((line) => line.startsWith('no-restricted-imports: '));
    expect(lines).not.toEqual([]);
    expect(lines.join('\n')).toContain(banned);
  });

  it('rejects a dynamic import, which the import rule cannot see', async () => {
    const verdict = await lint(
      "export const load = async () => (await import('node:fs')).writeFileSync;\n",
      PRODUCER_SOURCE,
    );
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections.join('\n')).toContain('no-restricted-syntax');
  });

  it('still lets the Producer read files and remove a failed output', async () => {
    const source = [
      "import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';",
      "import { rm } from 'node:fs/promises';",
      'export const read = [createReadStream, existsSync, readFileSync, statSync, rm];',
      '',
    ].join('\n');
    expect(await lint(source, PRODUCER_SOURCE)).toEqual({
      rejections: [],
      fatalErrors: 0,
      warnings: [],
    });
  });

  it('cannot be switched off inline', async () => {
    const verdict = await lint(
      "// eslint-disable-next-line no-restricted-imports\nimport { writeFile } from 'node:fs/promises';\nexport const f = writeFile;\n",
      PRODUCER_SOURCE,
    );
    expect(verdict.rejections.join('\n')).toContain('writeFile');
    expect(verdict.warnings.join('\n')).toContain('noInlineConfig');
  });
});

/** The memo of D24.3, exactly as the exception names it. */
const MEMO =
  'const supported = new WeakSet();\nexport const known = (o: object): boolean => supported.has(o);\n';

describe('the named exception of D24.3', { timeout: 120_000 }, () => {
  it('accepts the memo of checked schema objects in validate-structure.ts', async () => {
    expect(await lint(MEMO, SCHEMA_MEMO)).toEqual({ rejections: [], fatalErrors: 0, warnings: [] });
  });

  it.each([
    [
      'another name',
      'const visited = new WeakSet();\nexport const known = (o: object): boolean => visited.has(o);',
    ],
    ['an export', 'export const supported = new WeakSet();'],
    [
      'let',
      'let supported = new WeakSet();\nexport const reset = (): void => {\n  supported = new WeakSet();\n};',
    ],
    [
      'an argument',
      'const supported = new WeakSet([{}]);\nexport const known = (o: object): boolean => supported.has(o);',
    ],
    [
      'a WeakMap',
      'const supported = new WeakMap<object, boolean>();\nexport const known = (o: object) => supported.get(o);',
    ],
    [
      'a second declarator',
      'const supported = new WeakSet(),\n  other = new WeakSet();\nexport const known = (o: object): boolean => supported.has(o) || other.has(o);',
    ],
    [
      'a construction without new',
      'const supported = Reflect.construct(WeakMap, []) as WeakMap<object, boolean>;\nexport const known = (o: object) => supported.get(o);',
    ],
    [
      'a local weak collection',
      'export const seen = (): WeakSet<object> => new WeakSet<object>();',
    ],
  ])('still rejects %s in that file', async (_, source) => {
    const verdict = await lint(`${source}\n`, SCHEMA_MEMO);
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections.join('\n')).toMatch(
      /no-restricted-syntax: No (module state|weak collections)/,
    );
  });

  it('does not extend to any other file', async () => {
    for (const file of [...DETERMINISTIC_SOURCES, SCHEMA_VALIDATOR]) {
      const verdict = await lint(MEMO, file);
      expect(verdict.fatalErrors).toBe(0);
      const text = verdict.rejections.join('\n');
      expect(text, file).toContain(`no-restricted-syntax: ${HISTORY}`);
      expect(text, file).toContain(`no-restricted-syntax: ${WEAK}`);
    }
  });

  it('is the memo that validate-structure.ts really declares', () => {
    const source = readText('packages', 'schema', 'src', 'validate-structure.ts');
    expect(source.match(/WeakSet|WeakMap|WeakRef|FinalizationRegistry/g)).toEqual(['WeakSet']);
    expect(source).toContain('\nconst supported = new WeakSet();\n');
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
      [RENDERER_SOURCE, '@kadrion/schema'],
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

/**
 * Purity guardrail of the command bus (§9, D30.11). Commands are document
 * transforms, so the same violations the runtime build refuses are refused
 * here — for a different reason and under a different rule than D24's, which
 * this block deliberately does not extend. The lists are the ones above, so an
 * entry deleted from the configuration fails here too.
 */
const pureSource = [
  'export interface Point {',
  '  readonly x: number;',
  '  readonly y: number;',
  '}',
  'export const round = (value: number): number => Math.round(value);',
  'export function total(items: readonly number[]): number {',
  '  let sum = 0;',
  '  for (const item of items) sum += item;',
  '  return sum;',
  '}',
  "export const AXES: readonly string[] = ['x', 'y'];",
  'export const freeze = (point: Point): Point => Object.freeze({ ...point });',
  '',
].join('\n');

describe('purity guardrail of the command bus (§9, D30.11)', { timeout: 120_000 }, () => {
  it.each(violations)('rejects %s (%s) in the editor SDK', async (banned, rule, source) => {
    const verdict = await lint(`${source}\n`, EDITOR_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    const lines = verdict.rejections.filter((line) => line.startsWith(`${rule}: `));
    expect(lines, EDITOR_SOURCE).not.toEqual([]);
    expect(lines.join('\n')).toContain(rule === SYNTAX ? banned : `'${banned}'`);
  });

  it.each(networkViolations)(
    'rejects %s (%s) in the editor SDK too, under its own message',
    async (banned, rule, source) => {
      const verdict = await lint(`${source}\n`, EDITOR_SOURCE);
      expect(verdict.fatalErrors).toBe(0);
      const lines = verdict.rejections.filter((line) => line.startsWith(`${rule}: `));
      expect(lines, banned).not.toEqual([]);
      expect(lines.join('\n')).toContain('Commands are pure');
    },
  );

  it('rejects a dynamic import, so the bus stays self-contained', async () => {
    const source = "export const load = async (): Promise<unknown> => import('./other.js');\n";
    expect((await lint(source, EDITOR_SOURCE)).rejections.join('\n')).toContain(
      'Commands are pure',
    );
  });

  it.each([
    [
      'node:perf_hooks',
      "import { performance } from 'node:perf_hooks';\nexport const now = (): number => performance.now();",
    ],
    [
      'node:fs',
      "import { readFileSync } from 'node:fs';\nexport const read = (): unknown => readFileSync('x');",
    ],
    [
      'perf_hooks',
      "import { performance } from 'perf_hooks';\nexport const now = (): number => performance.now();",
    ],
  ])('rejects a static import of %s, which no rule on names would see', async (_, source) => {
    const verdict = await lint(`${source}\n`, EDITOR_SOURCE);
    const lines = verdict.rejections.filter((line) => line.startsWith('no-restricted-imports: '));
    expect(lines).not.toEqual([]);
    expect(lines.join('\n')).toContain('Commands are pure');
  });

  it('still admits the one dependency the package has (D12)', async () => {
    const source = [
      "import { validateComposition } from '@kadrion/schema';",
      'export const check = (document: unknown): boolean => validateComposition(document).ok;',
      '',
    ].join('\n');
    expect(await lint(source, EDITOR_SOURCE)).toEqual({
      rejections: [],
      fatalErrors: 0,
      warnings: [],
    });
  });

  it.each([
    ['a block comment', '/* eslint-disable */\nexport const now = Date.now();\n'],
    [
      'a rule-specific block comment',
      '/* eslint-disable no-restricted-globals */\nexport const now = Date.now();\n',
    ],
  ])('cannot be switched off by %s', async (_, source) => {
    const verdict = await lint(source, EDITOR_SOURCE);
    expect(verdict.rejections.join('\n')).toContain("'Date'");
    expect(verdict.warnings.join('\n')).toContain('noInlineConfig');
  });

  it('keeps the brand rule, without which a command could skip the full validation (D30.6)', async () => {
    const messages = await syntaxMessagesOf('packages', 'editor-sdk', 'src', 'apply.ts');
    expect(messages.some((message) => message.startsWith('Only validateComposition'))).toBe(true);
    expect(messages.filter((message) => message.startsWith(HISTORY))).toHaveLength(7);
    expect(messages.filter((message) => message.startsWith(WEAK))).toHaveLength(1);
  });

  it('binds every source of the package, however deeply nested', async () => {
    for (const segments of [['index.ts'], ['deeply', 'nested', 'module.ts']]) {
      expect(await scopeOf('packages', 'editor-sdk', 'src', ...segments)).toEqual({
        determinism: [2, 2],
        noInlineConfig: true,
        brand: 2,
      });
    }
  });

  it('accepts pure arithmetic, local state, and a constant table', async () => {
    expect(await lint(pureSource, EDITOR_SOURCE)).toEqual({
      rejections: [],
      fatalErrors: 0,
      warnings: [],
    });
  });
});

/** The two purity blocks and the message each reports (D30.11, D31.8). */
const PURE_PACKAGES = [
  { name: 'editor-sdk', file: EDITOR_SOURCE, message: 'Commands are pure' },
  { name: 'ai-sdk', file: AI_SOURCE, message: 'The AI tool contract is a pure adapter' },
] as const;

/**
 * Ways into the process and the system that no rule on clocks names (D31.8).
 * Both purity blocks refuse them; the list is written out apart from the
 * configuration, so an entry deleted there fails here.
 */
const systemViolations: readonly (readonly [banned: string, source: string])[] = [
  ['process', 'export const env = (): unknown => process.env;'],
  ['process', "export const home = (): unknown => process.env['HOME'];"],
  ['process', 'export const cwd = (): string => process.cwd();'],
  ['global', 'export const host = (): unknown => global;'],
  ['require', "export const load = (): unknown => require('x');"],
  ['module', 'export const self = (): unknown => module;'],
  ['Buffer', "export const bytes = (): unknown => Buffer.from('x');"],
  ['crypto', 'export const subtle = (): unknown => crypto.subtle;'],
  ['navigator', 'export const agent = (): unknown => navigator.userAgent;'],
  ['location', 'export const here = (): unknown => location.href;'],
  ['localStorage', "export const read = (): unknown => localStorage.getItem('x');"],
  ['sessionStorage', "export const read = (): unknown => sessionStorage.getItem('x');"],
  ['indexedDB', "export const open = (): unknown => indexedDB.open('x');"],
  ['BroadcastChannel', "export const open = (): unknown => new BroadcastChannel('x');"],
  ['MessageChannel', 'export const open = (): unknown => new MessageChannel();'],
];

/**
 * Node built-ins by bare name and by specifier. A fixed subset rather than
 * Node's own list, which differs between the versions `engines` admits.
 */
const builtinImports: readonly string[] = [
  'os',
  'node:os',
  'util',
  'fs/promises',
  'path/posix',
  'perf_hooks',
  'module',
  'events',
  'node:process',
];

describe.each(PURE_PACKAGES)(
  'purity lists shared by $name (D30.11, D31.8)',
  { timeout: 120_000 },
  ({ file, message }) => {
    it.each(systemViolations)('rejects the global %s', async (banned, source) => {
      const verdict = await lint(`${source}\n`, file);
      expect(verdict.fatalErrors).toBe(0);
      const lines = verdict.rejections.filter((line) => line.startsWith(`${GLOBALS}: `));
      expect(lines.join('\n')).toContain(`'${banned}'`);
      expect(lines.join('\n')).toContain(message);
    });

    it.each(builtinImports)('rejects a static import of %s', async (specifier) => {
      const source = `import * as builtin from '${specifier}';\nexport const use = (): unknown => builtin;\n`;
      const verdict = await lint(source, file);
      const lines = verdict.rejections.filter((line) => line.startsWith('no-restricted-imports: '));
      expect(lines, specifier).not.toEqual([]);
      expect(lines.join('\n')).toContain(message);
    });
  },
);

/** What the AI tool contract may not import: a second path to the document (D31.7). */
const ONE_PATH = 'only through the host';
/** What the ban on module-scope literals reports (D31.8). */
const LITERAL_STATE = 'No module state: a module-scope array or object literal';

const secondPaths: readonly (readonly [label: string, source: string])[] = [
  [
    'applyCommand',
    "import { applyCommand } from '@kadrion/editor-sdk';\nexport const run = applyCommand;",
  ],
  [
    'createCommandBus',
    "import { createCommandBus } from '@kadrion/editor-sdk';\nexport const make = createCommandBus;",
  ],
  [
    'a namespace import of editor-sdk',
    "import * as sdk from '@kadrion/editor-sdk';\nexport const run = sdk.applyCommand;",
  ],
  ['a re-export of applyCommand', "export { applyCommand } from '@kadrion/editor-sdk';"],
  [
    'the validator',
    "import { validateComposition } from '@kadrion/schema';\nexport const check = validateComposition;",
  ],
  [
    'a type of the schema',
    "import type { ValidatedComposition } from '@kadrion/schema';\nexport type Document = ValidatedComposition;",
  ],
];

const literalStates: readonly (readonly [label: string, source: string])[] = [
  [
    'an array',
    'const calls: unknown[] = [];\nexport const record = (call: unknown) => calls.push(call);',
  ],
  ['an exported object', 'export const cache: Record<string, unknown> = {};'],
  [
    'an array behind as',
    'const calls = [] as unknown[];\nexport const count = () => calls.length;',
  ],
  ['an object behind satisfies', 'export const cache = {} satisfies object;'],
  ['an array behind an angle-bracket assertion', 'export const calls = <unknown[]>[];'],
  ['an object behind a non-null assertion', 'export const cache = { last: 0 }!;'],
  ['a default export', 'export default { last: 0 };'],
  ['a static readonly field', 'export class Memo {\n  static readonly calls: unknown[] = [];\n}'],
  // The forms the post-implementation review of PR-09 found past the first rules.
  ['an array behind two casts', 'export const calls = [] as unknown as unknown[];'],
  ['an array behind a conditional', 'export const calls: unknown[] = Math.PI > 3 ? [] : [];'],
  ['an array behind a logical operator', 'export const calls: unknown[] = null ?? [];'],
  ['a literal nested in a frozen object', 'export const memo = Object.freeze({ calls: [0] });'],
  [
    'a literal inside a shallow freeze',
    'export const memo = Object.freeze({ calls: [] as unknown[] });',
  ],
  ['a literal inside an array argument', 'export const memo = Object.freeze([{ calls: 0 }]);'],
  [
    'the closure of an IIFE',
    'export const next = (() => {\n  let n = 0;\n  return (): number => (n += 1);\n})();',
  ],
  [
    'the closure of a function-expression IIFE',
    'export const next = (function () {\n  let n = 0;\n  return (): number => (n += 1);\n})();',
  ],
];

const pureAdapterSource = [
  "import { EditorError, setNodePositionArgumentsSchema, type CommandBus } from '@kadrion/editor-sdk';",
  "export const tool = Object.freeze({ name: 't', inputSchema: setNodePositionArgumentsSchema });",
  "export function run(bus: Pick<CommandBus, 'dispatch'>, args: unknown): unknown {",
  "  if (typeof args !== 'object' || args === null) throw new EditorError('invalid-argument', 'x');",
  "  const local = { type: 'SetNodePosition', ...args };",
  '  const list = [local];',
  '  return bus.dispatch(list[0]);',
  '}',
  '',
].join('\n');

describe('purity guardrail of the AI tool contract (D31.7, D31.8)', { timeout: 120_000 }, () => {
  it.each(violations)('rejects %s (%s) in the AI SDK', async (banned, rule, source) => {
    const verdict = await lint(`${source}\n`, AI_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    const lines = verdict.rejections.filter((line) => line.startsWith(`${rule}: `));
    expect(lines, AI_SOURCE).not.toEqual([]);
    expect(lines.join('\n')).toContain(rule === SYNTAX ? banned : `'${banned}'`);
  });

  it.each(networkViolations)(
    'rejects %s (%s) in the AI SDK too, under its own message',
    async (banned, rule, source) => {
      const verdict = await lint(`${source}\n`, AI_SOURCE);
      expect(verdict.fatalErrors).toBe(0);
      const lines = verdict.rejections.filter((line) => line.startsWith(`${rule}: `));
      expect(lines, banned).not.toEqual([]);
      expect(lines.join('\n')).toContain('The AI tool contract is a pure adapter');
    },
  );

  it.each(secondPaths)('refuses %s, a second path to the document', async (_, source) => {
    const verdict = await lint(`${source}\n`, AI_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    const lines = verdict.rejections.filter((line) => line.startsWith('no-restricted-imports: '));
    expect(lines).not.toEqual([]);
    expect(lines.join('\n')).toContain(ONE_PATH);
  });

  it.each(literalStates)('refuses module state held in %s', async (_, source) => {
    const verdict = await lint(`${source}\n`, AI_SOURCE);
    expect(verdict.fatalErrors).toBe(0);
    expect(verdict.rejections.join('\n')).toContain(`${SYNTAX}: ${LITERAL_STATE}`);
  });

  it.each([
    [
      'a cast of the bus to reach its other methods',
      "import type { CommandBus } from '@kadrion/editor-sdk';\nexport const peek = (bus: Pick<CommandBus, 'dispatch'>): unknown =>\n  (bus as CommandBus).getDocument();",
      '@typescript-eslint/consistent-type-assertions',
    ],
    [
      'an angle-bracket cast',
      'export const widen = (value: unknown): object => <object>value;',
      '@typescript-eslint/consistent-type-assertions',
    ],
    [
      'a replaced dispatch on the host bus',
      "import type { CommandBus } from '@kadrion/editor-sdk';\nexport function hook(bus: Pick<CommandBus, 'dispatch'>): void {\n  const original = bus.dispatch;\n  bus.dispatch = (command) => original(command);\n}",
      'no-param-reassign',
    ],
  ])('refuses %s (D31.5)', async (_, source, rule) => {
    const results = await eslint.lintText(`${source}\n`, { filePath: AI_SOURCE });
    const rules = results.flatMap((result) => result.messages).map((message) => message.ruleId);
    expect(rules).toContain(rule);
  });

  it('still admits a const assertion, which widens nothing', async () => {
    const source = "export const kind = (): 'SetNodePosition' => 'SetNodePosition' as const;\n";
    const results = await eslint.lintText(source, { filePath: AI_SOURCE });
    expect(results.flatMap((result) => result.messages)).toEqual([]);
  });

  it('admits the imports and the shape the adapter needs', async () => {
    expect(await lint(pureAdapterSource, AI_SOURCE)).toEqual({
      rejections: [],
      fatalErrors: 0,
      warnings: [],
    });
  });

  it('keeps the literal rule to the AI SDK: the command bus may hold a constant table', async () => {
    const source = "export const AXES: readonly string[] = ['x', 'y'];\n";
    expect((await lint(source, EDITOR_SOURCE)).rejections).toEqual([]);
    expect((await lint(source, AI_SOURCE)).rejections.join('\n')).toContain(LITERAL_STATE);
  });

  it.each([
    ['a block comment', '/* eslint-disable */\nexport const now = Date.now();\n'],
    [
      'a rule-specific block comment',
      "/* eslint-disable no-restricted-imports */\nexport { applyCommand } from '@kadrion/editor-sdk';\n",
    ],
  ])('cannot be switched off by %s', async (_, source) => {
    const verdict = await lint(source, AI_SOURCE);
    expect(verdict.rejections).not.toEqual([]);
    expect(verdict.warnings.join('\n')).toContain('noInlineConfig');
  });

  it('keeps the brand rule, the module-state rules, and the literal rules', async () => {
    const messages = await syntaxMessagesOf('packages', 'ai-sdk', 'src', 'set-node-position.ts');
    expect(messages.some((message) => message.startsWith('Only validateComposition'))).toBe(true);
    // Both messages open with "No module state"; the literal rules are counted apart.
    const literal = messages.filter((message) => message.startsWith(LITERAL_STATE));
    const history = messages.filter((message) => message.startsWith(HISTORY));
    expect(history.length - literal.length).toBe(7);
    expect(literal).toHaveLength(18);
    expect(messages.filter((message) => message.startsWith(WEAK))).toHaveLength(1);
  });

  it('binds every source of the package, however deeply nested', async () => {
    for (const segments of [['index.ts'], ['deeply', 'nested', 'module.ts']]) {
      expect(await scopeOf('packages', 'ai-sdk', 'src', ...segments)).toEqual({
        determinism: [2, 2],
        noInlineConfig: true,
        brand: 2,
      });
    }
  });
});
