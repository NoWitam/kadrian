# D02 — Taskio stores project versions; Kadrion owns the composition schema

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D01, D04, D08

## Decision

> D02: Taskio stores project versions; Kadrion owns the composition schema.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> The versioned composition document is the only source of rendering truth.

> `@kadrion/schema`: JSON Schema, TypeScript types, validation, migrations.

> JSON Schema is the persistent data contract.

> Start with schema `0.x` and only fields required by the reference spike.

> Breaking schema changes require explicit forward migrations.

> Unknown or unsupported fields produce a clear error or explicit warning.

> Do not hide meaningful state in CSS class names, DOM order, callbacks, or opaque code.

## Verification

Not mechanically verified in PR-00, because no schema exists yet. From PR-01
onwards: schema validation tests and the reference composition fixture.
