# D06 — Kadrion includes its own reference Producer

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D01, D03, D07

## Decision

> D06: Kadrion includes its own reference Producer.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> The browser Player and server Producer execute the same runtime build.

> The Producer is the reference output; browser preview parity is measured.

> Missing required assets are errors, not silent fallbacks.

> `@kadrion/producer`: Chromium/FFmpeg render orchestration.

> `@kadrion/cli`: local rendering and diagnostics.

> Pin tools that influence rendering reproducibility once the spike selects them.

> Keep generated media, frames, browser caches, and large fixtures out of Git.

Listed under "Explicitly outside the current scope":

> A production REST service or distributed render farm.

## See also

- [Vertical-spike specification](../spike/vertical-spike.md), §8 and open
  questions Q3, Q4, and Q12.

## Verification

Not mechanically verified in PR-00. The spike verifies it with golden frames at
the reference timestamps and a measured Player/Producer parity report.
