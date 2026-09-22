# D19 — Evaluation API and state shape

- Status: Proposed — provisionally implemented by PR-02; becomes Accepted only by
  explicit approval of the project owner
- Date: 2026-09-21
- Supersedes: —
- Related: D03, D12, D14, D15, D16, D17, D18,
  [specification](../spike/vertical-spike.md) §5.1, §10, and open questions Q15
  and Q17

## Context

PR-02 gives `@kadrion/runtime` its first public API, and the specification
forbids deciding such things "implicitly in code". The decisions below are kept
apart from D18 because the renderer of PR-03 is the first consumer of the state
and may have to reshape it, while the arithmetic of D18 should outlive that.

Evidence gathered on 2026-09-21:

- The project owner answered open question Q17 with yes: `validateComposition`
  returns a branded type, and the runtime accepts nothing else.
- A brand made of a `unique symbol` property **survives an object spread**:
  `{ ...validated, durationUs: 1 }` is still assignable to the branded type. A
  spread copy with one field replaced is exactly what an editor command
  produces, so that brand would wave edited documents through unvalidated. A
  brand made of a declared class with a private member does not survive a spread;
  it emits no code and compiles under `erasableSyntaxOnly`.
- D15 says that "a group is composited before its `opacity` is applied". Folding
  a group's opacity into its children is therefore wrong wherever children
  overlap, so a flat list of world-space values cannot describe a frame.

## Decision

The parts are numbered for reference.

**19.1 API.** `evaluateComposition(composition, timeUs)` returns the
`CompositionState`. It is synchronous and pure: no module state, no cache, no
clock. The document is never written, and the state shares no object with it.
The package exports this function, `EvaluationError`, and the state types, and
nothing else.

**19.2 Input.** The only document type is `ValidatedComposition` from
`@kadrion/schema`, which only `validateComposition` produces. The evaluation does
not validate again. The brand is a declared class with a private member (see the
evidence). It is a **static** guarantee with known limits:

- A type assertion or a type predicate that names the brand forges it. ESLint
  rejects both in every package source except
  `packages/schema/src/validate.ts`; tests may forge. The rule sees only forms
  that name `ValidatedComposition`: a type alias, a generic cast helper, or an
  assertion to `ValidationResult` passes it.
- An intersection such as the result type of `Object.assign` keeps it.
- `validateComposition` brands the caller's own object. Whoever still holds a
  mutable reference to it, such as an editor draft, can change it afterwards.
- A spread, `Readonly<>`, `Object.freeze`, and mapped types in general
  (`DeepReadonly`, reactive proxies, drafts) strip it, which fails closed.
- It cannot cross `JSON` or `postMessage`: whatever receives a document there
  validates it again. Two installed copies of `@kadrion/schema` have two
  incompatible brands.

The evaluation reports, as `invalid-document`, exactly the four members it could
otherwise only skip or guess: an animation without keyframes, and an unknown
node type, animation property, or interpolation. The same branches fail
compilation when the schema gains a member that the runtime does not handle.
Every other defect of a forged document — two animations of one property,
keyframes out of order, a missing field — is not detected and has an undefined
result, because the evaluation does not validate again.

**19.3 Errors.** A call outside the domain of D18.1 throws `EvaluationError`,
which extends `RangeError` and carries a `code`. It is an exception and not a
result, because a time outside the composition is a programming error of the
host, as with the frame grid functions of D13; an invalid document is expected
input and gets a result (D17). Callers check `code`, because `instanceof` fails
across realms.

**19.4 State shape.** `{ timeUs, scenes: [{ id, nodes }] }` mirrors the order and
the hierarchy of the document (D16.4). A node state is `{ id, type }`, plus
`position`, `scale`, and `opacity` for every node that has a transform, plus
`children` for a group. All values are local (D18.5). Static properties — colour,
text, asset references, sizes, inline HTML — stay in the document; a renderer
walks the document and the state side by side. The state is built from fresh
objects and is not frozen.

## Alternatives considered

- **A `unique symbol` brand** — the conventional choice, rejected on the
  evidence above.
- **Validating inside `evaluateComposition`** — a guarantee at run time, paid
  once per frame. The host validates when it loads a document (P1).
- **A result instead of an exception** — consistent with `validateComposition`,
  but every frame of a render loop would have to unwrap it for an error that
  only a host bug can cause.
- **A flat `nodes` list without `scenes`** — shorter while schema `0.1` allows a
  single scene (D16.2), but it would already decide how several scenes map onto
  one frame. Mirroring the document decides nothing.
- **Copying static properties into the state** — one tree for the renderer, but
  a second copy of the document per frame that can only drift from the first.
- **World-space values** — wrong for group opacity, and nested DOM elements
  compose transforms natively (D03). An editor that needs them for hit-testing
  can derive them from the local values.
- **Freezing the state** — costs a traversal per frame. The types are read-only,
  and a test proves that damaging a returned state does not reach the next
  evaluation.
- **Naming the result "resolved state"** — D14 already uses "resolve" for
  assets. The names are "evaluate" and "state".

## Consequences

- `@kadrion/runtime` depends on `@kadrion/schema`, for types only so far. D12
  allows that edge.
- `@typescript-eslint/no-misused-spread`, part of the lint baseline (D11), flags
  a spread of a branded value. A command should therefore take a `Composition`
  and return a `Composition`; its result is validated again before it is
  rendered (specification P3).
- PR-03 consumes the state. If the renderer needs more than this shape offers,
  for example layout results, that is an amendment of 19.4 and not of D18.
- A document that reaches the page as JSON or through `postMessage` arrives
  without the brand, so the entry point inside the page validates it. That makes
  `@kadrion/schema` part of the runtime build, which open question Q12 has to
  account for. Host-facing entry points of Player and Producer should take
  `unknown` and validate; the brand is for the inside of the engine.
- The guard against forged brands is a lint rule, so an inline `eslint-disable`
  can still silence it outside the runtime sources, where inline configuration
  is switched off altogether. Such a comment is visible in review.

## Verification

- `packages/schema/test/types.test.ts`: what `validateComposition` returns; a
  plain `Composition` is not validated; the brand does not survive an edited
  copy and fails closed under `Readonly<>`.
- `tests/repo/lint-guardrails.test.ts`: assertions and predicates that name
  `ValidatedComposition` are rejected in package sources, allowed in the
  validator and in tests.
- `packages/runtime/test/evaluate.test.ts`: a plain `Composition` does not
  compile (`@ts-expect-error`); the error codes; one forged document per
  reported member.
- `packages/runtime/test/golden-state.test.ts` and
  `packages/runtime/test/determinism.test.ts`: the state mirrors the document
  and shares no object with it; two states share no object and none is frozen; a
  document changed in place yields the new state, so nothing is cached.
- `tests/repo/expected-state.test.ts`: the expected states hold evaluated values
  only, never static properties.
