# D11 — Monorepo tooling baseline

- Status: Accepted — by the project owner on 2026-09-22
- Date: 2026-09-21
- Related: D10, D12

## Context

The repository contained only `AGENTS.md` and `CLAUDE.md`. `CLAUDE.md` refers to a
`/bootstrap-kadrion` skill for the first setup, but no `.claude/` directory
exists in the repository, on the remote, or at user level, so whatever tooling
that skill prescribes is unknown. The identifier D11 may also collide with a
decision defined there; the project owner should confirm the number.

`AGENTS.md` requires typecheck, tests, lint, and build for every task, small
reviewable changes, no speculative abstractions, pinned tools, and explicit
package boundaries.

Evidence gathered on 2026-09-21 (Windows 11, Node.js 22.22.0, Corepack 0.34.0):

1. `typescript-eslint` 8.70.x declares the peer range `typescript >=4.8.4 <6.1.0`.
   TypeScript 7.0.2 (`latest`) therefore cannot be used for type-aware linting;
   6.0.3 is the newest supported release.
2. Corepack 0.34.0, bundled with Node.js 22.22.0, launches pnpm 10.34.5 and
   11.27.x but fails on pnpm 12.5.1 (`Cannot find module …\bin\pnpm.cjs`).
   pnpm 12.0.0 was released on 2026-08-26 and had five minor releases in under
   four weeks; 11.x is still maintained.
3. When pnpm is only available as `corepack pnpm`, a package script that calls
   `pnpm` fails (`'pnpm' is not recognized`). `node --run <script>` works and
   propagates exit codes.
4. `tsc -b --noEmit` fails with TS6310 as soon as one project references
   another. A non-emitting leaf project (tests) can be referenced from the
   solution and is type-checked by `tsc -b`.
5. Vitest 5.0.0 was released on 2026-09-03 and turns `vite` into a peer
   dependency; 4.1.11 carries `vite` as a regular dependency.
6. Prettier flags `AGENTS.md` and `CLAUDE.md` (trailing blank line, plus CRLF in
   a Windows working tree under `core.autocrlf=true`).

## Decision

| Concern         | Choice                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager | pnpm 11.27.0 workspaces, pinned with an integrity hash in `packageManager`, launched through Corepack                                                                                                                        |
| Install policy  | Exact versions (`saveExact`), committed lockfile, `minimumReleaseAge: 1440` (24 h cooling-off), `engineStrict`                                                                                                               |
| Node.js         | `.node-version` pins 22.22.0; `engines.node` is `>=22.13.0` (the floor of pnpm 11 and ESLint 10)                                                                                                                             |
| Language        | TypeScript 6.0.3, ESM only, `module`/`moduleResolution: NodeNext`, `target: ES2022`, `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly` |
| Ambient types   | The base config sets `lib: ["ES2022"]` and `types: []`. DOM and Node.js types are opted into per project, so pure packages cannot touch them by accident                                                                     |
| Build           | TypeScript project references: one root solution, one composite project per package (`src` → `dist`). No bundler and no task runner yet                                                                                      |
| Tests           | Vitest 4.1.11 with one root config                                                                                                                                                                                           |
| Lint            | ESLint 10.11.0 flat config: `@eslint/js` recommended plus `typescript-eslint` 8.70.0 `strictTypeChecked` with `projectService`                                                                                               |
| Format          | Prettier 3.9.8. `AGENTS.md`, `CLAUDE.md`, and `.claude/` are excluded: they are owned by the project owner and never rewritten by tooling                                                                                    |
| Line endings    | `.gitattributes` stores and checks out text as LF and marks fixture formats as binary                                                                                                                                        |

Rules that follow from the evidence:

- **Every TypeScript file belongs to exactly one project.** Package sources live
  in `packages/<name>/src`. Package tests live in `packages/<name>/test` with
  their own non-emitting `tsconfig.json` that references the package.
  Repository-level checks live in `tests/`. Every project is referenced from the
  root `tsconfig.json`; `tests/repo/workspace-structure.test.ts` fails when a
  package or a package test directory is not.
- **Scripts exist only at the root** and never call the package manager:
  `check` chains the other scripts with `node --run`, with `build` before
  `test`.
- **`typecheck` and `build` are both `tsc -b` for now**, because of evidence
  item 4. `build` will grow when the runtime bundle arrives; `typecheck` stays.
- **Cross-package imports resolve to built output** (amended by PR-01 on
  2026-09-21 with the first cross-package import; this point was previously
  listed as open). A workspace package is imported by its package name and
  resolves through `exports` to `dist`; there is no source export condition and
  no test-runner alias, so tests exercise what a consumer gets. A package's own
  tests import its sources relatively (`../src/index.js`). Build order is
  explicit: every workspace dependency has a matching TypeScript project
  reference — runtime dependencies in the package's `tsconfig.json`,
  `devDependencies` in its `test/tsconfig.json` — and
  `tests/repo/workspace-structure.test.ts` fails when one is missing or when
  `exports` stops pointing at `dist`. Because a stale `dist` would otherwise
  give confusing results, the root `test` script builds first
  (`node --run build && vitest run`). Running `vitest` directly, for example in
  watch mode, does not rebuild dependencies.

## Alternatives considered

- **npm workspaces** — no Corepack prerequisite, but hoisting makes every
  workspace package importable whether or not it is declared, so checking
  declared dependencies (D12) would no longer catch undeclared imports.
- **pnpm 12.x** — not launchable by the bundled Corepack and a very young major.
- **pnpm 10.34.5** — works, but 11.x is the actively maintained line that the
  bundled Corepack still launches.
- **TypeScript 7.0.2** — faster native compiler, but no type-aware linting yet.
  Type-aware rules such as `no-floating-promises` matter for the Producer's
  process orchestration. The configuration avoids options deprecated in 6.0, so
  the upgrade is a version bump.
- **Vitest 5.x** — nothing in PR-00 needs it, and it adds a top-level pin.
- **Biome or oxlint** — not evaluated in depth. ESLint was chosen because the
  determinism guardrail planned for the runtime needs per-directory restricted
  globals and properties in addition to type-aware rules.
- **Turborepo/Nx, bundlers, coverage gates, Git hooks, release tooling** — not
  required by the current slice.

## Consequences

- Prerequisites are Node.js 22 with its bundled Corepack: run
  `corepack enable pnpm` once, or prefix commands with `corepack`. Corepack is no
  longer bundled from Node.js 25 on; a standalone pnpm honours the
  `packageManager` pin, so the pin survives that change.
- Installing creates state outside the repository: the Corepack cache in the
  user profile and pnpm's content-addressable store, which pnpm places on the
  same volume as the checkout.
- `typecheck` writes `dist/` as a side effect.
- Upgrade triggers: TypeScript 7 when `typescript-eslint` supports it; pnpm 12
  when the bundled Corepack can launch it or a standalone pnpm becomes the
  documented prerequisite; Vitest 5 when a feature is needed.

Decisions deliberately left open:

- **The single runtime build artifact and its bundler** — open question Q12 in
  the [vertical-spike specification](../spike/vertical-spike.md).
- **CI** — deferred because a workflow cannot be verified before the first push
  (Q14).
- **The determinism lint guardrail** — lands with the first runtime code,
  together with a test that proves it rejects forbidden inputs (specification
  §6.1).

## Verification

`node --run check` (or `corepack pnpm run check`) runs typecheck, lint, format
check, build, and tests. The repository-level tests in `tests/repo` check the
workspace structure that this ADR describes.
