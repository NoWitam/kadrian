# D05 — Custom HTML is supported only as an isolated, capability-limited element

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D03, D09

## Decision

> D05: Custom HTML is supported only as an isolated, capability-limited element.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> Custom HTML never receives host secrets or privileged host APIs.

> Structured nodes are the default path for Taskio and AI.

> Runtime state for a frame is derived from `(composition, timeUs)`.

The reference spike composition contains:

> one sandboxed Custom HTML element,

## See also

- [Vertical-spike specification](../spike/vertical-spike.md), §7: sandbox
  requirements, the time contract, and the negative tests the spike must pass.

## Verification

Not mechanically verified in PR-00. The spike verifies the isolation properties
with negative tests when the element is implemented.
