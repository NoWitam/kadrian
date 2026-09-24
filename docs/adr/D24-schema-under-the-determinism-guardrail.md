# D24 — The schema joins the determinism guardrail, with one named exception

- Status: Accepted — by the project owner on 2026-09-22
- Date: 2026-09-22
- Supersedes: —
- Related: D17, D19, D20, D21, D22.8, D23,
  [specification](../spike/vertical-spike.md) §6.1

## Context

The runtime build contains `@kadrion/schema`, whose `validateComposition` runs
inside the page on every call (D21), but the determinism guardrail bound only
`@kadrion/runtime` and `@kadrion/renderer-dom` (D20.3). D20 recorded this as a
known gap: the schema holds one module-level memo, `supported` in
`packages/schema/src/validate-structure.ts`, a `WeakSet` of the schema objects
that `assertSupportedSchema` has already checked; extending the guardrail needs
that memo rewritten or named as an exception.

On 2026-09-22 the project owner chose to **name the exception**, as narrowly as
possible: it covers that memo only, is no general permission for `WeakSet` in
the package, and every other use of `WeakSet` or `WeakMap` stays blocked.

Evidence found while recording it: the memo does not change a result only if a
schema object it remembers cannot change afterwards. `compositionSchema` is
exported from the package and was a plain, mutable object. A consumer that added
an unsupported keyword to it after the first validation would have been
validated without the check that rejects the keyword — whereas a fresh process
would have thrown. That is exactly the history dependence the guardrail exists
to prevent, so the exception needs a precondition.

## Decision

**24.1 Scope.** The determinism guardrail (the lists of D22.8, with inline
configuration switched off) binds every source of `@kadrion/schema` as well as
those of `@kadrion/runtime` and `@kadrion/renderer-dom`. `validate.ts` keeps its
permission to attach the brand (Q17) and is otherwise bound like every other
source.

**24.2 Precondition.** `compositionSchema` and every object reachable from it
are frozen when the module loads. A schema object that the memo remembers can
therefore never change, and re-checking it would give the same verdict.

**24.3 The exception.** Exactly one declaration is exempt from the module-state
rules and from the ban on weak collections: in
`packages/schema/src/validate-structure.ts`, the module-level, non-exported
`const supported = new WeakSet();` with no argument. It is permitted because:

- it holds schema objects only, never a document, a state, or a time (lint pins
  the declaration, not what is added to it; `validate-input.test.ts` fails if a
  document is remembered: one changed in place after a successful validation
  must be rejected by the next one);
- it records only a verdict that is already proven: an object is added after
  its whole subtree has passed, and a failing check throws before anything is
  added; with 24.2 the verdict cannot go stale, so for the same input the
  validator returns the same result whether the memo is empty or full;
- it is not a clock, not a cache of validation results (documents are never
  remembered), and not a source of domain state; being weak, it keeps nothing
  alive.

The exemption is written as one `eslint.config.js` block for that one file
whose selectors exclude exactly this declaration (name, `const`, not exported,
the callee `WeakSet`, no argument). The same text in any other file, a second
such declaration, another name, `let`, an export, an argument, or `WeakMap`
remains an error.

**24.4 Weak collections.** In every deterministic source the identifiers
`WeakSet`, `WeakMap`, `WeakRef`, and `FinalizationRegistry` are rejected
wherever they appear, including `Reflect.construct(WeakMap, [])` and type
references such as `WeakMap<K, V>`. A weak map keyed by host objects is the
usual way to hide per-element memory outside the DOM, and `WeakRef` and
`FinalizationRegistry` make garbage collection observable. The one exception is
the callee of 24.3.

**24.5 Ways back through a frame** (required by D23). The members `parent`,
`top`, `opener`, `frames`, and `contentDocument` are banned on any object in
every deterministic source, so that the `contentWindow` the renderer needs for
posting a message cannot be walked back to the host window, and a frame's
document cannot be read. The bans do not keep the renderer away from the host
window as such: the host lends it as `messageTarget` (D23.4), and its clocks
stay banned by name, but its other members are held back by review (D23,
Consequences).

## Alternatives considered

- **Rewrite the memo away** — validation would re-check the schema subset on
  every call; the owner preferred to keep it and name it.
- **Defer** — the page would keep running unguarded schema code (D20's gap).
- **An inline `eslint-disable` comment** — inline configuration is switched off
  in deterministic sources, deliberately (§6.1).
- **Exempting `validate-structure.ts` from the module-state rules as a whole** —
  any further state in that file would pass unseen.

## Consequences

- Mutating `compositionSchema` now throws in strict code. Nothing in the
  repository does, and the schema is the persistent contract, not a
  configuration object.
- `tests/repo/lint-guardrails.test.ts` covers the three packages, proves the
  exception accepted and each variant of it rejected, and proves the new bans.
- D20's known gap is closed.

## Verification

- `packages/schema/test/composition-schema.test.ts`: every object reachable
  from `compositionSchema` is frozen (`Object.isFrozen`), and a schema checked
  once is checked with the same verdict again.
- `tests/repo/lint-guardrails.test.ts`: the scope assertions include schema
  paths; the exception and its variants; `WeakSet`, `WeakMap`, `WeakRef`,
  `FinalizationRegistry`, and the members of 24.5 are rejected in all three
  packages.
