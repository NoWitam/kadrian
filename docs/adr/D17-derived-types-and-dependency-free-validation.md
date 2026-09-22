# D17 — Derived types and dependency-free validation

- Status: Accepted — by the project owner on 2026-09-21
- Date: 2026-09-21
- Related: D10, D12, D16, [specification](../spike/vertical-spike.md) §5 P1 and
  open question Q17

## Context

`AGENTS.md` makes JSON Schema "the persistent data contract". PR-01 also needs
TypeScript types that cannot drift from it, typed errors with a path to the
offending field, and a validator that runs under a Content Security Policy
without `unsafe-eval`, because the Player validates documents in the browser.

Evidence gathered on 2026-09-21:

- Ajv 8.20.0 compiles schemas with `new Function`. Its standalone mode avoids
  that, but needs a code-generation step and a committed generated file; D11 has
  neither a task runner nor a generate script.
- A discriminated union is naturally written as `oneOf` with a `const` per
  branch. Generic validators report a failure inside such a union once per
  branch, so one defect yields many errors. Rewriting the union as `if`/`then`
  chains gives precise errors but defeats type derivation.
- Schema `0.1` uses thirteen validation keywords and no recursion (D16).

## Decision

**17.1 Schema and types.** The JSON Schema (draft 2020-12, standard keywords
only) is authored as a TypeScript `as const` object and exported as
`compositionSchema`. Document types are **derived** from it by the type-level
`Infer`, so they cannot drift. The supported shapes are a TypeScript type that
the schema must `satisfy`: closed objects, bounded numbers, and `oneOf` over
object branches are enforced at compile time.

**17.2 Validator.** `validateComposition` is a hand-written interpreter of
exactly that keyword subset, with no runtime dependency and no code generation.
Every `oneOf` must be discriminated by distinct `const` values of one common
property; the interpreter validates the matching branch only, so one defect
yields one error. Validation runs in three phases and stops after the first
phase that reports errors: the `schemaVersion` gate, the structure, and the
rules JSON Schema cannot express — unique IDs, asset references and their
types, ascending keyframes, and one animation per property.

**The JSON Schema is necessary but not sufficient.** A document that passes a
third-party JSON Schema validator may still be invalid; `validateComposition`
is the contract.

**17.3 Error model.** A result is `{ ok: true, composition }` or
`{ ok: false, errors }`. An error is `{ code, path, message }`: `code` is a
string-literal union, `path` is an RFC 6901 JSON Pointer to the offending field
(for a missing field, to where it belongs). Errors are ordered by phase and
rule, then depth-first in schema order, with unknown fields in sorted order, so
the list never depends on the key order of the input. Input that is not plain
JSON data (`NaN`, `undefined`, class instances, sparse arrays) is an
`invalid-type` error, never an exception.

**17.4 Conformance.** Ajv is a development dependency of `@kadrion/schema`.
Tests compile the schema in Ajv's strict mode and compare verdicts between Ajv
and the structural phase for the fixtures and for deterministically generated
mutants of the reference composition.

**17.5 Exit criterion.** The first need for `$ref` or recursion (nested
groups), optional properties, `anyOf`, `format`, or third-party property
schemas (extension points) triggers an ADR that re-evaluates a library. The
interpreter is not extended ad hoc. `validateComposition` hides the engine, so
the swap does not change the public API.

## Alternatives considered

- **Ajv at runtime** — needs `unsafe-eval`, or the standalone build step
  described above.
- **`@cfworker/json-schema` 4.1.1** (MIT, no dependencies, no `eval`) — still
  needs the semantic phase, a pre-dispatch for unions, and a mapper from its
  messages to typed errors. That layer is about as large as the interpreter and
  depends on message texts.
- **TypeBox** — derives types and validates without `eval`, but ties the public
  types to the library and reports union failures coarsely.
- **`json-schema-to-ts` or generated types** — derivation only; a type-level
  dependency would appear in the published declarations.

## Consequences

- `externalRuntimeDependencies` in the package boundary map stays empty; D12 no
  longer expects PR-01 to add a validator to it.
- Sub-schemas stay named constants and the interpreter stays generic, so
  `editor-sdk` and `ai-sdk` can reuse them for command and tool arguments.
  Nothing beyond `compositionSchema` is exported yet.
- Whether `validateComposition` returns a branded type, so that the type system
  enforces "every render starts from a validated document", is open question
  Q17 and must be decided before PR-02 consumes the types.
- A development dependency is importable from `src` by walking up to a
  `node_modules` directory. `tests/repo/package-boundaries.test.ts` therefore
  checks that bare imports in `packages/*/src` are declared runtime
  dependencies.

## Verification

`packages/schema/test`: `composition-schema.test.ts` (keyword subset, closed
objects, numeric bounds, time and ID conventions, Ajv strict compile,
differential test), `types.test.ts` (derived types equal hand-written
expectations), `validate-input.test.ts` (non-JSON input and prototype keys),
`no-eval.test.ts` (validation in a child process started with
`--disallow-code-generation-from-strings`, with a control that proves the flag
blocks `new Function`).
