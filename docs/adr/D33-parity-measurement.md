# D33 — Measuring parity between the Player and the Producer

- Status: Accepted — by the project owner on 2026-09-23, without a change of substance
- Date: 2026-09-23
- Supersedes: —
- Partly superseded by: D34.3 (accepted 2026-09-23), for 33.8 and the record
  fields of 33.5: the record becomes version 2, with thresholds and a gate in
  the pinned environment
- Amended by: PR-11 on 2026-09-23 at the owner's request, 33.10 (the Player's
  dist tree in the record)
- Related: D06, D13, D21, D25, D26, D28, D34,
  [specification](../spike/vertical-spike.md) §6.2, §6.3, §12, and open
  question Q9

## Context

§6.2 says the Producer is the reference output, and that parity with the
browser preview is **measured**. "What is compared: for each golden timestamp,
the frame shown by the Player after `seek(timeUs)` against the Producer's golden
frame, at the same pixel dimensions." Q9 asks which thresholds apply, and it
says they come only after the first measurement.

Until PR-10 the P1 test (`tests/pinned/player.pinned.test.ts`) wrote an
informative `parity-report.json`. It used `difference` from
`tests/pinned/support.ts`, and nothing tied a row to a runtime build, a
document, or a time:

- A comparison of frames with different dimensions returned `-1` pixels.
- A truncated PNG decoded to black pixels (`?? 0`).
- The golden frames were read from wherever the manifest pointed.

The review of the plan asked which measurement would give nice numbers and still
compare frames from different times, documents, or runtime builds, or frames
rescaled so that the difference disappears. Its answers shape this decision:

- a record taken against golden frames written minutes earlier in the same run;
- a measuring environment that is not the golden frames' environment;
- a document hash of the text the test meant to send, not of the text the
  Player loaded;
- a premise proven on a different code path than the one the rows use;
- a time taken from the Player's own report.

The project owner decided on 2026-09-23:

- The metric is:
  - the number of differing pixels;
  - their share;
  - the maximum absolute difference of a single channel;
  - a histogram of pixels by the size of their difference.
- PR-10 reports these numbers and gates nothing.
- The Player is measured in the pinned Chromium of D26:
  - at device pixel ratio 1;
  - on a surface of exactly 1080x1920;
  - with no scaling anywhere;
  - in a minimal conformance host that imports only the public, built
    `@kadrion/player`.
- The playground is not measured. Its `scale(0.35)` and its drag overlay
  belong to the application (D25.2).
- A 0.35 measurement is not made: resampling would suggest an agreement that
  the renderer does not have.

## Decision

**33.1 What is compared.** For each golden timestamp of `@kadrion/test-fixtures`,
in order, the measurement compares two frames:

- **The Player frame:** what the public `@kadrion/player` shows in the
  conformance host after `seek(timeUs)`. It is captured with the Producer's
  presentation barrier and capture (`awaitPresented`, `captureFrame`, D28.5).
- **The golden frame:** the committed golden frame of the Producer (D26.5) for
  the same time.

Nothing is resampled:

- The surface is exactly the composition's width and height in CSS pixels, at
  device pixel ratio 1.
- The capture is clipped to that rectangle at scale 1.
- A decoded image of any other size is refused, never cropped or scaled.

**33.2 The conformance host.** The host is a page in `tests/pinned`:

- Its one module script imports only `@kadrion/player`. The import map serves
  the built `dist` of that package and of the packages it imports, and nothing
  else (never `@kadrion/test-fixtures`). A request for anything else fails the
  measurement.
- Its style sheet is a reset only: `html, body` without margin, padding, or
  overflow.
- It has no control, overlay, handle, or selection.
- It receives from Node:
  - the runtime artifact and its manifest (the files the Producer loads, D28.2);
  - the document as JSON text;
  - the asset bytes that the golden run used (D27.5).
- It passes the document through `JSON.parse` to `player.load`, keeps the exact
  text, and returns it on request.

Before every capture a preflight must pass. On failure the measurement fails:

- `devicePixelRatio === 1` in the host and in the render page, and
  `visualViewport.scale === 1`;
- the Player's frame rectangle is exactly `(0, 0, width, height)`;
- neither the frame nor any ancestor has a transform, `scale`, `rotate`,
  `translate`, or `zoom` other than the identity, or an effect that changes
  pixels without changing the size: `filter`, `backdrop-filter`, `opacity`,
  `mix-blend-mode`, `clip-path`, or `mask-image`;
- the host has exactly one style sheet, the reset, and no inline style on
  `html`, `body`, or the stage;
- the render page's viewport, `scrollWidth`, and `scrollHeight` equal the
  composition's size;
- the document the Player loaded has the expected width and height;
- the Player reports `ready` at exactly the requested `timeUs`;
- the tree under `#kadrion-root` is the hand-derived tree of that time. This
  corroborates the Player's report of the time, and the document it rendered,
  wherever the tree of that time differs from its neighbours'. The Custom HTML
  bar lives in its own sandboxed frame and is not part of the tree;
- every image is decoded, `document.fonts` is `loaded`, and the fixture family
  is available;
- nothing is selected, and the focus is on the host's `body`.

**33.3 Identity of a row.** A row binds the following. The comparison refuses to
compute pixels when any binding fails:

- **Runtime:** the `runtimeHash` the Player verified (D25.5) equals
  `render.runtime.contentHash` of the golden manifest (`runtime-mismatch`).
- **Document:** the `compositionHash` equals `render.compositionHash` of the
  golden manifest (`document-mismatch`). It is computed the Producer's way,
  `sha256(canonicalJson(validated document))`, from the text the host
  **returns**, not the text the test sent. That echo is a transport check: it
  shows which text the page received, not what the Player rendered. The
  document that was actually rendered is bound by the tree check of 33.2 on
  every golden row.
- **Time:** the time the Player confirmed equals the golden frame's `timeUs`
  (`time-mismatch`). The golden frame must also meet all of these:
  - its file name is `reference-<timeUs>.png`;
  - its manifest `index` is the frame of `timeUs` on the grid of D13;
  - the bytes on disk hash to the manifest's SHA-256 (`golden-mismatch`).
- **Dimensions:** both images decode to exactly the composition's size
  (`dimension-mismatch`).
- **Decoding:** both PNGs are valid (`png-invalid`). The PNG must have:
  - a valid signature;
  - `IHDR` first;
  - a CRC-32 check on every chunk;
  - bit depth 8, colour type RGB or RGBA, no interlace, and filters 0–4;
  - an inflated length that is exact;
  - `IEND` last.

**33.4 Metric.** Per row:

- `differingPixels`: the pixels whose RGBA values differ in any channel.
- `totalPixels`.
- `share`: `differingPixels / totalPixels`.
- `maxChannelDifference`: the largest absolute difference of one channel.
- `histogram`: every pixel counted by its largest channel difference, in the
  buckets `0`, `1`, `2-3`, `4-7`, `8-15`, `16-31`, `32-63`, `64-127`, and
  `128-255`. The buckets sum to `totalPixels`.

The worst case over all rows takes the maximum of `differingPixels`, `share`,
and `maxChannelDifference`, each with its time. A tie goes to the earliest time.

**33.5 The record.** The measurement writes
`.kadrion-out/parity/parity-measurement.json` and deletes any earlier record
first. The record contains:

- `recordVersion` 1 and `method` `D33`;
- `thresholds: null` and `gate: false`;
- the environment manifest of the measuring run (D26.4);
- the reference: the path and SHA-256 of the golden manifest, the runtime and
  composition hashes, and the size;
- the rows;
- the worst case.

Every row carries its runtime hash, composition hash, the SHA-256 of both PNGs,
and the golden file. The measuring test checks the record for completeness
before it passes:

- exactly the golden timestamps, in order;
- hashes equal to the golden manifest's;
- histograms that sum to the total;
- a share that is exactly the quotient;
- the worst case recomputed from the rows.

**33.6 The committed record.** The record of the reference run lives as
`docs/spike/parity-measurement.json`. Its source is the first `test:pinned` pass
of `pinned-run.sh reference`, which measures against the committed golden
frames. The script copies the record out before `goldens:update` can rewrite
those frames. `check` verifies the committed record:

- It passes the completeness rules of 33.5 against the committed golden
  manifest.
- Its environment equals the golden manifest's environment on every field that
  affects pixels: `pinned`, image, platform, `os`, `arch`, Playwright, Chromium
  revision and version, reported version, channel, arguments, locale, time
  zone, viewport, and device scale factor.
- Its network was loopback only (D28.9).
- The table of `docs/spike/report.md` is the record's rows and worst case, in
  the same formatting.

`check` cannot prove where a PNG hash came from. The pinned test proves that,
because its premise and its rows go through one capture function.

**33.7 Premise first.** Before it measures, the pinned test proves on real
frames that the metric can see a difference. Every Player frame in these cases
comes from `seekAndCapture`, the capture function of the rows:

- **The next grid time** (2 533 333 µs) against the golden frame of
  2 500 000 µs differs, and `compareFrame` refuses the pair as
  `time-mismatch`. The test first asserts that the Custom HTML bar has a
  different width at the two times. No hand-derived tree exists for that time,
  so this capture skips the tree check.
- **Two golden timestamps** (5 000 000 µs against the golden frame of
  2 500 000 µs), whose hand-derived trees the test first asserts to differ,
  also differ.
- **A golden frame shifted by one pixel column** differs from itself. This case
  is pixels only, with no capture.
- **A document that moves one node** is refused as `document-mismatch`. When
  measured anyway it differs in more than zero pixels, which shows that the text
  reaches the pixels. This capture skips the tree check too, because the tree
  is the reference's.

**33.8 Thresholds (Q9).** _Superseded in part by D34.3: since PR-11 a pinned
measurement is gated at the thresholds of D34.1. The rest of 33.8 stands._ None
in this decision. Rows report numbers and gate
nothing. D34 proposes thresholds from the measured numbers; they become a gate
only once the project owner has accepted D34. Two assertions are separate and
stay:

- The equality gate of D28.5: the Player and the Producer in the same run and
  browser binary differ in zero pixels. This is not a tolerance but an
  invariant. It moves from `player.pinned.test.ts` into
  `tests/pinned/parity.pinned.test.ts`, as its own test that does not depend on
  golden frames.
- The golden-frame equality of the Producer (D26.5).

**33.9 Outside the pinned environment.** The same test runs on a development
machine but is informative only:

- Its record states the environment it ran in.
- It may differ from the golden frames' environment.
- It never replaces `docs/spike/parity-measurement.json`.

**33.10 The Player's dist tree (amendment of PR-11).** The project owner
decided on 2026-09-23 that the record also binds the exact bytes of the public
`@kadrion/player` artifact and of every dist dependency that the conformance
host serves. The runtime artifact alone does not do that.

- **Which files.** The set starts at `packages/player/dist/index.js` and
  follows every static `import` and `export … from` of the served JavaScript
  to its dist file. Relative specifiers resolve inside the same package, and
  `@kadrion/<name>` resolves through the host's import map to
  `packages/<name>/dist/index.js`. The set also contains the two runtime files
  the host fetches: `kadrion-runtime.js` and `kadrion-runtime.json` of
  `packages/renderer-dom/dist/runtime-build/`. Source maps are never served,
  so they are not part of it.
- **Canonical manifest.** One entry `{ path, size, sha256 }` per file:
  - `path` is repository-relative POSIX, never absolute, and never contains
    `..` or a backslash;
  - `size` is the number of bytes;
  - `sha256` is the `sha256:` hash of the bytes.
    The entries are sorted by path in code-unit order, and a path may not repeat.
- **Hash.** `playerDistTreeSha256` is the SHA-256 of
  `JSON.stringify(entries)`, with each entry's keys in the order `path`,
  `size`, `sha256`. The record carries the manifest as
  `playerDistManifest`, so anyone can recompute the hash. No directory, archive,
  timestamp, or file-system metadata enters it.
- **Binding.**
  - The pinned test requires that the paths the host actually served equal
    this set exactly, and that the bytes it served are the manifest's bytes.
  - `check` rebuilds the manifest from the current dist and requires it to
    equal the committed record's. A change to the Player or to one of its
    served dependencies therefore makes the committed record stale until
    `pinned-run.sh reference` runs again.
- **Not in the manifest.** The conformance host's own page (`HOST_PAGE`,
  `HOST_STYLE`) lives in Git, in `tests/pinned/conformance-host.ts`, and is
  reviewed like code.

## Alternatives considered

- **Measuring the playground.** Its `scale(0.35)` resamples the frame, and its
  overlay draws over it. A special `?parity` mode would give the application a
  code path used only by the measurement. D25.2 puts fitting the preview
  outside what parity measures.
- **A 0.35 comparison after resampling both sides.** Resampling hides exactly
  the sub-pixel differences parity is meant to find.
- **Comparing with the Producer of the same run only.** That is the D28.5 gate:
  it proves the two hosts agree within one binary. It says nothing about the
  committed reference output that §6.2 names.
- **Parsing the Player's document hash from the page.** The Player exposes no
  such hash, and adding one to its public API for a test is not warranted. The
  echo of the loaded text, hashed the Producer's way, shows what the page
  received. The tree check shows what it rendered.
- **Thresholds now.** Q9 and the owner require numbers first.

## Consequences

- `tests/parity/parity.ts` becomes the one PNG decoder and metric of the
  repository-level tests:
  - It is pure and free of workspace imports.
  - `tests/parity/parity.test.ts` unit-tests it in `check`.
  - `tests/pinned/support.ts` re-exports its decoder.
- `tests/pinned/conformance-host.ts` and `tests/pinned/parity.pinned.test.ts`
  are new. The informative parity block of `player.pinned.test.ts` and its
  `parity-report.json` are removed; its history-independence test stays.
- `pinned-run.sh reference` copies `parity-measurement.json` out right after
  its first `test:pinned` pass.
- A change of the runtime build, the document, or the golden frames makes the
  committed record stale. `check` then fails until the reference run is
  repeated.
- No package gains an export. `apps/playground` is unchanged.

## Verification

- `tests/parity/parity.test.ts`:
  - the decoder refuses every broken PNG of 33.3;
  - the metric and the histogram are exact on synthetic images;
  - every refusal code of 33.3 is raised;
  - the worst case and the completeness rules of 33.5 are exact.
- `tests/pinned/parity.pinned.test.ts`:
  - the premise of 33.7;
  - the preflight of 33.2;
  - the refusals on real inputs;
  - the five rows;
  - the record checked for completeness;
  - the D28.5 gate.
- `tests/repo/parity-record.test.ts`: the committed record and the report's
  table (33.6).
- Every guard has been seen failing: the mutation table of PR-10.
