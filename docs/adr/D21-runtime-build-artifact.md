# D21 — The runtime build artifact

- Status: Accepted — by the project owner on 2026-09-22
- Date: 2026-09-22
- Supersedes: —
- Related: D10, D11, D12, D14, D19, D20, [specification](../spike/vertical-spike.md)
  §5 P1–P2, §8, and open question Q12

## Context

`AGENTS.md` requires that "the browser Player and server Producer execute the
same runtime build", and P2 requires the artifact the Producer loads to be
**byte-identical** to the one the Player loads, with its hash in the render
manifest (§8). Open question Q12 asks how that single build is produced,
addressed by hash, and loaded; it names PR-03 as its owner.

D19 adds a requirement: a document that reaches the page as JSON or through
`postMessage` has lost its brand, so the entry point inside the page validates
it, and `@kadrion/schema` becomes part of the build. D20 puts the renderer into
`@kadrion/renderer-dom`, which depends on `@kadrion/runtime` and
`@kadrion/schema`: the build is the bundle of those three packages.

Evidence gathered on 2026-09-22 (Windows 11, Node.js 22.22.0):

1. esbuild 0.28.2 (MIT, released 2026-08-08, older than the 24-hour cooling-off
   of `pnpm-workspace.yaml`) bundled the same input twice into identical bytes,
   removed the `sourceMappingURL` comments of its inputs, and wrote only
   paths relative to its working directory into the output.
2. Node.js 22.22.0 runs a TypeScript file with `--experimental-strip-types`
   without a warning. `engines` allows 22.13.0, where the flag exists but is not
   the default, so the build passes the flag explicitly.

## Decision

**21.1 Bundler.** esbuild, pinned to exactly `0.28.2` (MIT), is a
`devDependency` of `@kadrion/renderer-dom`. It is a build tool, not a runtime
dependency, so the allowlist of D12 does not change.

**21.2 Input and options.** The input is the TypeScript output of the page
entry, `packages/renderer-dom/dist/page.js`, so the artifact contains exactly the
code that `tsc` emitted and that the package tests exercise. The options are
fixed in `packages/renderer-dom/scripts/build-runtime.ts`: bundle, format
`iife` with the global name `KadrionRuntime`, platform `browser`, target
`es2022`, not minified, no source map, no legal comments, charset `utf8`, and
the repository root as working directory. The output is plain JavaScript text
that loads as a classic script; that it also loads under the strict Content
Security Policy of the Player's page is verified by PR-05.

**21.3 Output and address.** `node --run build` runs `tsc -b` and then the
script, which writes

- `packages/renderer-dom/dist/runtime-build/kadrion-runtime.js`, the artifact;
- `packages/renderer-dom/dist/runtime-build/kadrion-runtime.json`, its manifest:
  `file`, `format`, `globalName`, `byteLength`, `bundler` (`esbuild@<version>`),
  `compiler` (`typescript@<version>`, because the input is its output), and
  `contentHash`.

`contentHash` is `sha256:` followed by the 64 lowercase hex digits of the SHA-256
of the exact bytes, the format of D14. It is the identity of the build: the
Player and the Producer compare it before they execute the artifact, and the
Producer records it in the render manifest (§8). The file name stays fixed; the
hash, not the name, is the address.

**21.4 Page contract (provisional until PR-05 and PR-06 consume it).**
`KadrionRuntime.mount(root, document, assetUrls)` and
`KadrionRuntime.render(root, document, timeUs)` take the document as `unknown`
and validate it on every call (D19); an invalid document yields
`{ ok: false, errors }`, a valid one `{ ok: true }`. Everything else follows
D22. Nothing in the page keeps state between calls except the DOM under `root`.

## Alternatives considered

- **Rollup or Vite** — pure JavaScript bundlers with a larger plugin surface;
  the spike needs one entry and no plugins. Rollup 4 also ships native binaries.
- **Bundling the TypeScript sources directly** — the artifact would then be
  compiled by esbuild while the tests run code compiled by `tsc`; one compiler
  for both is simpler to reason about.
- **ES module output** — the hosts would have to load a module script. A
  classic script with one global loads the same way through an `iframe`, a
  `<script>` element, or a CDP evaluation.
- **A content-hashed file name** — every consumer would need the manifest to
  find the file anyway; one fixed name plus the hash in the manifest is enough.
- **Validating once at mount and keeping the document in the page** — faster,
  but it is state between calls that a later call could not see changed.
  Validation per frame is linear in the document, which is small in the spike;
  PR-06 measures it if it matters.

## Consequences

- The root `build` script builds the artifact, so `node --run test` and
  `node --run check` always test a fresh one. `typecheck` is unchanged.
- The package exports only `.` so far (`tests/repo/workspace-structure.test.ts`
  pins it). PR-05, the first consumer, adds an export for the artifact and its
  manifest and amends that test.
- The hash is measured on the development machine only. That the artifact is
  byte-identical on another operating system and in the pinned render
  environment is verified by PR-06 in CI (Q14), not here.
- The artifact starts with `"use strict";`. Loaded as a classic script (a
  `<script>` element or a CDP evaluation) it defines exactly one global,
  `KadrionRuntime`; inside a strict `eval` its `var` would stay local.
- `validateComposition` accepts plain objects of its own realm only (D17). A
  host must therefore hand the document over as JSON or through `postMessage`,
  which create it in the realm of the page; an object passed by reference from a
  parent frame is rejected as "a non-JSON object". PR-05 has to respect that.
  The project owner confirmed this limit on 2026-09-22; it is not recorded as a
  debt. `postMessage` delivers a structured clone that the receiving realm
  creates, so a document received that way is a plain object of the page's
  realm and is accepted. `packages/schema/test/validate-input.test.ts` pins both
  halves: an object of another realm is rejected, its structured clone accepted.
- An esbuild upgrade changes the bytes and therefore the hash, as it should: it
  is a pinned tool that influences reproducibility (`AGENTS.md`).

## Verification

`packages/renderer-dom/test/runtime-build.test.ts`: two builds in the same
process are identical; both equal the artifact on disk; the manifest describes
the file and its hash; the key options are asserted independently of the
script; the artifact contains no absolute path, no source-map reference, and no
path of the repository root; the recorded bundler version equals the pinned
`devDependency`; and the artifact, executed in a DOM window, mounts and renders
the reference composition at the five golden timestamps into the expected tree
while every clock of that window throws, and answers an invalid document with
`{ ok: false }`.
