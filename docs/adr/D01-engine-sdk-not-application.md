# D01 — Kadrion is always an engine/SDK, never an application

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D02, D06, D10

## Decision

> D01: Kadrion is always an engine/SDK, never an application.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> Kadrion is a private, independent TypeScript engine for describing, previewing,
> editing, and deterministically rendering video compositions. It is not an end-user
> application. Taskio will be its first consumer, but Kadrion must not depend on
> Taskio, Laravel, Vue, a tenant model, or Taskio-specific domain objects.

> Applications such as `playground` and `worker` may compose these packages but
> must not become hidden sources of domain rules.

Listed under "Explicitly outside the current scope":

> Taskio database models, queues, permissions, billing, and multi-tenancy.

> A production REST service or distributed render farm.

## Verification

`tests/repo/package-boundaries.test.ts` rejects every external runtime
dependency that is not on the reviewed allowlist in
`docs/architecture/package-boundaries.json`. The allowlist starts empty, so a
dependency on Taskio, Laravel, or Vue cannot appear unnoticed. The rest of this
decision is enforced by review.
