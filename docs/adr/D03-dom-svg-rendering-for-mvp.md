# D03 — MVP rendering uses DOM/SVG; Canvas/WebGL are later extensions

- Status: Accepted
- Recorded: 2026-09-21, from `AGENTS.md` at commit `250ae8f`
- Related: D05, D06

## Decision

> D03: MVP rendering uses DOM/SVG. Canvas/WebGL are later extensions.

## Rationale

Not recorded. `AGENTS.md` states this decision without its reasons. The project
owner is asked to supply the rationale; until then this section stays empty
rather than guessed.

## Related rules in `AGENTS.md`

Verbatim quotations. `AGENTS.md` remains the authoritative text.

> The same runtime renders it in pinned Chromium on the server.

> Do not hide meaningful state in CSS class names, DOM order, callbacks, or opaque code.

> Extension points require an explicit type manifest, property schema, runtime
> implementation, editor metadata, AI metadata, and reference tests.

> Assets, fonts, randomness, and runtime versions must be explicit or pinned.

Listed under "Explicitly outside the current scope":

> Full timeline UI, advanced trimming, color grading, filters, or transitions.

## See also

- [Vertical-spike specification](../spike/vertical-spike.md), open question Q15,
  answered by [D20](D20-dom-renderer-package-and-host-clock.md): the DOM/SVG
  renderer lives in `@kadrion/renderer-dom`; its mapping is
  [D22](D22-dom-mapping-and-css-serialisation.md).

## Verification

Not mechanically verified in PR-00. From the renderer PR onwards: golden frames
rendered through the DOM/SVG path at the reference timestamps. (Annotated by
PR-03: the renderer PR verifies the rendered DOM tree; golden frames need the
pinned Chromium of PR-06, specification §10.)
