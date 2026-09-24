# D23 — Custom HTML sandbox, message protocol, and time contract

- Status: Accepted — by the project owner on 2026-09-22, after the change of 23.3 and green tests
- Date: 2026-09-22
- Supersedes: —
- Amends: D22.3, the Custom HTML row (the placeholder is no longer empty)
- Amended by: PR-07 on 2026-09-22 at the owner's request, 23.9 (a navigated element ends the render)
- Related: D05, D14, D16, D19, D20, D21, D22,
  [specification](../spike/vertical-spike.md) §5 P1–P2, §7, and open questions
  Q13 and Q16

## Context

D05 allows Custom HTML only as an isolated, capability-limited element, and
§7 of the specification lists what that means for the spike: an isolated
browsing context (7.1), no host secrets or privileged APIs (7.2), no network
(7.3), a time contract in which the host pushes `timeUs` and waits a bounded
time for an acknowledgement (7.4), identical behaviour in Player and Producer
(7.5), and negative tests (7.6). §7 proposes the mechanism — a sandboxed
`iframe` with an opaque origin, inline content, a restrictive Content Security
Policy, and a message-based protocol — and leaves its confirmation to this pull
request. D20 gives the mount to `@kadrion/renderer-dom` and requires that code
of that package which waits receives its timer from the host (D20.2).

Constraints that shaped the decision:

- Schema 0.1 stores the element as an inline `html` string (Q13, D16) and
  defines no capability.
- As PR-01 wrote it, the fixture element listened for
  `{type: 'kadrion:time', timeUs}`, set the width of a bar to
  `timeUs / 100000` percent, and answered with
  `{type: 'kadrion:time-ack', timeUs}` through `parent.postMessage(…, '*')`,
  without checking who sent the message. The first proposal of this ADR kept
  that protocol and recorded that a sibling element could retime it (§7.1).
- The determinism guardrail binds every source of the renderer without an
  inline exception (D20.3), and it bans `defaultView`, so the renderer cannot
  find the host window by itself.

Evidence gathered on 2026-09-22 (jsdom 29.1.1, Node.js 22.22.0): jsdom does not
load `srcdoc`, and it does not enforce `sandbox`; the `contentWindow` of an attached `iframe` exists (an `about:blank`
window of the same origin) and receives `postMessage`; a `MessageEvent`
dispatched on the host window with `source` and `origin` set reaches its
listeners. Setting `border-style: none` reads back through the CSS Object Model
as five declarations in jsdom, the four side longhands as four. Everything that
depends on real isolation is therefore measured in pinned Chromium by PR-06,
not here. jsdom does run the scripts of a child frame when its window runs
scripts, `window.parent` and `parent.frames[i]` work, but its `postMessage`
sets no `event.source`; the tests of 23.3 therefore deliver messages through a
harness that models the incumbent rule of HTML (PR-05).

**Decision history.** On 2026-09-22 the project owner rejected the sibling
deviation of the first proposal, and also a migration to `MessagePort`: protocol
version 1 is bound to the exact `WindowProxy` in both directions, correlated by
version, instance, and request, and the host posts to each frame directly. The
owner decided that this changes the fixture element within schema 0.1 without a
migration: the fixture is the only persisted document that contains Custom
HTML. `MessagePort` may come later as a hardening or an extension. After that
change and green tests the owner accepted this ADR.

## Decision

**23.1 Isolation.** `mountComposition` places exactly one `iframe` into the
placeholder of every Custom HTML node. Its attributes are `sandbox` with the
single token `allow-scripts`, then `srcdoc` (23.2), then its styles, all set
while the element is still detached; it is attached together with the whole
tree. It has no `src` and no `allow-same-origin`, so its document has an opaque
origin: it cannot read the host document, storage, or cookies. No other
sandbox token is granted, so forms, pop-ups, modal dialogs, top-level
navigation, pointer lock, and downloads are blocked. Styles: `display: block`,
`width` and `height` of the node in px, and `border-top-style`,
`border-right-style`, `border-bottom-style`, `border-left-style` set to
`none` (longhands, so that jsdom and Chromium read back the same declarations).

**23.2 Document of the element.** `srcdoc` is a fixed shell, which names the
node's ID as the element's instance, followed by the document's `html`, byte for
byte:

```text
<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="kadrion-instance" content="<nodeId>"></head>
```

Node IDs match `^[A-Za-z0-9_-]+$` (D16), so the ID needs no escaping. It is not a
secret — every author of the document knows every ID — and authenticates
nothing; the window a message comes from does (23.3).

The shell comes first so that the policy precedes every byte of author content:
the author's own `<!doctype>` becomes an ignored parse error (the shell has put
the document into standards mode already), and the author's `meta` and `style`
elements still land in `head`. A policy the author adds can only restrict
further, because every policy is enforced. `default-src 'none'` blocks fetch,
XHR, WebSocket, images, fonts, media, frames, and workers; inline script and
style are allowed, `eval` is not. The `html` is set as an attribute value and is
never parsed in the host document.

**23.3 Protocol, version 1.** Both messages have exactly five own keys:

| Direction      | Message                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| host → element | `{ type: 'kadrion:time', version: 1, instanceId, requestId, timeUs }`, posted to that frame's `contentWindow` |
| element → host | `{ type: 'kadrion:time-ack', version: 1, instanceId, requestId, timeUs }`, posted to `window.parent`          |

- `instanceId` is the node's ID, which the element reads from its shell (23.2).
- `requestId` is a non-negative safe integer that the host chooses per
  synchronization (`CustomHtmlHost.requestId`); the renderer keeps no counter.
- `timeUs` is the absolute composition time of D04, the same integer that the
  host evaluated the frame at.
- The target origin is `*` because an opaque origin cannot be named; the
  messages carry nothing but these five values.

Authentication rests on the identity of the `WindowProxy`, on strict
validation, and on correlation — not on `event.origin`, which is `null` for
every sandboxed frame.

- **The host** posts the time to each frame's `contentWindow` directly, never
  to all frames at once. It accepts an acknowledgement only when its `source` is
  the `contentWindow` of that node's `iframe`; its data has exactly the five keys;
  `type` is `kadrion:time-ack`, `version` is `1`; and `instanceId`, `requestId`,
  and `timeUs` equal the pending request of that node. Its `origin` must also be
  `null`, as an additional check. Anything else is ignored: it is not accepted,
  and the wait goes on. Prototypes are not compared, because the data belongs to
  the realm of the receiver.
- **A conforming element** — the fixture's is one — accepts `kadrion:time` only
  when `event.source === window.parent`; its data has exactly the five keys;
  `type` is `kadrion:time`, `version` is `1`, `instanceId` is its own; and
  `requestId` and `timeUs` are non-negative safe integers. Anything else it
  ignores: it neither changes what it shows nor answers. It answers only to
  `window.parent`, with the same `instanceId`, `requestId`, and `timeUs`.

The renderer cannot enforce what an element does; an element that does not
conform can be retimed by a sibling, but only itself. A sibling cannot make a
conforming element show another time, and cannot answer in its name, because
the host checks the window.

**23.4 Time contract.** `renderState` stays synchronous and stateless (D22.4).
A separate call does the waiting:

```ts
synchronizeCustomHtml(root, state, host): Promise<void>
```

- `host.messageTarget` is the window of the document that owns `root`, lent by
  the host (only its `addEventListener` and `removeEventListener` are used);
  `host.startTimer(expire)` starts the bounded wait, calls `expire` once when the
  host decides the wait is over, and returns a function that cancels it. The
  duration is the host's policy; the renderer never measures time (D20.2).
  `host.requestId` is the request ID of 23.3; another value rejects with the
  `RenderError` code `invalid-request`.
- The mounted tree is checked against `state` first, as by `renderState`, and
  every Custom HTML element must hold exactly one `iframe` with the attributes
  `sandbox="allow-scripts"`, `srcdoc` beginning with the shell of 23.2 for that
  very node, and `style`, and nothing else; a problem throws before any message
  is posted.
- Then it listens, posts the time to every Custom HTML element, and posts it
  once more to an element whose `iframe` fires `load` during the wait: a message
  posted before the `srcdoc` document is active is lost, and `load` fires after
  its inline scripts have run.
- It resolves when every Custom HTML node of the state has acknowledged
  `state.timeUs`; a state without such a node resolves without starting a timer.
  When `expire` is called first, it rejects with the `RenderError` code
  `custom-html-timeout`, which names every node that did not acknowledge.
- On either outcome it removes its listeners and cancels the timer. Nothing is
  kept between calls.

An acknowledgement means "the element has applied this time". It does not prove
that the element is painted or that it will not change afterwards (CSS
transitions, `requestAnimationFrame`, `Date.now` inside the element). A host
never captures a frame whose synchronization did not resolve; the rest only
golden frames in the pinned environment detect.

**23.5 Page entry (extends D21.4).** `KadrionRuntime.synchronize(root,
document, timeUs, host)` validates the document like `render`, evaluates it, and
returns a promise of the same `PageResult`; a timeout rejects with the
`RenderError` of 23.4.

**23.6 Host obligations.** The renderer is stateless and cannot enforce these;
the hosts must:

- give every synchronization of a root that may still be pending its own
  `requestId`, and run at most one per root at a time: the DOM holds one instant,
  so overlapping synchronizations would wait for times that are no longer
  shown. The Player (PR-05) serialises seeks; the Producer (PR-06) renders
  frames in sequence and passes the frame index;
- render first (`renderState`), then synchronize, and capture only after the
  promise resolved;
- let the element run: its document inherits the Content Security Policy of the
  page that mounts it, so that page (PR-05, PR-06) must allow inline script and
  style for the frame, or the element never acknowledges and every
  synchronization fails with `custom-html-timeout`, never with a stale frame.

**23.7 What PR-04 does not meet.** Stated plainly, so that nothing counts as
verified that is not:

- **§7.3 against self-navigation.** A sandbox without `allow-top-navigation`
  still lets the frame navigate itself (`location`, `<meta http-equiv=refresh>`,
  a link). The navigated document is loaded from the network, is not bound by the
  shell's policy, still has the origin `null` and the same `contentWindow`,
  receives the post on `load`, and can acknowledge. PR-04 therefore does **not**
  meet §7.3 for an element that navigates, in the Player as well as in the
  Producer. PR-06 measures two mitigations in pinned Chromium: `frame-src` in the
  policy of the page that mounts the element (CSP Level 2, every browser; it must
  still admit the `srcdoc` document), and the `csp` attribute of the `iframe`
  (CSP Embedded Enforcement, Chromium only). The outcome is recorded as an ADR:
  D28 (Measurements) and the amendment 23.9.
- **§7.1 between elements — met for conforming elements, measured in jsdom
  only.** An element can still reach a sibling through `parent.frames[i]` and post
  to it, but a conforming element ignores anything whose source is not its
  parent (23.3), and the host ignores an answer from any window but that node's
  frame. `custom-html-element.test.ts` runs the fixture element next to a real
  attacker script in jsdom, whose `postMessage` the harness replaces (Context);
  PR-06 repeats the test in pinned Chromium.
- **Determinism of author code.** The renderer cannot stop an element from
  reading `Date.now` or animating on its own; §6.1 holds only for elements that
  derive their state from `timeUs`, as the fixture does. Golden frames detect the
  rest.
- **Channels outside the policy**: WebRTC and DNS prefetching are not governed
  by `default-src`; PR-06 probes them.

**23.8 Amendment of D22.3.** The Custom HTML row of D22.3 reads: "Custom HTML
placeholder `div` with `data-kadrion-node`, the group styles plus `width` and
`height` in px, and exactly one child, the `iframe` of 23.1." `renderState`
still writes `transform` and `opacity` to the placeholder only.

**23.9 Amendment of PR-07: a navigated element ends the render.** Recorded at
the project owner's request on 2026-09-22. The measurement of D28 (Measurements,
"Self-navigation") showed on the development machine that the render page's
policy `default-src 'none'` refuses every self-navigation it tried, and that the
next frame then failed with `custom-html-timeout`. It also showed why the
protocol of 23.3 cannot be the defence: after a navigation the frame keeps its
`WindowProxy`, so an acknowledgement from the new document comes from exactly
the window that 23.3 binds to. Binding to the `WindowProxy` is therefore not
enough once an element navigates or reloads, whatever the page policy does. The
normative behaviour is:

- The frame of a Custom HTML element hosts exactly one document: the `srcdoc`
  shell of 23.2. `sandboxFrame` counts the `load` events of the frame from its
  creation; the first is the shell, and every later one — a navigation, a
  reload, or an error page after a refused navigation — marks the frame with
  the attribute `data-kadrion-navigated`. Once marked, the frame stays marked.
- A marked frame invalidates the protocol session of its element: an
  acknowledgement from it is never counted, a `load` that marks it during a
  synchronization rejects that synchronization, and every later synchronization
  rejects before it posts anything. The `RenderError` code is
  `custom-html-navigated`, and it names the element.
- A host ends the render on that error; it never continues with a document
  that may have been replaced. The Producer maps it to the `ProducerError` code
  of the same name (D28.6).
- The `load` count is the renderer's signal, available to every host. It is
  best effort: a navigated document can answer before its `load` reaches the
  host, and moving a mounted tree in the host document reloads its frames,
  which also counts as a navigation (re-mount instead). The Producer therefore
  also compares the document of every Custom HTML frame before and after each
  capture, by its CDP loader ID and URL, and that check is the normative one
  for reference output (D29).

Verified by `packages/renderer-dom/test/custom-html.test.ts` (jsdom: a second
`load` before, during, and after a synchronization) and by
`tests/pinned/custom-html.pinned.test.ts` (every self-navigation variant ends
with `custom-html-navigated`; a conforming element sees exactly one `load` over
a whole render).

## Alternatives considered

- **A sandbox page on a separate origin** (`src` instead of `srcdoc`) — the
  policy would come from response headers and self-navigation could be bounded
  by `frame-src`, but every host would need to serve that origin, the element
  would be loaded over the network, and the Producer would need a web server.
- **A `MessagePort` per element** — a private channel even for elements that do
  not check the source. The owner declined it for now; it may come later as a
  hardening or an extension of the protocol.
- **Keeping the protocol of PR-01** (`type` and `timeUs` only) — a sibling could
  retime the element (first proposal, rejected by the owner).
- **Authenticating by `event.origin`** — every sandboxed frame has the origin
  `null`, so it tells no two elements apart.
- **Rendering the HTML into the host document or a shadow root** — no
  isolation at all (D05).
- **The renderer schedules its own timeout or polls** — a clock inside the
  package (D20.2).
- **An element-initiated "ready" message** — the fixture sends none; re-posting
  on `load` needs nothing from the element.
- **Failing on a wrong acknowledgement instead of ignoring it** — a late answer
  to an earlier request is normal while the Player seeks; ignoring it can never
  accept a stale frame, because only the pending request counts.

## Consequences

- `@kadrion/renderer-dom` exports `synchronizeCustomHtml` and the types
  `CustomHtmlHost` and `MessageTarget`; `RenderErrorCode` gains
  `custom-html-timeout` and `invalid-request`. The runtime build gains
  `synchronize` and so a new hash.
- The fixture element of `reference.json` is a conforming element of 23.3.
  `reference.expected-render.json` records the `iframe` and, per golden
  timestamp, the message the host posts and the acknowledgement it accepts, for
  a host that passes the frame index as its request ID.
- The guardrail additionally bans the members `parent`, `top`, `opener`,
  `frames`, and `contentDocument` in the deterministic sources (D24.5), so the
  `contentWindow` the renderer needs for posting cannot be walked back to the
  host window, and the frame's document cannot be read. This is not isolation of
  the host window from the renderer: the host lends that window itself as
  `messageTarget`, and `event.currentTarget` of a message is that window. The
  renderer uses only `addEventListener` and `removeEventListener` of it, which
  the type `MessageTarget` states; its clocks stay banned by name, but its
  `document`, `location`, or storage are held back by review, not by lint.
  A host may pass a thin wrapper instead of the window (recommended for PR-05).
- PR-05 serialises synchronizations, sets the policy of its render page as
  23.6 requires, and verifies that the artifact runs under it. PR-06 runs the
  negative tests of §7.6 and the probes of 23.7 in pinned Chromium.

## Verification

- `tests/repo/expected-render.test.ts`: the `iframe` and its `srcdoc` are
  derived from the document with a shell and a policy written out independently;
  the expected messages carry the golden times and their frame indices as request
  IDs; and the fixture's `html` is pinned as a conforming element of 23.3.
- `packages/renderer-dom/test/custom-html.test.ts` (jsdom): the exact tree and
  attribute order (sandbox before `srcdoc`, both while detached); the HTML lands
  in `srcdoc` only; the exact messages; resolution on a valid acknowledgement;
  `custom-html-timeout` on expiry; wrong time, wrong source, wrong origin, extra
  keys, and malformed data are not accepted; the re-post on `load`; listeners and
  timer released on both outcomes; checks before any post; order and
  repeatability on one tree; clock independence in both realms; a premise test
  that jsdom does not load `srcdoc`, so an upgrade that changes that fails
  loudly.
- `packages/renderer-dom/test/custom-html-element.test.ts` (jsdom, real element
  scripts, messages delivered by a harness that models the incumbent rule): the
  fixture element applies each golden time and answers exactly the expected
  acknowledgement; it ignores a message from another source and every malformed
  message; an attacker element that reaches the fixture element through
  `parent.frames[1]` cannot retime it and cannot answer in its name.
- `packages/renderer-dom/test/runtime-build.test.ts`: the artifact exposes
  `synchronize`, stays byte-identical across builds, and synchronizes in the
  realm of the page with a timer injected by the test.
- Not verified here, listed as `it.todo` for PR-06: that from inside the element
  the parent document, the network, and storage are unreachable (§7.6), and the
  probes of 23.7.
