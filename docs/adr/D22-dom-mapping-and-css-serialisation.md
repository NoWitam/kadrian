# D22 — DOM mapping and CSS serialisation

- Status: Accepted — by the project owner on 2026-09-22
- Amended by: D23 (accepted 2026-09-22) — the Custom HTML row of 22.3, as 22.3 anticipated
- Date: 2026-09-22
- Supersedes: —
- Related: D03, D05, D14, D15, D16, D18, D19, D20, D21,
  [specification](../spike/vertical-spike.md) §5 P1–P2, §6.1, and open
  question Q5

## Context

PR-03 renders the evaluated state of D19 as DOM (D03, D20). Several things are
decided on the way that the specification forbids deciding "implicitly in
code":

- D18 leaves "serialising doubles for CSS" to the renderer. A value such as
  1.7125000000000001 (the reference composition at 9 900 000) must reach the page
  as the same text in every host.
- D15 fixes the transform order, the origin of scaling, and that a group is
  composited before its opacity applies; D16.4 makes array order the z-order.
- D14 leaves "image pixels versus its node box" to PR-03 and defers the asset
  resolver; the renderer still needs URLs, and "missing required assets are
  errors, not silent fallbacks" (`AGENTS.md`).
- The review of the plan listed styles that a renderer could get wrong without
  any test noticing: the transform origin, stray `z-index`, text set as markup,
  and CSS properties left to the browser's defaults.

Evidence gathered on 2026-09-22: jsdom 29.1.1 returns every declaration listed
under 22.3 unchanged when it is written in the form given there, including
`1e-7`, `1e-7px`, and `0.30000000000000004`. It rewrites `#rrggbb` colours into
`rgb(r, g, b)`, which is also how the CSS Object Model serialises a colour.

## Decision

The parts are numbered for reference.

**22.1 Numbers.** An evaluated number becomes CSS text through ECMAScript
`Number::toString` (`String(n)`): exactly specified, the shortest decimal that
reads back as the same double, so every engine writes the same text for the same
bits. `-0` becomes `0`. Below 1e-6 the text uses an exponent (`1e-7`), which is a
valid `<number>` token of CSS Syntax Level 3; a length appends `px` (`1e-7px`).
The ranges of D15 exclude `NaN`, the infinities, and the exponent form above
1e21. Nothing is rounded, fixed to a number of digits, or clamped.

**22.2 Transform and opacity.** Every node with a transform gets, on every
render, `transform: translate(<x>px, <y>px) scale(<sx>, <sy>)` and
`opacity: <o>` on its own element, with `transform-origin: 0px 0px`. CSS applies
the list from the right: the node is scaled about its top-left corner and then
moved by its position, which is D15. The children of a group are child elements
of the group element, so they live in its scaled space, and the group's opacity
applies to the composited group (D15, D18.5). Nothing sets `z-index`: absolutely
positioned siblings paint in DOM order, which is the array order (D16.4).

**22.3 Elements.** `mountComposition` replaces the content of the host's `root`
element with this tree; `W` and `H` are the canvas size.

| Element                                   | Attributes                                           | Styles                                                                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stage `div`                               | `data-kadrion-composition=""`                        | `position: relative`, `width: Wpx`, `height: Hpx`, `overflow: hidden`                                                                                                                         |
| scene `div`, one per scene in order       | `data-kadrion-scene=<id>`                            | `position: absolute`, `left: 0px`, `top: 0px`, `width: Wpx`, `height: Hpx`                                                                                                                    |
| background `div`                          | `data-kadrion-node=<id>`                             | the scene styles, plus `background-color: rgb(r, g, b)`                                                                                                                                       |
| group `div`                               | `data-kadrion-node=<id>`                             | `position: absolute`, `left: 0px`, `top: 0px`, `transform-origin: 0px 0px`                                                                                                                    |
| image `img`                               | `data-kadrion-node=<id>`, `src=<host URL>`, `alt=""` | the group styles, plus `display: block`, `width`, `height` in px, `object-fit: fill`                                                                                                          |
| text `div` with one text node             | `data-kadrion-node=<id>`                             | the group styles, plus `white-space: pre`, `font-family: kadrion-font-<fontAssetId>`, `font-size` in px, `line-height: 1.25`, `font-weight: 400`, `font-style: normal`, `color: rgb(r, g, b)` |
| Custom HTML placeholder `div`, no content | `data-kadrion-node=<id>`                             | the group styles, plus `width`, `height` in px                                                                                                                                                |

Every transformed element additionally carries the `transform` and `opacity` of
22.2 once it has been rendered. A colour `#rrggbb` is written as
`rgb(r, g, b)` with decimal channels. Text is set as a text node, never parsed
as markup. The Custom HTML placeholder stays empty: its `html` is not copied
anywhere until the sandbox of PR-04. The image fills its node box and is
stretched when the aspect ratios differ (`object-fit: fill`); that is the answer
to D14's "image pixels versus its node box". Text has an explicit line height
and weight so that no browser default decides its box. The attributes address
elements; no meaning lives in them that the document does not hold (`AGENTS.md`).

**22.4 Two calls, no memory.**

- `mountComposition(root, composition, assetUrls)` checks the asset URLs first,
  then builds the tree of 22.3. It writes every static property of the
  document and no evaluated value.
- `renderState(root, state)` first checks that the mounted tree has exactly the
  scenes and nodes of the state, in the same order and hierarchy, and only then
  writes `transform` and `opacity` of every transformed node. A mismatch throws
  before anything is written, so the DOM never shows two times at once.
- Neither function keeps anything between calls; the DOM under `root` is the
  only state. Both reach the document of `root` through `root.ownerDocument`, so
  they work in whichever realm owns the element.
- A document whose static properties changed must be mounted again:
  `renderState` only checks IDs, order, and hierarchy. That is a host contract,
  and PR-08 (editing) relies on it.

**22.5 Asset URLs.** Until the resolver of D14 exists, the host passes a plain
object that maps an asset `id` to the URL of bytes it has already verified,
such as a `blob:` URL. Every image asset of an image node and every font asset
of a text node must have an own entry with a non-empty string; an entry for an
ID that is not an asset of the document is an error; entries for other assets
(audio) are allowed. Only own, enumerable data properties count; a getter or a
hidden property is invalid. The renderer copies the entries once and builds the
tree from that copy, so a value cannot change between check and use. All
problems are collected, sorted by asset ID, and thrown as one `RenderError`
before the DOM is touched. The renderer never verifies a hash.

**22.6 Fonts.** A text node names the family `kadrion-font-<fontAssetId>`, and
its font URL is required, but PR-03 registers no font face: loading the font and
waiting for it is open question Q5. Until then a browser draws text in a
fallback font, so no text pixel may count as golden before Q5 is answered.

**22.7 Errors.** `RenderError` extends `Error` and carries a `code`:
`asset-url-missing`, `asset-url-unknown`, and `asset-url-invalid` from 22.5;
`not-mounted` and `state-mismatch` from 22.4; and `invalid-document` for a node
type the renderer does not know, which only a forged brand can bring in (D19). As in D19.3, callers check `code`,
because `instanceof` fails across realms.

**22.8 Guardrail lists.** D20.3 binds every source of `@kadrion/runtime` and
`@kadrion/renderer-dom`. `eslint.config.js` implements it with these lists,
each entry proven by `tests/repo/lint-guardrails.test.ts`:

- banned globals: the clocks, timers, and frame callbacks of §6.1, plus
  `document`, `window`, `self`, `globalThis`, `queueMicrotask`, the three
  observers, `fetch`, `XMLHttpRequest`, `Image`, `FontFace`,
  `getComputedStyle`, and `Intl` (`new Intl.DateTimeFormat().format()` reads
  the wall clock); the renderer reaches the DOM only through the element it is
  given;
- banned members of any object: the same timer names (`view.requestAnimationFrame`),
  `defaultView`, `queueMicrotask`, the observers, `fetch`, `XMLHttpRequest`,
  `FontFace`, `getComputedStyle`, and the Web Animations entries `animate`,
  `getAnimations`, `timeline`, and `timeStamp`;
- module state: a module-level `let` or `var`, exported or not; a module-level
  value or default export built with `new`; a static class field that is not
  `readonly` or whose value is built with `new`.

The static rules cannot see every form of state (an object or array literal at
module level, a closure inside a module-level function call); the dynamic tests
remain the stronger guard.

## Alternatives considered

- **Fixed decimals (`toFixed`) or rounding to a pixel grid** — a second rounding
  rule on top of D18, and it hides the evaluated value from every comparison.
- **Hex colours** — shorter, but the CSS Object Model reads them back as
  `rgb()`, so the written and the stored text would differ.
- **`left`/`top` for the position** — lengths and transforms would mix, and the
  order of D15 would depend on the layout model instead of one transform list.
- **Folding the group into its children** — wrong for overlapping children
  (D15, D19).
- **One call that rebuilds the tree on every frame** — a history-free result as
  well, but it re-creates images and text for every frame.
- **SVG for every node** — D03 allows it, but HTML text and images need no
  foreign objects; SVG stays available for later node types.
- **`object-fit: contain` or `cover`** — each needs a rule for the uncovered or
  cut area; `fill` needs none and matches the node box exactly.

## Consequences

- The package exports `mountComposition`, `renderState`, `RenderError`, and the
  types `AssetUrls` and `RenderErrorCode`. The page entry of D21 builds on them.
- Chromium parses `opacity` and transforms into single precision and may
  serialise fewer digits; that the pixels follow the text written here is
  measured in the pinned environment by PR-06, not in jsdom.
- A pixel check of a scaled, nested corner in pinned Chromium becomes an
  acceptance item of PR-06; jsdom has no layout.
- Host styles can still reach the stage through inheritance. The spike renders
  into a page that contains nothing else (PR-05, PR-06); a shadow root or a reset
  is a later decision.

## Verification

- `packages/test-fixtures/src/compositions/reference.expected-render.json`: the
  complete expected tree at the five golden timestamps, derived by hand from
  `reference.expected-state.json` and this ADR; guarded on its own by
  `tests/repo/expected-render.test.ts`.
- `packages/renderer-dom/test`: the fixture tree element by element, with every
  attribute, style, and child; the string of every transform and opacity at all
  300 grid frames; repeatability and order independence on one mounted tree;
  restoration of damaged styles; interleaved roots; no mutation of document or
  state; synthetic documents for a scale that is not the identity, nested
  transforms, a group with an opacity below 1, and the z-order, each with a
  premise that the wrong variant differs; markup in text; the empty
  placeholder; asset errors before the DOM is touched; a mismatch that writes
  nothing; and clock independence in the realm of the page.
