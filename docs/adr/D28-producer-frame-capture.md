# D28 — The Producer: render page, frame capture, render manifest, and CLI

- Status: Accepted — by the project owner on 2026-09-22, after the reference run
  of D29.11 passed with the amendment 28.9
- Date: 2026-09-22
- Supersedes: —
- Amended by: PR-07 on 2026-09-22 at the owner's request, 28.9 (network isolation of the reference run)
- Related: D06, D12, D13, D14, D21, D23, D25, D26, D27, D29,
  [specification](../spike/vertical-spike.md) §5 P1–P2, §6.1–§6.3, §7, §8, and
  open questions Q3, Q9, and Q14

## Context

P2 asks the Producer to load the byte-identical runtime build in pinned
Chromium and to render the five golden timestamps to images, the pre-encode
reference output. D25 left three things to PR-06: to build the Producer on
`renderPageDocument` and `KadrionRuntime.frame` "with its own agent or a CDP
call"; to capture a frame only after one in which the Custom HTML element has
presented its new state (the element was seen one compositor frame late); and
to measure whether the page policy closes D23.7's self-navigation gap.

The review of the plan asked which Producer would pass its own tests and still
store a golden frame that the Player would not show for the same
`(composition, timeUs)`. Its answers shaped this decision: different browser
settings in the Player's and the Producer's tests; a different embedding of the
render page; a barrier that makes the Producer wait for something the Player's
measurement does not wait for; a barrier that code inside the element can
fool; different runtime bytes; a different font path; and a Producer that
mounts per frame and so hides history bugs.

Evidence gathered on 2026-09-22 on the Windows development machine (Playwright
Chromium 153.0.8010.12, informative, D26): the sandboxed render page runs out
of process (its own `iframe` target); `Page.captureScreenshot` is refused on
that target ("can only be executed on top-level targets") and works on the
page's own target, where it captured the out-of-process frame.

## Decision

**28.1 Page and embedding.** The Producer opens a fresh page per render, in
the context of D26.3, with a host document that has zero margins and exactly
one `iframe`: `sandbox` = `RENDER_PAGE_SANDBOX`, the styles
`RENDER_PAGE_FRAME_STYLE` (both exported by `@kadrion/renderer-dom` and used by
the Player too), the composition's width and height in pixels, at the top-left
corner, and `srcdoc` = `renderPageDocument([artifact, PRODUCER_AGENT_SCRIPT])`.
This is the Player's embedding (D25.2): the same sandbox, origin, policy, and
nesting of Custom HTML. Every request of the page is aborted and recorded. A
request of the host document or of the render page fails the render with
`network-request`, because the runtime loads nothing; a request that a Custom
HTML frame attempts is blocked by the page policy, aborted as well, and recorded
in the render manifest as `blockedRequests` without failing the render, because
the Player does not fail on it either (§7.5; measured, see Measurements).

**28.2 Runtime identity.** The Producer reads the artifact and its manifest from
`@kadrion/renderer-dom/runtime-build`, refuses a SHA-256 mismatch
(`runtime-hash-mismatch`) and text that D25.2 refuses (`runtime-unsafe`), and
records the hash in the render manifest.

**28.3 Agent.** `PRODUCER_AGENT_SCRIPT` is a script of `@kadrion/producer`,
serialised from one self-contained function like the Player's (D25.8). It
captures `setTimeout`, `clearTimeout`, and `FontFace` of its realm when it
starts, and exposes two calls to CDP evaluation: `load(documentText, assets)`,
which parses the text in the page's realm and calls `KadrionRuntime.load`
(D27.1) with the lent `createFont`; and `frame(timeUs, requestId, ackTimeoutMs)`,
which calls `KadrionRuntime.frame` with the lent timer. It holds no pixel logic
and shares no code with the Player's agent: its transport is CDP evaluation,
not `postMessage`.

**28.4 Frames.** A render is one page, one `load`, and then the requested
frames in the requested order, one after another; the request ID of each frame
is its frame index (D23.6). Only grid times are accepted: an integer `t` with
`frameToTimeUs(timeUsToFrame(t)) === t` inside the composition, else
`frame-out-of-range` before the page opens (D13.2).

**28.5 Painted, then captured.** A frame is captured only after
`KadrionRuntime.frame` has resolved `{ ok: true }` and then the presentation
barrier has passed: in every frame of the page — the host document, the render
page, and every Custom HTML frame, on whichever target runs it — the Producer
creates an isolated world (`Page.createIsolatedWorld`) and waits there for two
animation frames. The isolated world has its own globals, so code of the
element (or a test that replaces the clocks of the page) cannot answer in its
place; each frame waiting in its own renderer means that the renderer has
produced a frame after the element applied the time. The sessions are built
again for every frame, so a frame that appeared since the load is waited for
too, and the barrier fails unless it waited for exactly as many distinct frames
as the page has. The barrier is bounded (`presentation-timeout`). Capture is `Page.captureScreenshot` on the page's own
target with `format: 'png'`, `fromSurface: true`, `captureBeyondViewport:
false`, and a clip of the composition at scale 1 — not Playwright's
`page.screenshot`, which injects a style sheet into every frame. The P1 test
measures the Player through the same barrier and capture functions, so that
parity compares like with like (§6.2).

**28.6 Errors.** `ProducerError` carries a `code`, raised before the first
frame is delivered: `invalid-document`, `frame-out-of-range`, `asset-missing`,
`asset-hash-mismatch`, `asset-invalid`, `runtime-hash-mismatch`,
`runtime-unsafe`, `chromium-missing`, `chromium-mismatch` (D26.3),
`asset-url-invalid` and the other codes of D22.5, `font-load-failed`,
`asset-decode-failed`, `readiness-unsupported`, `custom-html-timeout`,
`page-timeout`, `presentation-timeout`, `network-request`, and `page-error` for
anything else the page reports. A failure after the first frame (for example a
Custom HTML timeout at frame 150) rejects the whole render; frames already
delivered to a callback are not a render.

**28.7 Render manifest (§8).** Every render returns and the CLI writes
`render-manifest.json`: `manifestVersion`; `compositionHash`, the SHA-256 of the
canonical JSON of the validated document (object keys sorted, arrays in order,
no whitespace), so that the Player's side (PR-10) can compute the same value;
`schemaVersion`; `runtime` (`contentHash`, `bundler`, `compiler`); `chromium`
(`playwrightCore`, `revision`, `expectedVersion`, `reportedVersion`, `channel`,
`args`); `environment` (D26.4); `blockedRequests` (28.1); `assets` (`id`, `type`, `mediaType`,
`contentHash`, and for fonts the `family`); `preset` (`frames-png`, width,
height, fps, device scale factor 1); `durationUs`; `frameCount` of the
composition; and `frames` (`index`, `timeUs`, and the SHA-256 of each PNG).
It holds no wall-clock value, so the manifest of a golden render is itself
reproducible. FFmpeg and audio are PR-07.

**28.8 CLI.** `kadrion render-frames --composition <file> --assets <file>
--out <dir> --times <t,…>` renders grid times to `frame-<index>.png` and writes
`render-manifest.json`. `--assets` names a JSON file that maps asset IDs to
`{ "path", "mediaType" }`, with paths relative to that file: where bytes live is
the host's business, never the document's (D14). Exit code 0 on success, 1 for a
`ProducerError` (its code is printed), 2 for a usage error. `@kadrion/cli`
knows no golden timestamp: fixtures are development-only (D12).

**28.9 Network isolation of the reference run (amendment of PR-07).** The
project owner decided on 2026-09-22 that the Producer's boundary against the
network is the absence of a network, not a browser setting:

- The reference run — golden frames, the evidence of P1, P2, and P5, and the
  WebRTC measurement below — runs in the container of D26.2 with
  `--network none`. The page, Chromium, the test runner, and FFmpeg run in that
  one container, so only its loopback interface exists. Inputs are prepared
  before, on a read-only mount; results go to a separate writable mount
  (D29.11). Installing dependencies happens in an earlier container that has a
  network and runs no render.
- The Docker option is the boundary. The environment manifest of D26.4 gains
  `network`: the sorted names of the process's network interfaces and
  `loopbackOnly`, and never an address. It records the run and serves as a
  tripwire: `node --run goldens:update` refuses to write unless the run is
  pinned **and** `loopbackOnly`.
- The Chromium option `--force-webrtc-ip-handling-policy` is not the boundary.
  It may be added later as defence in depth.
- The WebRTC measurement runs in the reference run and is recorded apart from
  `requests` and `blockedRequests`, because ICE and STUN traffic does not pass
  through the request interception of 28.1. It requires, when `loopbackOnly`:
  no connection attempt to a STUN or TURN server in the net log, no candidate of
  type `srflx` or `relay`, no candidate address outside the loopback range, and
  the interface counters of the container unchanged except on `lo`. Outside
  the isolated run it reports and asserts nothing, as before.
- The P1 parity gate of 28.5 (zero differing pixels between the Player and the
  Producer within one browser binary) and the split of 28.1 into `requests` and
  `blockedRequests` stay as they are.

Measured in the reference run of 2026-09-22, the first run of the pinned
container (D26, evidence 5 is superseded by it):

- Only `lo` exists (`/sys/class/net`, `/proc/net/dev`), and its counters moved by
  2 400 bytes in each direction over a whole render — Chromium's own loopback.
- From inside a Custom HTML element, `RTCPeerConnection` was constructed and
  gathered **no candidate at all** (none of type `host`, `srflx`, `prflx`, or
  `relay`), and the net log names neither the STUN nor the TURN host. The log's
  `SOCKET_BYTES_SENT` and `UDP_BYTES_SENT` events both occurred **0** times, so
  the browser sent no byte on any socket. The two addresses the log mentions
  (`192.168.65.7:53` and `[2001:4860:4860::8888]:443`) are the resolver
  configuration the container is handed, not traffic. §7.3 therefore holds for
  WebRTC in the reference run, by the absence of a network, not by a policy.
- Self-navigation (D23.7, D23.9): every variant — `location`, `<meta
http-equiv=refresh>`, a clicked link, a `data:` URL — is refused by the page
  policy, the element's frame ends on `chrome-error://chromewebdata/`, no
  request is made, and the render now fails with `custom-html-navigated`
  instead of a timeout.
- `node --run test:pinned` in the isolated container: 72 passed, 0 failed,
  including the P1 parity gate of 28.5 (zero differing pixels within one
  binary) and the golden frames of D26.5, whose hashes a second pass in a fresh
  container reproduced exactly.

The project owner made acceptance conditional on these measurements, so this ADR
is Accepted with the amendment 28.9 as of 2026-09-22.

## Alternatives considered

- **The render page as the top-level document** — another process and origin
  model than the Player's; the late element of D25 depends on exactly that.
- **Reusing the Player's agent** — its transport is `postMessage` to a parent
  window, and sharing it would need a Producer→Player edge (D12).
- **A barrier in the page's own realm** (`requestAnimationFrame` through
  `frame.evaluate`) — code of the element could replace it, and the
  clock-independence test replaces it on purpose.
- **Only waiting in the render page** — with out-of-process Custom HTML
  frames, a frame of the render page proves nothing about the element's
  renderer.
- **Playwright's `page.screenshot`** — injects a caret-hiding style sheet
  into every frame, so it would alter the page it captures.
- **A per-frame fresh page** — would hide history bugs that the Player, with
  one mount and many seeks, would show.

## Consequences

- `@kadrion/producer` depends on `@kadrion/renderer-dom`, `@kadrion/schema`,
  and `playwright-core`; `@kadrion/cli` on `@kadrion/producer` and
  `@kadrion/schema`.
- The P1 and P2 browser tests live in `tests/pinned` at the repository level,
  because they compare the two hosts; they import the launch, barrier, and
  capture functions from `@kadrion/producer`, and the Player as a built module
  served to the page. No package depends on the other host.
- **Not proven by PR-06:** the project owner declined the container for this
  pull request (D26, evidence 5), so no golden frame exists, P2 is not proven,
  and P1 is not proven. The browser tests ran on the development machine as
  informative results only. The golden-frame test fails loudly in the pinned
  environment until `node --run goldens:update` has been run there.
- Parity between Player and Producer across environments is reported, not
  gated; thresholds are Q9 (PR-10). Within one run of one browser binary the P1
  test does gate it at zero differing pixels: both hosts run the same build in the
  same embedding and are measured the same way, so any difference there is a bug,
  not a tolerance (review of the diff).
- If the measurements hold in the pinned environment, D23.7's self-navigation
  gap is closed by the page policy of D25.2 in both hosts; recording that in
  D23 is the owner's call.
- WebRTC is a channel out of a Custom HTML element that no page policy closes
  (Measurements). Options for the owner, none taken here: a Chromium launch
  option of the Producer that disables non-proxied UDP; running the container
  without a network once dependencies are installed; or accepting it as a
  documented limit of the spike for the Player, which runs in browsers the
  engine does not control.

## Verification

- `packages/producer/test` (Node, no browser): grid-time checks, canonical
  JSON and the composition hash, the manifest, error mapping, the agent's
  source, and the CLI's arguments and asset map (`packages/cli/test`).
- `tests/pinned/producer.pinned.test.ts`: golden frames (pinned only);
  repeatability in three fresh pages; ascending, descending, and shuffled order
  in one page each; the clocks of the page replaced by throwing functions after
  the agent started; typed errors before the first frame; zero requests; the
  bar of the Custom HTML element at its expected width in the PNG; an element
  that replaces `requestAnimationFrame` and paints one frame late is captured
  with its new state.
- `tests/pinned/player.pinned.test.ts` (P1): the five golden seeks; the same
  pixels after a fresh load, after play and pause, and after a backwards seek;
  the Player's runtime hash equals the artifact's; `devicePixelRatio` 1; the
  fixture font only; the parity report against the golden frames, when they
  exist.
- `tests/pinned/custom-html.pinned.test.ts` (§7.6, D23.7): the probes from
  inside an element, the sibling attack, self-navigation, WebRTC, and DNS
  prefetching, with the measured outcome recorded below.

## Measurements

From `node --run test:pinned` on the Windows development machine, 2026-09-22,
Playwright Chromium 153.0.8010.12 (`PLAYWRIGHT_BROWSERS_PATH`, D26 evidence 4).
**Informative only**: the pinned container has not run (D26 evidence 5), so
none of this is evidence of P1 or P2.

- **Out-of-process frames.** The sandboxed render page is a target of its own;
  the Custom HTML frame inside it shares that process (one out-of-process frame
  per page).
- **Presentation barrier.** With the element of 28.5 that replaces its own
  `requestAnimationFrame` and paints one frame after its acknowledgement, 1 of 6
  captures taken right after `frame` resolved showed the previous bar; all 6
  taken after the barrier showed the requested one. The late element of D25 is
  real, and the barrier removes it for this element.
- **Determinism.** Three renders in fresh pages, descending and shuffled order in
  one page, and a page whose clocks throw (`Date`, `Date.now`, `performance.now`,
  timers, `requestAnimationFrame`, `requestIdleCallback`, `queueMicrotask`,
  `FontFace`, `Math.random`) gave pixel-identical frames at all five golden
  timestamps.
- **Parity.** The Player's frames after `seek` and the barrier differed from the
  Producer's in 0 pixels at all five golden timestamps (report only, Q9).
- **Fonts.** In both hosts `CSS.getPlatformFontsForNode` reported only
  `Kadrion Fixture` (custom font) with 7 and 23 glyphs.
- **CSS Object Model.** Chromium lists `white-space` and `overflow` as their
  longhands and keeps `transform` and `opacity` in single precision
  (`1.7125000000000001` reads back as `1.7125`), as D22 anticipated; the browser
  tests compare trees accordingly, and the jsdom fixtures stay exact.
- **§7.6 from inside an element.** Blocked: `parent.document`, `top.document`,
  `top.location.href`, a sibling's document (`SecurityError`); `localStorage`,
  `sessionStorage`, `indexedDB`, `document.cookie` (`SecurityError`); `caches`
  (absent); `fetch`, XHR, WebSocket, EventSource, an image, a font URL, and a
  `data:` worker (policy); `window.open` (returns `null`); `alert` (no dialog);
  top-level navigation (`SecurityError`). The origin is `null`.
- **Requests seen by the Producer.** For XHR, image, font URL, and EventSource
  Chromium reports a policy violation and blocks them, yet Playwright's
  interception still reports them as requests; with interception on or off, a
  local HTTP server received none of them. Hence 28.1's split: such attempts
  are recorded as `blockedRequests`, and only a request of the host document or
  of the render page fails a render.
- **Self-navigation (D23.7), hypothesis confirmed.** `location`, `<meta
http-equiv=refresh>`, a clicked link, and a `data:` URL are all refused by the
  render page's `default-src 'none'` (Chromium: "Framing … violates … Note that
  'frame-src' was not explicitly set, so 'default-src' is used as a fallback");
  no request is made, the element's frame shows an error page, and the next
  frame fails with `custom-html-timeout`, never with a stale frame. The same
  policy is the Player's (D25.2), so the gap of D23.7 is closed in both hosts,
  subject to the pinned environment. The `csp` attribute was therefore not
  measured.
- **WebRTC (D23.7): open.** `RTCPeerConnection` exists inside the element,
  gathers host candidates, and its STUN server name was resolved: the net log
  shows `DNS_TRANSACTION` queries (A and AAAA) for `kadrion-stun.invalid`. The
  page policy does not govern it, and Chromium 153 does not recognise a CSP
  `webrtc` directive ("Unrecognized Content-Security-Policy directive"). §7.3 is
  therefore **not met for WebRTC**, in either host. A mitigation is the owner's
  decision (see Consequences).
- **DNS prefetching.** `<link rel=dns-prefetch>` and `<link rel=preconnect>`
  inside the element produced no entry for their host names in the net log.
