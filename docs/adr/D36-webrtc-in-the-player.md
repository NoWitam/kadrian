# D36 — WebRTC and the network isolation of Custom HTML in the Player

- Status: Accepted — by the project owner on 2026-09-24, with the corrections of PR-13
- Date: 2026-09-24
- Supersedes: —
- Related: D05, D23 (23.7, 23.9), D25, D28 (28.9, Measurements),
  [specification](../spike/vertical-spike.md) §7.2–§7.3,
  [spike report](../spike/report.md) §5

## Context

§7.3 asks that a Custom HTML element have no network access: "its content
comes from the document or from declared assets". The spike meets this for the
Producer, and the reason lies outside the browser. The reference run has no
network at all (`--network none`, D28.9). In that run an element's
`RTCPeerConnection` gathered no candidate, the net log names no STUN or TURN
host, and Chromium sent 0 bytes on any socket (D28, Measurements).

The Player runs somewhere else: in a user's browser, which the engine does not
control, with the host's network. The evidence gathered for it is this:

- **The pinned Chromium on the development machine** (Playwright's Chromium
  153.0.8010.12, revision 1243; D28, Measurements):
  - Inside an element, `RTCPeerConnection` exists and gathers host candidates.
  - The STUN server's name was resolved through DNS: the net log shows A and
    AAAA queries for `kadrion-stun.invalid`.
  - The page policy of D25.2 (`default-src 'none'`) governs none of that.
  - Chromium reports a CSP `webrtc` directive as "Unrecognized".
- **Self-navigation** (D23.7, D23.9): every variant tried (`location`,
  `<meta http-equiv=refresh>`, a clicked link, a `data:` URL) was refused by the
  render page's `default-src 'none'`.
- **Scope of the evidence.** Every measurement of this ADR was made only in the
  pinned Chromium build, on the development machine and in the pinned
  container. The conclusions are not to be extended automatically to Firefox,
  WebKit, or embedded WebViews. None of those was measured, and a host may run
  the Player in any of them.

## The threat

An element is author-supplied HTML and script. It runs in an `iframe` whose
only sandbox token is `allow-scripts`, so its origin is opaque (D23.1).

- **The sandbox is not a network boundary for WebRTC.** No sandbox token
  controls `RTCPeerConnection`, and an opaque origin does not remove it. The
  sandbox isolates the DOM and storage (§7.1, §7.6), not the network stack.
- **STUN.** An element can name any STUN server. The browser resolves the name
  and sends binding requests, and the reply discloses the user's public address
  (`srflx` candidate) to that server. That is a request outside the asset
  resolver of D14 and D25.4, and no host sees it.
- **DNS lookups and TURN fields as a channel.** Before it sends anything, the
  browser resolves the STUN or TURN host name.
  - A name under a domain the author controls reaches the author's DNS server,
    and data can be encoded in the name itself. The development machine's net
    log showed such lookups (D28); the encoding of data was not measured.
  - The `username` of a TURN server entry reaches the TURN server in its
    requests. The `credential` is never sent; it only keys the integrity of
    those requests. This point is analysis and was not measured.
  - Neither needs a data channel, and a policy that limits ICE candidates does
    not stop a DNS lookup.
- **ICE candidates.** Without camera or microphone permission, Chromium hides
  private host addresses behind `<uuid>.local` mDNS names. The development
  machine showed host candidates, and D28 treats mDNS names as expected. This
  ADR does not claim that raw LAN addresses leak. The disclosure it
  demonstrates is the public address, through STUN. Relay candidates (TURN)
  add a third party.
- **Data channels and signalling.** Establishing a WebRTC connection requires
  an exchange of signalling data, but the standard does not prescribe a
  particular signalling server. The exchange can happen over any channel
  available to the application outside WebRTC itself.
  - For an element, that channel can be the document: its author can write the
    remote description (SDP) and the ICE credentials of a server they control,
    for example an ICE-lite endpoint, into the element's HTML before it is
    published. The signalling has then happened ahead of time, and the element
    opens an `RTCDataChannel` to that server while it runs.
  - That is a two-way channel out of the page even with `connect-src 'none'` and
    every other fetch directive at `'none'`.
  - Whatever the element can see can leave through it: the composition's text
    and the time pushed to it. It receives no host secret (§7.2).
  - Content can also arrive through it, which contradicts "content comes from
    the document or declared assets".

  This scenario is analysis, not a measurement: the spike never opened such a
  channel. It is plausible for two reasons. The remote endpoint learns the
  element's ICE username from the connectivity checks. And a server of the
  author can accept the element's DTLS certificate without knowing its
  fingerprint in advance.

- **Self-navigation.** A navigated element document would not be bound by the
  shell's policy (D23.7). The render page's policy refused every navigation
  tried, in the pinned Chromium only.
  - In the Player, the renderer's `load` count and the error
    `custom-html-navigated` are a best-effort mechanism, not a normative
    security boundary (D23.9). A navigated document can answer before its
    `load` reaches the host.
  - The normative comparison of document identity through CDP (loader ID and
    URL, D23.9, D29) applies today only to the Producer.

## What each control does and does not do

- **CSP of the render page** (`default-src 'none'`, inherited by the `srcdoc`
  frames, D23.6).
  - What it does:
    - blocks fetch, XHR, WebSocket, EventSource, images, fonts, and workers;
    - refused the self-navigation that was tried (pinned Chromium).
  - What it does not do: govern `RTCPeerConnection`, ICE, or data channels.
  - CSP Level 3 drafts a `webrtc` directive (`'allow' | 'block'`). The pinned
    Chromium reported it as unrecognised, and no other browser was measured.
    Because `srcdoc` frames inherit the embedder's policy, a directive that the
    Player sets would reach nested frames once a browser supports it.
- **Permissions-Policy.**
  - `camera`, `microphone`, and `display-capture` gate `getUserMedia` and
    `getDisplayMedia`.
  - Disabling `camera` or `microphone` does not block `RTCPeerConnection` or
    `RTCDataChannel`. The media features and the peer-connection APIs are
    separate mechanisms and are treated separately here. An element can open a
    peer connection and a data channel without any media.
  - This ADR knows of no widely supported policy feature that switches off peer
    connections.
- **Isolated (opaque) origin.** It removes storage, cookies, and access to the
  parent (§7.6, measured). It removes no network API that is available to
  opaque origins, and `RTCPeerConnection` is one of them.
- **Policies of the host.** The host can hold two kinds of control, and neither
  is in the engine's hands:
  - **Its own page's CSP and response headers.** They apply to the host page and
    are inherited by the `srcdoc` render page. They have the same limits as the
    render page's CSP above.
  - **Controls over the browser or the network.**
    - Browsers have a class of policies and command-line options that limit
      which ICE candidates, and so which addresses, a page may expose. Chromium
      has such settings for managed deployments. Their names and availability
      per browser and version are **to be verified**, and none of them is a
      normative control of this ADR.
    - Such settings give **no guarantee** that all WebRTC traffic is blocked.
      Communication through TURN, over TCP or TLS, or along another route the
      setting allows stays possible, and so does the DNS lookup of a STUN or
      TURN name.
    - A proxy or firewall can block traffic, but only where the host controls
      the network.

## Decision

The project owner decided on 2026-09-24:

1. **Custom HTML in the Player is a host opt-in.** It is off unless the host
   application enables it.
2. **The Player does not claim full network isolation of untrusted Custom
   HTML.** §7.3 holds for the Producer (D28.9), not for the Player.
3. **Untrusted Custom HTML is disabled by default in the interactive preview.**
4. **Enabling it requires an explicit decision of the host application**, and
   that decision documents the limitations stated in this ADR.
5. **The Producer keeps the normative isolation `--network none`** (D28.9).
   Nothing here changes the reference run.
6. **The code of this policy comes in a separate pull request.** PR-13 records
   the decision and implements nothing: neither the opt-in nor any change in
   the Player's behaviour.

The pull request that implements the decision also settles how the host marks
an element as trusted. The proposal is a Player option that the host sets, per
document or per element ID, and not a field of the schema: the spike has no
use case for a persistent trust flag, and a schema field would put a security
decision into content that authors write (D16).

## Options considered

Each option is described with what it does and what it does not do. The
decision above follows A and B, keeps D for the Producer only, and implements
none of them in PR-13.

- **A — Documented limitation and host opt-in.** Custom HTML stays available
  in the Player. The Player's API requires the host to enable it explicitly and
  to accept a written security policy stating that elements are not
  network-isolated. It closes no channel, but it makes the risk a decision of
  the host rather than a default.
- **B — No untrusted Custom HTML in the interactive preview.** The Player does
  not execute Custom HTML it was not told to trust. It shows instead either the
  placeholder box of D22/D23 or a still frame of that element. The host
  arranges the still frame with the Producer inside the isolated run; the
  Player never calls the Producer (D12).
  - It closes every channel of this ADR for untrusted content.
  - The cost is that the preview of such an element is not interactive, and a
    still frame is not the same pixels as the live element at every time.
- **C — Removing `RTCPeerConnection` in the element's realm.** The shell deletes
  or freezes `RTCPeerConnection`, `webkitRTCPeerConnection`, and related globals
  before the author's script runs. It is not a control, for three reasons:
  - the element can create a nested `srcdoc` or `about:blank` frame, whose fresh
    realm has the constructors again;
  - aliases and prototypes offer further paths;
  - every new browser API needs a new entry.

  At most, it reduces accidental use.

- **D — Browser and network controls of a controlled deployment.** Settings
  that limit ICE candidates, or a proxy or firewall. These are only possible
  where the host controls the browser or the network, and never in a user's
  own browser. As said above, they are not a guarantee against all WebRTC
  traffic. For the Producer the control is the absence of a network (D28.9),
  not a browser setting.
- **E — CSP `webrtc 'block'` once browsers support it.** The Player's render
  page would set it, and the nested frames inherit it. This needs a measurement
  in every browser a host supports before it may count as a control.
- **F — A different sandbox for elements.** For example, rendering Custom HTML
  in a realm without `RTCPeerConnection`, or in a separate cross-origin process
  with network-level isolation. This is a new mechanism and would supersede
  D23. It is out of reach of the next phase.

## Alternatives considered

- **Option C as the control.** It is bypassable (see C) and would give a false
  sense of isolation.
- **Treating the Player like the Producer.** The Player's environment is a
  user's browser, and the engine cannot remove its network.
- **Waiting for CSP `webrtc`.** No date is known, and every browser would need
  to be measured.

## Consequences

- Until the implementing pull request lands, the Player's behaviour is
  unchanged. It still executes the Custom HTML of every document it loads, and
  the spike report records this as an open limitation (§7.3 unmet for the
  Player).
- The implementing pull request brings:
  - the host opt-in in the Player's API;
  - the preview behaviour for untrusted elements (option B);
  - tests;
  - an update of the playground's Custom HTML showcase (D32), which must
    declare that it enables Custom HTML.

## Verification

Not mechanically verified until the implementing pull request. PR-13 changes no
code for this decision. The evidence it relies on is D28 (Measurements),
D28.9, and D23.9, all measured in the pinned Chromium only.
