# D09 — AI edits films, animations, and assets through typed domain tools

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D02, D05, D08

## Decision

> D09: AI edits films, animations, and assets through typed domain tools.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> UI and AI never mutate renderer internals directly. Both use the same command bus.

> Structured nodes are the default path for Taskio and AI.

> `@kadrion/ai-sdk`: AI tool contracts built on editor-sdk commands.

> A canvas interaction changes the JSON through a typed domain command.

> An AI-shaped tool call performs an equivalent command.

Listed under "Explicitly outside the current scope":

> A conversational LLM agent or production asset generation pipeline.

## See also

- [Vertical-spike specification](../spike/vertical-spike.md), proofs P3 and P4
  and §9.

## Verification

Not mechanically verified in PR-00. The spike verifies it by asserting that a
fixture tool call and the equivalent UI command produce identical documents.
`docs/architecture/package-boundaries.json` already prohibits `ai-sdk` and
`editor-sdk` from depending on the renderer side (see D12).
