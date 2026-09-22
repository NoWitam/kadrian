# D04 — Persistent time values are integer microseconds

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D02, D06

## Decision

> D04: Persistent time values are integer microseconds, never floating-point seconds.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> Runtime state for a frame is derived from `(composition, timeUs)`.

> Runtime animation logic must not depend on `Date.now()`, timers, playback
> history, UI state, or the number of previously rendered frames.

> Use integer fields such as `startUs`, `durationUs`, and `timeUs`.

> Golden timestamps: `0`, `2_500_000`, `5_000_000`, `7_500_000`, and
> `9_900_000` microseconds.

## See also

- [Vertical-spike specification](../spike/vertical-spike.md), §4 and open
  question Q1: a 30 fps frame lasts 33 333.3… µs, so the mapping between frame
  indices and integer `timeUs` needs one explicit rule in both directions.

## Verification

Not mechanically verified in PR-00. From PR-01 onwards: schema tests that reject
fractional, negative, and non-numeric time values.
