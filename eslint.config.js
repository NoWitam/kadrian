import { builtinModules } from 'node:module';

import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Determinism guardrail (specification §6.1, binding; scope by D20 and D24).
 * Runtime state is derived from `(composition, timeUs)` only, and the clock
 * belongs to the host: the sources of `@kadrion/runtime`, `@kadrion/renderer-dom`,
 * and `@kadrion/schema` — the three packages of the runtime build (D21) — may
 * not reach a clock, a timer, a frame callback, a random source, or anything
 * that remembers earlier frames. The static rules and the dynamic
 * clock-independence tests complement each other: the rules also see code that
 * no test exercises and references captured when a module loads, the tests also
 * see what hides behind an alias. `tests/repo/lint-guardrails.test.ts` proves
 * that every entry rejects.
 */
const DETERMINISTIC_SOURCES = [
  'packages/runtime/src/**/*.ts',
  'packages/renderer-dom/src/**/*.ts',
  'packages/schema/src/**/*.ts',
];

/** The one source that may attach the brand (specification Q17). */
const BRAND_SOURCE = 'packages/schema/src/validate.ts';
/** The one source with a named exception to the module-state rules (D24.3). */
const MEMO_SOURCE = 'packages/schema/src/validate-structure.ts';

const DETERMINISM =
  'Runtime state is derived from (composition, timeUs) only; the clock belongs to the host (AGENTS.md, specification §6.1, D20).';

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

/**
 * Ways into the host page, its scheduler, or the network. The renderer reaches
 * the DOM only through the element it is given (`root.ownerDocument`), so it
 * works in whichever realm owns that element (D22.4).
 */
const HOST_GLOBALS = [
  'document',
  'window',
  'self',
  'globalThis',
  'queueMicrotask',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'fetch',
  'XMLHttpRequest',
  'Image',
  'FontFace',
  'getComputedStyle',
  // `new Intl.DateTimeFormat().format()` reads the wall clock.
  'Intl',
];

/** Members that lead from a DOM object to a clock or a scheduler: `view.requestAnimationFrame`. */
const HOST_MEMBERS = [
  ...NONDETERMINISTIC_GLOBALS,
  'defaultView',
  'queueMicrotask',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'fetch',
  'XMLHttpRequest',
  'FontFace',
  'getComputedStyle',
  // Web Animations run on the document timeline, a clock of the page.
  'animate',
  'getAnimations',
  'timeline',
  'timeStamp',
  // Ways back from a frame's contentWindow to the host window, or into a frame's document (D23, D24.5).
  'parent',
  'top',
  'opener',
  'frames',
  'contentDocument',
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
  // Clocks and schedulers reached through any object, such as a document's view.
  ...HOST_MEMBERS.map((property) => ({ property })),
];

/**
 * Only `validateComposition` may produce a `ValidatedComposition` (specification
 * Q17, D19). The brand is static, so a type assertion or a type predicate could
 * forge it; both are rejected in every package source except the validator.
 */
const BRAND =
  ':matches([typeName.name="ValidatedComposition"], [typeName.right.name="ValidatedComposition"])';

const BRAND_RULE = {
  selector: `:matches(TSAsExpression, TSTypeAssertion, TSTypePredicate) TSTypeReference${BRAND}`,
  message:
    'Only validateComposition may produce a ValidatedComposition (specification Q17). Validate the document instead of asserting its type.',
};

const HISTORY =
  'No module state: a module-level let, var, or object built with new, or a mutable static field, can remember earlier frames (specification §6.1, D20).';

/**
 * D24.3: the memo of checked schema objects in `validate-structure.ts`, and
 * nothing else — a module-level, non-exported `const supported = new WeakSet();`
 * without an argument. It holds frozen schema objects only (D24.2), never a
 * document, a state, or a time, so it cannot change a result. It is exempt in
 * that one file only; the same text anywhere else is an error.
 */
const MEMO_DECLARATOR =
  'Program > VariableDeclaration[kind="const"] > VariableDeclarator[id.name="supported"][init.callee.name="WeakSet"][init.arguments.length=0]';
const MEMO_CALLEE = `${MEMO_DECLARATOR} > NewExpression.init > Identifier.callee`;

/** Forms of module state that could carry a history of earlier calls. */
function moduleStateRules(exempt) {
  const declarator = exempt ? `VariableDeclarator:not(${MEMO_DECLARATOR})` : 'VariableDeclarator';
  return [
    'Program > VariableDeclaration[kind!="const"]',
    'Program > ExportNamedDeclaration > VariableDeclaration[kind!="const"]',
    `Program > VariableDeclaration > ${declarator} > NewExpression.init`,
    'Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > NewExpression.init',
    'Program > ExportDefaultDeclaration > NewExpression.declaration',
    'PropertyDefinition[static=true][readonly!=true]',
    'PropertyDefinition[static=true] > NewExpression.value',
  ].map((selector) => ({ selector, message: HISTORY }));
}

const WEAK =
  'No weak collections: WeakMap, WeakSet, WeakRef, and FinalizationRegistry can hide memory outside the DOM or observe garbage collection (D24.4).';

/** Any mention, including `Reflect.construct(WeakMap, [])` and type references. */
function weakRule(exempt) {
  const weak = 'Identifier[name=/^(WeakMap|WeakSet|WeakRef|FinalizationRegistry)$/]';
  return { selector: exempt ? `${weak}:not(${MEMO_CALLEE})` : weak, message: WEAK };
}

/** `no-restricted-syntax` of the deterministic sources; the two schema files differ as named. */
function deterministicSyntax({ brand, exempt }) {
  return ['error', ...(brand ? [BRAND_RULE] : []), ...moduleStateRules(exempt), weakRule(exempt)];
}

/**
 * D25.8: the Player loads nothing but the runtime build and the asset bytes the
 * application passes. It owns the preview clock, so no clock is banned here.
 */
const NETWORK =
  'The Player loads nothing but the runtime build and the asset bytes it is given (D25.8).';
const NETWORK_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
];

/**
 * Purity guardrail of `@kadrion/editor-sdk` (specification §9, D30.11).
 * Commands are document transforms: "the same document and command always give
 * the same result". The sources may therefore reach no clock, no timer, no
 * frame callback, no random source, no DOM, no network, no module state, and no
 * weak collection, and inline configuration cannot switch that off.
 *
 * This is a rule of its own and does **not** extend D24, which binds the three
 * packages of the runtime build because they compute frames; this one binds a
 * package that computes documents. `@kadrion/ai-sdk` shares its lists under a
 * message of its own (D31.8).
 */
const PURITY =
  'Commands are pure with respect to the document: the same document and command always give the same result (specification §9, D30.11).';

/** D31.8: the AI tool contract adapts arguments to a command; the effects belong to the host's bus. */
const AI_PURITY =
  'The AI tool contract is a pure adapter: its effects belong to the command bus the host passes in (D31.8).';

/** D31.7: a dry run through applyCommand, a bus of its own, or a validator would be a second path. */
const ONE_PATH =
  "The AI tool reaches the document only through the host's dispatch (D31.7): no applyCommand, no bus of its own, no validator.";

/**
 * Ways into the process and the system rather than the page (D31.8): the
 * environment, the module loader, and the APIs of a browser that remember or
 * deliver something between calls.
 */
const SYSTEM_GLOBALS = [
  'process',
  'global',
  'require',
  'module',
  'Buffer',
  'crypto',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'BroadcastChannel',
  'MessageChannel',
];

/**
 * Every Node built-in by its bare name (D30.11, D31.8). The `node:` prefix is
 * closed by a pattern; a bare `perf_hooks` or `os` would walk past it. The
 * list is the one of the Node that runs ESLint, so a newer Node only adds bans.
 */
const NODE_BUILTINS = [...new Set(builtinModules.map((name) => name.replace(/^node:/, '')))];

/**
 * D31.8: syntactic forms of module state that the rules of D24 do not see — a
 * module-scope array or object literal, also behind one or two type wrappers or
 * a conditional, a literal nested inside the argument of a module-scope call
 * (`Object.freeze` is shallow), and a module-scope IIFE, whose closure is state
 * too. Syntax cannot close every form; these are the ones a reviewer found.
 */
const LITERAL_STATE =
  'No module state: a module-scope array or object literal, a literal nested in a module-scope call, or a module-scope IIFE can remember calls; build data through a call that freezes it deeply (D31.8).';
const LITERAL = ':matches(ArrayExpression, ObjectExpression)';
const WRAPPER =
  ':matches(TSAsExpression, TSSatisfiesExpression, TSTypeAssertion, TSNonNullExpression)';
const MODULE_SCOPE = [
  'Program > VariableDeclaration > VariableDeclarator',
  'Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator',
];
const LITERAL_STATE_RULES = [
  ...MODULE_SCOPE.flatMap((declarator) => [
    `${declarator} > ${LITERAL}.init`,
    `${declarator} > ${WRAPPER}.init > ${LITERAL}.expression`,
    `${declarator} > ${WRAPPER}.init > ${WRAPPER}.expression > ${LITERAL}.expression`,
    `${declarator} > :matches(ConditionalExpression, LogicalExpression).init > ${LITERAL}`,
    `${declarator} > CallExpression.init ${LITERAL} > Property > ${LITERAL}.value`,
    `${declarator} > CallExpression.init ${LITERAL} > Property > ${WRAPPER}.value > ${LITERAL}`,
    `${declarator} > CallExpression.init ArrayExpression > ${LITERAL}`,
    `${declarator} > CallExpression.init > :matches(ArrowFunctionExpression, FunctionExpression).callee`,
  ]),
  `Program > ExportDefaultDeclaration > ${LITERAL}.declaration`,
  `PropertyDefinition[static=true] > ${LITERAL}.value`,
].map((selector) => ({ selector, message: LITERAL_STATE }));

/**
 * The purity rules shared by the command bus and the AI tool contract (D30.11,
 * D31.8), each under its own message. `extraSyntax` and `extraPaths` carry
 * what one package adds. The brand rule is repeated, because a later
 * `no-restricted-syntax` replaces an earlier one: without it a command could
 * assert the brand and skip the full validation of D30.6 unnoticed.
 */
function purityRules(message, { extraSyntax = [], extraPaths = [] } = {}) {
  return {
    'no-restricted-globals': [
      'error',
      ...[
        ...new Set([
          ...NONDETERMINISTIC_GLOBALS,
          ...HOST_GLOBALS,
          ...NETWORK_GLOBALS,
          ...SYSTEM_GLOBALS,
        ]),
      ].map((name) => ({ name, message })),
    ],
    'no-restricted-properties': [
      'error',
      ...PURE_PROPERTIES.map((entry) => ({ ...entry, message })),
    ],
    'no-restricted-syntax': [
      ...deterministicSyntax({ brand: true, exempt: false }),
      { selector: 'ImportExpression', message },
      ...extraSyntax,
    ],
    // The globals and members above are closed by name; a Node built-in would
    // walk straight past them (`node:perf_hooks` is a clock, `node:fs` is the world).
    'no-restricted-imports': [
      'error',
      {
        patterns: [{ group: ['node:*'], message }],
        paths: [...NODE_BUILTINS.map((name) => ({ name, message })), ...extraPaths],
      },
    ],
  };
}

/**
 * Everything the runtime build may not reach, plus every way to the network.
 * The entries are deduplicated: `no-restricted-properties` requires unique
 * items, and `fetch` and `XMLHttpRequest` are on both lists.
 */
const PURE_PROPERTIES = [
  ...new Map(
    [
      ...NONDETERMINISTIC_PROPERTIES,
      ...[...NETWORK_GLOBALS, 'sendBeacon'].map((property) => ({ property })),
    ].map((entry) => [`${entry.object ?? ''}.${entry.property}`, entry]),
  ).values(),
];

/** D29.3: frames stream to FFmpeg; the Producer writes no file, and only removes a failed output. */
const NO_FILES =
  'The Producer writes no file: frames stream to FFmpeg, and only a failed output is removed (D29.3).';

/** Every API of node:fs that creates or changes a file, and the default import that reaches them all. */
const FILE_WRITERS = [
  'default',
  'appendFile',
  'appendFileSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createWriteStream',
  'link',
  'linkSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'open',
  'openSync',
  'rename',
  'renameSync',
  'symlink',
  'symlinkSync',
  'truncate',
  'truncateSync',
  'write',
  'writeFile',
  'writeFileSync',
  'writeSync',
  'writev',
  'writevSync',
];

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
    files: ['packages/*/src/**/*.ts'],
    ignores: [BRAND_SOURCE],
    rules: {
      'no-restricted-syntax': ['error', BRAND_RULE],
    },
  },
  {
    // After the brand block: a later `no-restricted-syntax` replaces an earlier
    // one, so this block repeats the brand rule next to the module-state rules.
    files: DETERMINISTIC_SOURCES,
    // An inline `eslint-disable` must not be able to switch the guardrail off:
    // inline configuration has no effect here and is itself reported.
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-restricted-globals': [
        'error',
        ...[...NONDETERMINISTIC_GLOBALS, ...HOST_GLOBALS].map((name) => ({
          name,
          message: DETERMINISM,
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...NONDETERMINISTIC_PROPERTIES.map((entry) => ({ ...entry, message: DETERMINISM })),
      ],
      'no-restricted-syntax': deterministicSyntax({ brand: true, exempt: false }),
    },
  },
  {
    // The validator attaches the brand; everything else binds it as above.
    files: [BRAND_SOURCE],
    rules: { 'no-restricted-syntax': deterministicSyntax({ brand: false, exempt: false }) },
  },
  {
    // The named exception of D24.3, in this one file only.
    files: [MEMO_SOURCE],
    rules: { 'no-restricted-syntax': deterministicSyntax({ brand: true, exempt: true }) },
  },
  {
    files: ['packages/player/src/**/*.ts'],
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-restricted-globals': [
        'error',
        ...NETWORK_GLOBALS.map((name) => ({ name, message: NETWORK })),
      ],
      'no-restricted-properties': [
        'error',
        ...[...NETWORK_GLOBALS, 'sendBeacon'].map((property) => ({ property, message: NETWORK })),
      ],
      // After the brand block, which it must repeat (a later no-restricted-syntax replaces it).
      'no-restricted-syntax': [
        'error',
        BRAND_RULE,
        { selector: 'ImportExpression', message: NETWORK },
      ],
    },
  },
  {
    // After the brand block, which the shared rules repeat. The package imports
    // `@kadrion/schema` and its own files, nothing else (D12).
    files: ['packages/editor-sdk/src/**/*.ts'],
    linterOptions: { noInlineConfig: true },
    rules: purityRules(PURITY),
  },
  {
    // The AI tool contract: the same lists, module-scope literals, and the one
    // path to the document (D31.7, D31.8).
    files: ['packages/ai-sdk/src/**/*.ts'],
    linterOptions: { noInlineConfig: true },
    rules: {
      ...purityRules(AI_PURITY, {
        extraSyntax: LITERAL_STATE_RULES,
        extraPaths: [
          {
            name: '@kadrion/editor-sdk',
            importNames: ['applyCommand', 'createCommandBus'],
            message: ONE_PATH,
          },
          { name: '@kadrion/schema', message: ONE_PATH },
        ],
      }),
      // No type assertion: `(bus as CommandBus).getDocument()` would reach past the
      // one capability the tool is given, and no assertion is needed (D31.5).
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      // The bus belongs to the host: `bus.dispatch = …` would intercept every later edit.
      'no-param-reassign': ['error', { props: true }],
    },
  },
  {
    files: ['packages/producer/src/**/*.ts'],
    linterOptions: { noInlineConfig: true },
    rules: {
      // After the brand block, which it must repeat (a later no-restricted-syntax replaces it).
      // `createRequire` stays: `environment.ts` resolves playwright-core's manifest with it.
      'no-restricted-syntax': [
        'error',
        BRAND_RULE,
        { selector: 'ImportExpression', message: NO_FILES },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].map((name) => ({
            name,
            importNames: FILE_WRITERS,
            message: NO_FILES,
          })),
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
