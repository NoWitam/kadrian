# Vertical spike specification

- Status: Draft (written in PR-00; refined by the pull requests that implement it)
- Authority: `AGENTS.md` ("Current phase", "Reference spike", invariants) and the
  ADRs in [`docs/adr`](../adr/README.md)
- Reading guide: statements taken from `AGENTS.md` are normative. Details this
  document adds are marked **Proposed**. Anything still undecided is listed in
  [§11 Open questions](#11-open-questions) and must not be decided implicitly
  in code.

## 1. Purpose

Prove one narrow end-to-end path through every package boundary before any
single package is built out:

1. One versioned JSON composition is loaded by a browser player.
2. The same runtime renders it in pinned Chromium on the server.
3. A canvas interaction changes the JSON through a typed domain command.
4. An AI-shaped tool call performs an equivalent command.
5. The Producer exports an H.264 MP4 without storing all intermediate frames.

The spike is finished when each proof has recorded evidence
([§5](#5-proofs-and-acceptance-criteria)), not when the code is feature
complete. The spike is allowed to conclude that an accepted decision has to
change; that result is delivered as a proposed ADR, never as a silent
workaround.

## 2. Non-goals

The spike must not turn into a complete editor, media platform, plugin
ecosystem, or Taskio integration. Explicitly outside the current scope:

- Taskio database models, queues, permissions, billing, and multi-tenancy.
- A production REST service or distributed render farm.
- Full timeline UI, advanced trimming, color grading, filters, or transitions.
- A conversational LLM agent or production asset generation pipeline.
- CRDT collaboration, public plugins, 4K, HDR, and desktop/mobile apps.

## 3. Reference composition

### 3.1 Fixed parameters (normative)

| Parameter  | Value                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Duration   | 10 s = `10_000_000` µs                                                                                                                   |
| Canvas     | 1080 x 1920 (portrait)                                                                                                                   |
| Frame rate | 30 fps, so 300 frames with indices 0–299                                                                                                 |
| Content    | a background, one image, two text nodes, one group, opacity/position/scale keyframes, one sandboxed Custom HTML element, one audio track |

### 3.2 Inventory (Proposed)

Stable IDs are required for scenes, nodes, clips, animations, and assets. PR-01
fixed the IDs below in the reference composition
(`packages/test-fixtures/src/compositions/reference.json`);
`packages/schema/test/reference-composition.test.ts` fails when the inventory
or its wiring changes.

| ID                    | Kind        | Role in the spike                                                                                 |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `scene-main`          | scene       | The only scene, full duration                                                                     |
| `node-background`     | background  | Solid fill behind everything                                                                      |
| `node-group`          | group       | Contains `node-image` and `node-caption`; shows that children follow the group's transform        |
| `node-image`          | image       | Displays `asset-image`                                                                            |
| `node-title`          | text        | Top-level text; the node moved by the editing proofs (its position is not animated)               |
| `node-caption`        | text        | Second text node, inside the group                                                                |
| `node-custom-html`    | custom HTML | Sandboxed element that displays a value derived from `timeUs`, so drift shows up in golden frames |
| `clip-audio`          | audio clip  | Plays `asset-audio` for the full duration                                                         |
| `anim-title-opacity`  | animation   | Opacity keyframes on `node-title`                                                                 |
| `anim-group-position` | animation   | Position keyframes on `node-group`                                                                |
| `anim-image-scale`    | animation   | Scale keyframes on `node-image`                                                                   |
| `asset-image`         | asset       | Small raster image                                                                                |
| `asset-audio`         | asset       | Short audio file; a generated tone is enough                                                      |
| `asset-font`          | asset       | Pinned font used by both text nodes (see below)                                                   |

Derived requirement: `AGENTS.md` does not list a font, but it requires that
"assets, fonts, randomness, and runtime versions must be explicit or pinned".
Two text nodes therefore imply one explicit, pinned font asset.

Asset provenance (D10): every fixture asset and font that enters the repository
records where it came from and under which licence, and that licence must allow
redistribution in a possibly public repository. Generated assets are preferred.
PR-01 ships no binary assets: the three asset entries carry placeholder hashes
until the binaries arrive (D14).

Keyframe placement rule (Proposed, strengthened by PR-01): for each animated
property, at least one golden timestamp falls exactly on a keyframe, and at
least one falls strictly between two keyframes that have different values,
**away from the midpoint** of that segment. At the midpoint, swapped endpoints
and every symmetric easing give the same value as linear interpolation, so a
midpoint sample does not verify it. The reference composition also samples a
hold before a first keyframe and a hold after a last keyframe.

Expected evaluated state (PR-02):
`packages/test-fixtures/src/compositions/reference.expected-state.json` records
what the runtime must produce at the five golden timestamps. It was derived by
hand from D16.6 and D18, with the derivation next to the numbers, before the
runtime existed, and it is never regenerated from an implementation. Two known
limits: every animated scale and opacity of the reference composition has the
base value 1 and the first position offset is zero, so the golden states prove
"an animation modifies the base value" through the group position only; and the
golden timestamps do not pin the order of the operations of D18, which 69 of the
300 grid frames do. `packages/runtime/test/evaluate.test.ts` closes both gaps
with synthetic documents and with frame 61.

### 3.3 Golden timestamps (normative)

| `timeUs`    | Frame index at 30 fps |
| ----------- | --------------------- |
| `0`         | 0                     |
| `2_500_000` | 75                    |
| `5_000_000` | 150                   |
| `7_500_000` | 225                   |
| `9_900_000` | 297                   |

All five frame indices are multiples of 3, so their times are whole
microseconds at 30 fps. The golden frames therefore **cannot** detect an error
in the frame/time mapping; [§4](#4-time-model) requires a separate property
test for it.

## 4. Time model

- Persistent time values are integer microseconds (D04).
- Runtime state for a frame is derived from `(composition, timeUs)` only.
  Runtime animation logic must not depend on `Date.now()`, timers, playback
  history, UI state, or the number of previously rendered frames.
- The frame grid needs one rule **in both directions**, shared by the Player's
  frame stepping and the Producer. The rule is decided by
  [D13](../adr/D13-frame-grid-and-integer-frame-rate.md) and implemented in
  `@kadrion/schema`, in integer arithmetic:
  - `frameToTimeUs(i) = floor(i * 1_000_000 / fps)`
  - `timeUsToFrame(t) = floor(((t + 1) * fps - 1) / 1_000_000)`, which is the
    largest `i` with `frameToTimeUs(i) <= t`
  - At 30 fps the grid is 0, 33_333, 66_666, 100_000, …; frame 299 samples
    9_966_666, and the composition end `10_000_000` is exclusive.
  - The naive inverse `floor(t * fps / 1_000_000)` is wrong for two of every
    three frames (frame 1 samples 33_333 µs, which it maps back to frame 0).
- A **property test over all 300 frames** guards the rule
  (`packages/schema/test/frame-grid.test.ts`): `timeUsToFrame(frameToTimeUs(i)) === i`, `frameToTimeUs` is strictly
  increasing, and every integer `t` inside the composition satisfies
  `frameToTimeUs(f) <= t < frameToTimeUs(f + 1)` for `f = timeUsToFrame(t)`.
- Seeking to a `timeUs` that is not on the frame grid is valid in the Player.
  The Producer samples only grid times.
- Evaluation takes an integer `timeUs` with `0 <= timeUs < durationUs`. Any
  other value is a typed error, never a clamped or rounded time, and the
  evaluation never reads `fps`. How a value between two keyframes is computed,
  bit for bit, is one rule. Both are proposed by
  [D18](../adr/D18-keyframe-sampling-and-arithmetic.md).

## 5. Proofs and acceptance criteria

Each proof lists the evidence that must exist in the repository when it is
claimed. Numbers that can only come from measurement are not invented here.

### P1 — A versioned JSON composition is loaded by a browser player

- The reference composition validates against schema `0.x`; the schema version
  is part of the document, and an unsupported version is an error.
- The Player renders the composition and supports play, pause, and
  `seek(timeUs)`.
- Seeking to a golden timestamp yields the same frame regardless of what was
  displayed before (fresh load, after playback, after seeking backwards).
- The Player loads nothing except the runtime build and the assets declared by
  the document. A missing required asset or font is a typed error.
- Evidence: automated browser test covering the five golden timestamps.

### P2 — The same runtime renders it in pinned Chromium on the server

- The Producer loads a runtime build artifact that is **byte-identical** to the
  one the Player loads, in a pinned Chromium.
- The Producer renders the five golden timestamps to images. These pre-encode
  frames are the reference output.
- Golden frames are asserted only in the pinned reference environment. Results
  from a developer machine, including the Windows development machine, are
  informative only.
- Repeatability and order independence hold as defined in
  [§6.1](#61-determinism-of-the-reference-output).
- Evidence: golden frames in `@kadrion/test-fixtures`, a test that re-renders
  and compares them in the pinned environment, and a render manifest
  ([§8](#8-producer-requirements)).

### P3 — A canvas interaction changes the JSON through a typed domain command

- Dragging `node-title` on the canvas dispatches one typed domain command
  (**Proposed** name: `SetNodePosition`) on the command bus of
  `@kadrion/editor-sdk`. The UI never mutates renderer internals or the DOM
  produced by the runtime.
- Applying the command yields a new document that validates against the schema;
  the Player re-renders from that document.
- Undo applies one inverse patch and restores a document identical to the
  original; redo restores the edited one.
- Evidence: unit tests for the command and its inverse, plus one browser test
  that performs the drag and asserts on the resulting document.

### P4 — An AI-shaped tool call performs an equivalent command

- `@kadrion/ai-sdk` exposes a tool contract (name, description, JSON Schema for
  the arguments) built on the same editor-sdk command.
- A fixture tool call with the same parameters as the P3 interaction produces a
  document whose serialised JSON is byte-identical to the P3 result.
- Invalid arguments are rejected with a typed error and leave the document
  untouched.
- No model is called; the spike uses fixture payloads only.
- Evidence: equivalence test between the UI-issued command and the tool call.

### P5 — The Producer exports an H.264 MP4 without storing all intermediate frames

- The MP4 is verified structurally with `ffprobe`: H.264 video, `yuv420p`,
  expected dimensions, 30/1 frame rate, 300 frames, and an audio stream. Pixel
  comparisons use the pre-encode frames of P2, never the encoded video.
- Streaming is measurable: no frame files appear on disk during a render, the
  number of frames in flight is bounded by a constant, and peak memory does not
  grow with the number of frames rendered.
- Both D07 presets are produced (see Q2 for their meaning in portrait).
- Evidence: an automated export test in the pinned environment with the
  `ffprobe` assertions. Generated media stays out of Git.

### 5.1 Invariant traceability

Every non-negotiable invariant of `AGENTS.md` maps to at least one criterion.

| Invariant                                                                      | Acceptance criterion                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The versioned composition document is the only source of rendering truth       | P1, P3: every render starts from a validated document; the UI changes pixels only by producing a new document. PR-02: the runtime accepts a `ValidatedComposition` only (Q17, D19) |
| Runtime state for a frame is derived from `(composition, timeUs)`              | §6.1 repeatability and order independence; for the evaluation core, `packages/runtime/test/determinism.test.ts`                                                                    |
| No dependence on `Date.now()`, timers, playback history, UI state, frame count | §6.1 clock independence, plus the determinism lint guardrail (`tests/repo/lint-guardrails.test.ts`)                                                                                |
| Assets, fonts, randomness, and runtime versions are explicit or pinned         | §8 render manifest records runtime build hash and Chromium, FFmpeg, font, and schema versions                                                                                      |
| Missing required assets are errors, not silent fallbacks                       | P1 and §8: a missing asset or font is a typed error in both hosts, raised before the first frame                                                                                   |
| Player and Producer execute the same runtime build                             | P2: byte-identical artifact; its hash is in the render manifest                                                                                                                    |
| The Producer is the reference output; browser preview parity is measured       | §6.2 parity report                                                                                                                                                                 |
| UI and AI use the same command bus                                             | P3, P4: byte-identical JSON from both paths; the result re-validates and is undone by one inverse patch                                                                            |
| Stable IDs for scenes, nodes, clips, animations, and assets                    | PR-01: IDs are required and unique; commands address nodes by ID                                                                                                                   |
| Structured nodes are the default path for Taskio and AI                        | The fixture uses structured nodes for everything except the single Custom HTML element; the P4 tool targets a structured node                                                      |
| Custom HTML never receives host secrets or privileged host APIs                | §7 negative tests                                                                                                                                                                  |
| Unknown or unsupported fields produce a clear error or explicit warning        | PR-01: an unknown field or an unsupported schema version is an error                                                                                                               |

## 6. Determinism and parity

### 6.1 Determinism of the reference output

In the pinned environment (pinned Chromium, fonts, runtime build):

- **Repeatability**: rendering the same golden timestamp at least three times,
  each in a fresh page, yields identical pixel data.
- **Order independence**: rendering the golden timestamps in ascending,
  descending, and shuffled order yields identical frames per timestamp.
- **Clock independence** (Proposed): the runtime renders correctly when
  `Date.now`, `performance.now`, timers, and `requestAnimationFrame` are
  replaced with functions that throw inside the runtime's realm. PR-02 checks
  this for the evaluation core in Node
  (`packages/runtime/test/determinism.test.ts`); the check inside the page
  follows with the renderer.
- **Lint guardrail** (binding): the pull request that adds the first runtime
  code also adds a lint rule set that rejects `Date`, `Math.random`, timers,
  `requestAnimationFrame`, and `performance.now` in runtime animation logic,
  together with a test that feeds violating source text to the linter and
  asserts the rejection. The dynamic checks above remain the stronger guard.
  - Landed with PR-02: `eslint.config.js` restricts `packages/runtime/src` and
    `tests/repo/lint-guardrails.test.ts` runs the real configuration over
    violating text. Beyond the binding list it rejects `Temporal`,
    `requestIdleCallback`, the `clear*` and `cancel*` counterparts,
    `crypto.getRandomValues`, `crypto.randomUUID`, and the same globals reached
    through `globalThis`, `window`, `self`, or `global`. Inline configuration is
    switched off for these sources, so an `eslint-disable` comment cannot
    silence the guardrail and is itself reported. The ban does not apply to
    other packages: the Producer may wait on a wall clock (§7).
  - The two guards complement each other. The static rules also see code that
    no test exercises and references captured when a module loads; the dynamic
    check also sees what hides behind an alias. The members `random`, `now`,
    `hrtime`, `timeOrigin`, `getRandomValues`, and `randomUUID` are banned on
    any object, which closes the plain alias (`const m = Math`). Still out of
    reach of the static guard: `Reflect.get`, computed member names, and clock
    reads that need no banned name, such as
    `new Intl.DateTimeFormat().format()`. TypeScript currently rejects timers,
    `performance`, and `requestAnimationFrame` in the runtime sources as well,
    because that project has neither DOM nor Node.js types; that layer ends if
    the renderer brings the DOM library into the package.
  - Open for PR-03 (Q15): this document binds "runtime animation logic", while
    the configuration binds every source of `@kadrion/runtime` and allows no
    inline exception. If the renderer and the Custom HTML mount land in that
    package, either the ban narrows to an evaluation subtree, or code such as the
    bounded acknowledgement wait of §7 receives its timer from the host.

If byte-identical output turns out to be unachievable, that is a spike finding:
record the measured variance and propose an ADR defining the tolerance.

### 6.2 Parity between browser preview and Producer

The Producer is the reference output; browser preview parity is **measured**.

- What is compared: for each golden timestamp, the frame shown by the Player
  after `seek(timeUs)` against the Producer's golden frame, at the same pixel
  dimensions.
- Metric (Proposed): the share of pixels that differ and the maximum
  per-channel difference.
- Thresholds are set after the first measurements and recorded in an ADR (Q9);
  this document deliberately does not invent them.

### 6.3 Golden frame policy (Proposed)

- Golden frames are produced only by the Producer in the pinned environment,
  never from a developer's everyday browser.
- They live in `@kadrion/test-fixtures`. Updating them is an explicit command,
  and the image diff is reviewed like code.

## 7. Custom HTML sandbox requirements

From D05 and the invariants. The mechanism is confirmed by the implementing
pull request (**Proposed**: a sandboxed `iframe` with an opaque origin, inline
content, a restrictive Content Security Policy, and a message-based protocol).

1. The element runs in an isolated browsing context. It cannot reach the host
   page, the rest of the composition, or another Custom HTML element.
2. It never receives host secrets or privileged host APIs. Capabilities default
   to none, and any granted capability is explicit in the document.
3. In the spike it has no network access; its content comes from the document
   or from declared assets.
4. Time contract: the host pushes `timeUs`, the element renders for that time
   and acknowledges it, and frame capture waits for the acknowledgement. A
   missing acknowledgement within a bounded wait is an error, not a silently
   captured stale frame. (A wall-clock wait in the orchestration layer is
   acceptable because it can only fail a render; it can never change pixels.)
5. Behaviour is identical in the Player and the Producer because both run the
   same runtime build.
6. Negative tests prove that, from inside the element, access to the parent
   document, network requests, and storage all fail.

## 8. Producer requirements

- Pinned Chromium and pinned FFmpeg.
- `seek(timeUs)` resolves only when the frame is completely rendered: fonts
  loaded, images decoded, Custom HTML acknowledged.
- All required assets are resolved before the first frame; a missing asset
  aborts the render with a typed error.
- Frames go to FFmpeg through a pipe with backpressure. No per-frame files.
- Output: H.264 in MP4, `yuv420p`, constant 30 fps, audio muxed from
  `clip-audio`.
- Every render writes a **render manifest**: composition hash, runtime build
  hash, schema version, Chromium version, FFmpeg version, font identities,
  preset, frame count, and duration. This is what makes "pinned" observable.

## 9. Editing requirements

- UI and AI use the same command bus. A command is typed, serialisable, and
  validated before it is applied.
- Applying a command produces a new document plus the inverse patch that undo
  needs. Commands are pure with respect to the document: the same document and
  command always give the same result.
- The spike needs exactly one command end to end. More commands are out of
  scope until the five proofs hold.
- The AI tool contract is derived from the command definition so that the two
  cannot drift apart.

## 10. Proposed PR sequence

Each PR is one small, reviewable slice with tests at its own abstraction level.
The sequence is a proposal; reorder it when evidence says so.

| PR    | Slice                                                                                                                                                                                                                                                | Packages                             | Serves |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------ |
| PR-00 | Monorepo foundation, ADRs D01–D10, this specification                                                                                                                                                                                                | repository root                      | —      |
| PR-01 | The reference composition fixture, then schema `0.x` (JSON Schema, types, validation) that accepts it and nothing beyond it; the frame grid (D13)                                                                                                    | `test-fixtures`, `schema`            | P1     |
| PR-02 | The hand-derived expected state, then the deterministic evaluation core: `(composition, timeUs)` to node state, linear interpolation (D18, D19); the determinism lint guardrail (§6.1); the validated-document brand (Q17). DOM-free, tested in Node | `test-fixtures`, `runtime`, `schema` | P1, P2 |
| PR-03 | DOM/SVG renderer, the single runtime build artifact                                                                                                                                                                                                  | see Q15                              | P1, P2 |
| PR-04 | Sandboxed Custom HTML element                                                                                                                                                                                                                        | see Q15                              | P1, P2 |
| PR-05 | Player host (load, play, pause, seek) and a minimal playground                                                                                                                                                                                       | `player`, `apps/playground`          | P1     |
| PR-06 | Producer frame capture in pinned Chromium, golden frames, CLI entry point, CI in the pinned environment                                                                                                                                              | `producer`, `cli`, `test-fixtures`   | P2     |
| PR-07 | MP4 export by streaming frames to pinned FFmpeg, audio mux                                                                                                                                                                                           | `producer`, `cli`                    | P5     |
| PR-08 | Command bus, one command, undo/redo, canvas drag in the playground                                                                                                                                                                                   | `editor-sdk`, `apps/playground`      | P3     |
| PR-09 | AI tool contract for the same command and the equivalence test                                                                                                                                                                                       | `ai-sdk`                             | P4     |
| PR-10 | Parity measurement, spike report, ADR proposals                                                                                                                                                                                                      | `test-fixtures`, `docs`              | exit   |

## 11. Open questions

This document decides none of these. Rows marked **Decided** or **Answered**
say where the answer lives; every other row is still open. "Owner" names the
pull request that cannot land without an answer. Questions marked **ADR** constrain later work,
so their answer is recorded as an ADR before dependent code lands.

| #   | Question                                                                                              | Why it matters                                                                                                                                    | Proposed direction                                                                                                                                                                                                   | Owner                            | ADR |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --- |
| Q1  | Which frame/time rule applies in both directions, and is `fps` an integer or a rational `{num, den}`? | 1/30 s is not a whole number of µs; Player and Producer must agree exactly                                                                        | The §4 pair of formulas; integer fps unless 29.97-style rates are needed soon. **Decided by D13** (accepted 2026-09-21)                                                                                              | PR-01                            | yes |
| Q2  | What do "720p" and "1080p" (D07) mean for a portrait 1080x1920 composition, and how is 720p produced? | Decides output dimensions and the number of golden frame sets                                                                                     | Preset names the short side (1080x1920, 720x1280). Try rendering once at 1080x1920 and downscaling in FFmpeg first: a 2/3 device scale factor changes text rasterisation and doubles the goldens                     | PR-07                            | yes |
| Q3  | How is Chromium pinned, and which capture method is deterministic?                                    | P2 depends on it; the development machine runs Windows                                                                                            | Compare automation-bundled Chromium with Chrome for Testing, inside a pinned Linux container                                                                                                                         | PR-06                            | yes |
| Q4  | How is FFmpeg sourced, pinned, and licensed?                                                          | It is not installed on the development machine; H.264 encoder licences matter for D10                                                             | Pinned container image or checksum-pinned static build, with a written licence analysis                                                                                                                              | PR-07                            | yes |
| Q5  | How are fonts pinned and text rendering stabilised?                                                   | Text is the most environment-sensitive part of DOM rendering                                                                                      | Font as explicit asset, wait for font readiness, golden frames only from the pinned environment                                                                                                                      | PR-06                            | yes |
| Q6  | How does the document reference and pin assets (content hash, URL scheme, resolver interface)?        | "Explicit or pinned" must be verifiable; hosts store assets, Kadrion does not                                                                     | Asset entries carry a content hash; resolution goes through a host-provided resolver. **Decided by D14** (accepted 2026-09-21)                                                                                       | PR-01                            | yes |
| Q7  | Is audio only muxed in the spike, and is bit-exact audio required?                                    | Keeps P5 small                                                                                                                                    | Mux only; verify presence, duration, and sync                                                                                                                                                                        | PR-07                            | no  |
| Q8  | Do golden frames need Git LFS?                                                                        | "Keep … large fixtures out of Git"                                                                                                                | Five PNGs do not; revisit when fixtures grow                                                                                                                                                                         | PR-06                            | no  |
| Q9  | Which parity thresholds apply?                                                                        | Parity must be measured first and gated later                                                                                                     | Measure, then fix thresholds                                                                                                                                                                                         | PR-10                            | yes |
| Q10 | Which spatial units and numeric types does the schema use (are fractional pixels allowed)?            | D04 constrains time only                                                                                                                          | Composition pixels; decide on fractional values with the schema. **Decided by D15** (accepted 2026-09-21)                                                                                                            | PR-01                            | yes |
| Q11 | Which interpolation modes exist in `0.x`?                                                             | "Only fields required by the reference spike"                                                                                                     | Linear only, as an explicit `interpolation` field with one allowed value. **Decided by D16** (accepted 2026-09-21)                                                                                                   | PR-01                            | no  |
| Q12 | How is the single runtime build produced, addressed by hash, and loaded by both Player and Producer?  | Invariant: Player and Producer execute the same runtime build                                                                                     | One bundled artifact with a content hash; bundler chosen in the implementing PR                                                                                                                                      | PR-03                            | yes |
| Q13 | Where does Custom HTML content live (inline string in the document or an asset)?                      | Affects the schema and sandbox loading                                                                                                            | Inline for the spike. **Decided by D16** (accepted 2026-09-21)                                                                                                                                                       | PR-01                            | no  |
| Q14 | Which CI environment runs the checks, and does it double as the pinned render environment?            | CI was deferred from PR-00 because a workflow cannot be verified before the first push                                                            | Plain CI for `check` right after the first push; the pinned container joins with PR-06. **Carried forward by PR-01**: nothing has been pushed yet, so a workflow still cannot be verified                            | first push, PR-06                | no  |
| Q15 | Which package owns the DOM/SVG renderer and the Custom HTML sandbox mount?                            | `AGENTS.md` assigns neither to a package; shared mount code may not move sideways between Player and Producer (D12)                               | `runtime`, unless evidence demands a ninth package, which requires an ADR and a change to `AGENTS.md`                                                                                                                | PR-03                            | yes |
| Q16 | How do later pull requests change schema `0.1` when every new field is a breaking change?             | D16 closes every object and requires every field; `AGENTS.md` demands forward migrations for breaking changes; PR-01 ships no migration framework | Bump `schemaVersion` with every change and write one plain forward-migration function per step; first decide whether the spike ever has to read an old document                                                      | first PR that changes the schema | yes |
| Q17 | Does `validateComposition` return a branded type?                                                     | Only a brand lets the type system enforce that every render starts from a validated document                                                      | **Answered by the project owner on 2026-09-21: yes.** `validateComposition` returns `ValidatedComposition`, the only document type that `@kadrion/runtime` accepts. The brand is static only; D19 records its limits | PR-02                            | no  |

## 12. Exit criteria

- Evidence for P1–P5 exists in the repository and passes in the pinned
  environment.
- The parity numbers of §6.2 are reported.
- Every open question is either answered (by an ADR where marked) or explicitly
  carried forward with a reason.
- A short spike report states what held, what has to change (as ADR proposals),
  and what the next phase should be.
