# D08 — Real-time collaboration is outside MVP

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D02, D09

## Decision

> D08: Real-time collaboration is outside MVP.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> `@kadrion/editor-sdk`: typed commands, patches, transactions, undo/redo.

> Prefer small, reviewable changes. Avoid speculative abstractions and public APIs
> that are not required by the current spike.

Listed under "Explicitly outside the current scope":

> CRDT collaboration, public plugins, 4K, HDR, and desktop/mobile apps.

## Verification

Enforced by review: no collaboration-oriented dependency or abstraction is
introduced during the MVP. Any new runtime dependency has to pass the reviewed
allowlist in `docs/architecture/package-boundaries.json`.
