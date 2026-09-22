# Kadrion

Kadrion is a TypeScript engine for describing, previewing, editing, and
deterministically rendering video compositions. It is an engine/SDK, not an
end-user application, and it does not depend on any consumer product.

**Status: vertical-spike phase.** PR-00 laid the monorepo foundation. PR-01 added
the reference composition (`@kadrion/test-fixtures`) and schema `0.1`
(`@kadrion/schema`): JSON Schema, derived types, validation with typed errors,
and the frame grid (D13–D17, accepted). PR-02 added the evaluation core of
`@kadrion/runtime`: the state of a composition at `timeUs`, without DOM, layout,
or assets, checked against a hand-derived expected state. That implementation is
**provisional** until the project owner accepts ADRs D18 and D19. The other
packages are empty skeletons.

## Documentation

- [`AGENTS.md`](AGENTS.md) — binding project instructions: decisions, invariants,
  package boundaries, workflow
- [`docs/adr`](docs/adr/README.md) — decision log (D01–D10 and D13–D17 accepted;
  D11, D12, D18, and D19 proposed)
- [`docs/spike/vertical-spike.md`](docs/spike/vertical-spike.md) — what the
  vertical spike has to prove, acceptance criteria, open questions, PR sequence
- [`docs/architecture/package-boundaries.json`](docs/architecture/package-boundaries.json)
  — machine-checked package dependency map (see D12)

## Requirements

- Node.js 22 (`.node-version` pins 22.22.0; `engines` requires `>=22.13.0`)
- pnpm 11.27.0, pinned in `package.json` and launched through Corepack, which
  ships with Node.js 22. Either run `corepack enable pnpm` once, or prefix every
  pnpm command with `corepack`, as the examples below do.

FFmpeg and a pinned Chromium are not needed yet; the Producer pull requests
introduce them.

## Commands

```bash
corepack pnpm install
corepack pnpm run check
```

| Script         | What it does                                                            |
| -------------- | ----------------------------------------------------------------------- |
| `typecheck`    | `tsc -b`: type-checks every project, including tests (writes `dist/`)   |
| `lint`         | ESLint with type-aware rules, zero warnings allowed                     |
| `format:check` | Prettier check (`format` rewrites files)                                |
| `build`        | `tsc -b`: emits `dist/` for every package                               |
| `test`         | Builds, then Vitest: repository-level checks and package tests          |
| `check`        | All of the above in that order; this is the gate for every pull request |
| `clean`        | Removes TypeScript build output                                         |

After installation the scripts also run without pnpm, for example
`node --run check`.

## Layout

```text
packages/
  schema/ runtime/ player/ editor-sdk/ ai-sdk/ producer/ cli/ test-fixtures/
docs/
  adr/            decision log
  architecture/   package dependency map
  spike/          vertical-spike specification
tests/
  repo/           repository-level checks (boundaries, workspace structure, ADR log)
```

## Conventions enforced by `tests/repo`

- The set of packages equals the list in `AGENTS.md`; each manifest is private,
  unlicensed, ESM, and described by its responsibility line from `AGENTS.md`.
- Workspace dependencies stay within the map in
  `docs/architecture/package-boundaries.json`; external runtime dependencies
  must be on its allowlist, with a reason and a licence.
- Every TypeScript file belongs to exactly one project. Package sources live in
  `packages/<name>/src`; package tests live in `packages/<name>/test` with a
  non-emitting `tsconfig.json` that references the package. Every project is
  referenced from the root `tsconfig.json`.
- Workspace packages are imported by name and resolve through `exports` to
  `dist`, so tests see what a consumer gets and `build` precedes `test`. Every
  workspace dependency has a matching TypeScript project reference (D11).
- Source files import only declared runtime dependencies (D12).
- No binary asset ships while the reference composition still carries
  placeholder hashes (D14).
- The hand-derived expected state stays in step with the reference composition
  and with the golden timestamps of `AGENTS.md`.
- The runtime sources may not reach a clock, a timer, a frame callback, or a
  random source (specification §6.1), and only `validateComposition` may produce
  a `ValidatedComposition`. A test feeds violating source text to the real
  ESLint configuration and asserts the rejection.
- D01–D10 stay `Accepted`, and their quotations stay verbatim with `AGENTS.md`.
