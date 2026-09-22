# D10 — The repository is private initially and designed for possible future open source

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D01

## Decision

> D10: The repository is private initially and designed for possible future open source.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> The project may become open source later. Keep product-specific infrastructure,
> credentials, private URLs, and Taskio implementation details outside this repo.

> Never add secrets or real Taskio credentials.

> Keep generated media, frames, browser caches, and large fixtures out of Git.

## See also

- [Vertical-spike specification](../spike/vertical-spike.md), §3.2 (provenance
  and licence of fixture assets) and open question Q4 (licence terms of the
  FFmpeg build).

## Verification

`tests/repo/workspace-structure.test.ts` checks that every workspace package is
`"private": true` with `"license": "UNLICENSED"`, which also prevents accidental
publication until a licence is chosen by a future ADR. The allowlist of external
runtime dependencies in `docs/architecture/package-boundaries.json` records a
licence for every entry. Secret hygiene is enforced by review.
