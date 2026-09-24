# D27 — Fonts from asset bytes, the load step of the runtime build, and the fixture assets

- Status: Accepted — by the project owner on 2026-09-22, without a change of substance
- Date: 2026-09-22
- Supersedes: —
- Amends (accepted with this ADR): D22.5 ("The renderer never verifies a hash"), D22.6, and
  D25.2 and D25.4 as named below
- Related: D10, D12, D14, D20, D21, D22, D24, D25, D26, D28,
  [specification](../spike/vertical-spike.md) §3.2, §5 P1–P2, §8, and open
  question Q5

## Context

Q5 asked how fonts are pinned and text rendering is stabilised. D22.6 names the
family `kadrion-font-<fontAssetId>` but registers no face, so until now no text
pixel could count as golden. The project owner decided on 2026-09-22 that the
font is registered as a `FontFace` from the bytes of its asset before the
runtime reports ready and before the first frame: the resolver supplies the
bytes, their SHA-256 is verified (D14), a `FontFace` is built from an
`ArrayBuffer`, `load()` is awaited, the face is added to `document.fonts`,
`document.fonts.ready` is awaited, and only then may the first frame render. A
missing asset, a wrong hash, and a failure to decode or load the font are typed,
deterministic errors; there is never a silent fallback to a system font. The
fixture uses one deterministic font with an OFL licence or one generated for the
tests, and the reference texts use only its characters.

Three things stand in the way today:

- `FontFace` is banned in the deterministic sources (D22.8), and the page agent
  that turns bytes into URLs is a script of `@kadrion/player` (D25.4). If fonts
  were registered there, the Producer would need a copy, and a Producer that
  registered them while the Player did not would show different text.
- The loop that asks the resolver and verifies hashes is a function of
  `@kadrion/player` (D25.4). The Producer needs the same rule, and D12 says
  that shared code moves down, never sideways.
- The fixture's hashes were placeholders (D14, D25); the binary assets did not
  exist.

Evidence gathered on 2026-09-22 on the Windows development machine in the
Playwright Chromium 153.0.8010.12 (informative, D26): in a sandboxed `srcdoc`
frame whose policy is that of D25.2 — `default-src 'none'` and no `font-src` —
`new FontFace(family, arrayBuffer)` loaded the generated font of 27.5 (status
`loaded`); `CSS.getPlatformFontsForNode` reported, for "Kadrion" and for
"Deterministic by design", only `Kadrion Fixture` with `isCustomFont: true` and
7 and 23 glyphs; no request was made. A face built from bytes fetches nothing,
so `font-src` does not apply to it.

## Decision

**27.1 The load step in the artifact.** The runtime build gains

```ts
KadrionRuntime.load(root, document, assets, host): Promise<PageResult>
```

`assets` is an array of `{ id, mediaType, bytes }` with exactly these own keys,
`bytes` an `ArrayBuffer` and `mediaType` matching `^[a-z]+/[a-z0-9.+-]+$`; an ID
may appear once. `host.createFont(family, bytes)` is the `FontFace` constructor
of the page's realm, lent by the host (as the timer is, D20.2) because the
deterministic sources may not name it. In this order, and nothing is touched
before the first two steps have passed:

1. validate the document (D19);
2. turn every asset into a `data:` URL (base64 written by the renderer, no
   platform API) and check the URLs against the document by the rules of D22.5;
   a malformed entry is `asset-url-invalid`;
3. `document.fonts.clear()`, so that the font set depends on this document only
   and a second load never sees the faces of the first;
4. for every font asset that a text node uses, in the order of the document's
   `assets`: build the face with the family of D22.6 from a copy of its bytes,
   await `load()`, and add it to `document.fonts`; a missing `createFont`
   or font set is `readiness-unsupported`, and a constructor that throws or a
   `load()` that rejects is `font-load-failed` — one code for "the bytes are
   not a usable font", whichever the browser reports;
5. await `document.fonts.ready`;
6. mount the tree (D22.3) with the URLs of step 2.

`KadrionRuntime.frame` (D25.3) keeps waiting for `document.fonts.ready` before
every frame. `mount` stays in the artifact for the tests of D21, but both hosts
load through `load`, so that the order of fonts and mount is the artifact's, not
a host's. Only faces added from script are cleared; the page policy admits no
`@font-face` source (no `font-src`), so there is nothing else in the set.

**27.2 Hosts.** The page agents of the Player and of the Producer pass the
asset messages through unchanged and lend `createFont`, captured when the agent
starts. The Player's agent loses its own base64 and URL code.

**27.3 The resolver moves down.** `@kadrion/renderer-dom` exports
`resolveAssets(composition, resolveAsset, sha256)`: the loop of D25.4 as it
was — for every asset of the document, in order, the resolver is called once
with a frozen `{ id, type, contentHash }` and returns `{ bytes, mediaType }` or
`null`; the bytes are copied and hashed by the lent `sha256`, and only then
returned. `null`, a resolver that throws or rejects, and anything else it
returns are `asset-missing` or `asset-invalid`; a mismatch is
`asset-hash-mismatch`. The media type must be of the asset's own kind
(`image/…`, `audio/…`, `font/…`), else `asset-invalid`: the document carries no
media type (D14), so two hosts could otherwise turn the same verified bytes into
`data:` URLs of different kinds (review of the diff). It is not part of the artifact: it runs in the host
before anything reaches the page, with Web Crypto in the Player and
`node:crypto` in the Producer. The Player's own loop is deleted.

**27.4 Amendments.** D22.5: the renderer package verifies a hash in exactly
one place, `resolveAssets`, with a digest the host lends; `mountComposition`
still does not. D22.6: a text node is drawn with the face registered by 27.1;
text of a document is golden from PR-06 on. Text inside a Custom HTML element
is not: its frame inherits the page policy and no face is registered in it, so
it would fall back to a system font, and the reference element draws no text.
D25.2: "There is no `font-src` (no font face is registered, Q5)" becomes
"There is no `font-src`: fonts are registered from bytes (27.1), which fetches
nothing." D25.4: the resolver loop is `resolveAssets` of 27.3, and the page's
`data:` URLs are built by the artifact (27.1), not by the agent.

**27.5 Fixture assets.** `@kadrion/test-fixtures` generates its three assets
from code, so no binary asset enters Git (D10, §3.2):

- `asset-image`: a 128 x 128 truecolour PNG with a fixed pattern, its zlib
  stream made of stored blocks, so the bytes do not depend on the version of a
  compression library;
- `asset-font`: a TrueType font built glyph by glyph (rectangles on a 100-unit
  grid, 1000 units per em), family `Kadrion Fixture`, with a glyph for exactly
  the characters of the reference texts and the space; licensed with this
  repository, because it is generated here;
- `asset-audio`: 10 s of a 480 Hz triangle tone, 48 kHz, mono, 16-bit PCM WAV,
  every sample an integer.

The generators use integer arithmetic and no platform API. `reference.json`
carries the SHA-256 of their bytes instead of the placeholders of D14.

## Alternatives considered

- **Registering fonts in each host's agent** — the reason for 27.1: the hosts
  could differ in the one step that decides text pixels.
- **An exception to the guardrail for `FontFace`** (as D24 did for one memo) —
  lending keeps the ban intact and follows D20.2.
- **`@font-face` with a `data:` URL** — needs `font-src data:` in the page
  policy, which every Custom HTML frame inherits; the owner asked for
  `FontFace` from bytes.
- **An OFL font file** — a binary in Git with a licence record; a generated
  font needs neither.
- **A resolver loop in each host** — the same D14 rule twice (D12).

## Consequences

- The runtime build gains `load` and so a new hash. `RenderErrorCode` gains
  `font-load-failed`, `asset-missing`, `asset-hash-mismatch`, and
  `asset-invalid`; `PlayerErrorCode` gains `font-load-failed`.
- A text that uses a character outside the fixture font falls back to a system
  font. `tests/repo/fixture-assets.test.ts` checks that every character of
  every text node has a glyph, and the browser tests check which font was used.
- A later font change is a change of bytes and therefore of the hash in the
  document, as it should be.

## Verification

- `packages/renderer-dom/test/load.test.ts` (jsdom, a stand-in font set): the
  order of 27.1, `clear` before the first face, the family and bytes of every
  face, the typed errors before the DOM is touched, the `data:` URLs.
- `packages/renderer-dom/test/resolve.test.ts`: 27.3, moved from the Player's
  tests.
- `packages/player/test`: the agent passes the assets through, lends
  `createFont`, and contains no base64 or URL code of its own.
- `tests/repo/fixture-assets.test.ts`: the hashes in `reference.json` are those
  of the generated bytes; generation is repeatable; every character of every
  text node is covered by the font.
- `tests/pinned`: `CSS.getPlatformFontsForNode` reports only the fixture font
  for every text node, in the Producer and in the Player; a corrupt font is
  `font-load-failed` before the first frame.
