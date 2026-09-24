# Vertical spike report

- Date: 2026-09-23 (PR-10)
- Scope: the vertical spike of [`vertical-spike.md`](vertical-spike.md), PR-00 to
  PR-10
- Exit criteria: §12 of the specification

## 1. Summary

Each of the five proofs has evidence in the repository, and P1, P2, P3, and P5
have passed in the pinned environment:

- **P1:** a versioned JSON composition plays in the browser Player.
- **P2:** the byte-identical runtime build renders it in pinned Chromium.
- **P3:** a canvas drag and undo/redo go through one typed command bus.
- **P4:** an AI-shaped tool call dispatches on that same bus and produces
  byte-identical JSON.
- **P5:** the Producer streams H.264 MP4 in both presets.

The environment is the Playwright image of D26 by digest, run with
`--network none` (D28.9).

Parity between the Player and the Producer is **measured** (§6.2, D33). Since
PR-11 it is **gated** in the pinned environment (D34, accepted 2026-09-23): 0
differing pixels and a channel difference of 0 against the committed golden
frames. Parity between environments is only reported.

The spike did not need to change schema `0.1`, and no Accepted decision had to
be bypassed.

## 2. Evidence of the five proofs

| Proof | Evidence                                                                                                                                                                                                            | Decisions           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| P1    | `tests/pinned/player.pinned.test.ts`: five golden seeks; the same pixels after a fresh load, after play and pause, and after a seek back; runtime hash; device pixel ratio 1; fixture font only.                    | D25, D27 (Accepted) |
| P2    | Golden frames in `packages/test-fixtures/src/golden-frames/`, written twice in fresh containers with identical SHA-256; `tests/pinned/producer.pinned.test.ts`: repeatability, order and clock independence.        | D26, D28 (Accepted) |
| P3    | `packages/editor-sdk/test/`, `tests/app/playground-drag.test.ts`, and `tests/pinned/editor.pinned.test.ts`: a drag at two preview scales changes the document by the right delta; undo brings back the first frame. | D30 (Accepted)      |
| P4    | `tests/app/ai-equivalence.test.ts`: the committed tool call gives a document byte-identical to the one the drag gives; refused arguments leave document and history untouched.                                      | D31 (Accepted)      |
| P5    | `tests/pinned/export.pinned.test.ts` and `kadrion export` in a read-only container: both presets verified structurally by `ffprobe`, with frames streamed and memory bounded.                                       | D29 (Accepted)      |
| §6.2  | `tests/pinned/parity.pinned.test.ts`, the record `docs/spike/parity-measurement.json`, and section 3 below.                                                                                                         | D33, D34 (Proposed) |

## 3. Parity between the Player and the Producer (§6.2, Q9)

### What was measured

The method is [D33](../adr/D33-parity-measurement.md) (Proposed). For each
golden timestamp, the measurement compares two frames:

- the frame that the **public, built `@kadrion/player`** shows after
  `seek(timeUs)`, in a minimal conformance host (`tests/pinned/conformance-host.ts`);
- the **committed golden frame** of the Producer.

The capture is at 1080x1920 and device pixel ratio 1. Nothing is scaled,
cropped, or resampled, and a frame of any other size is refused.

The measurement concerns the Player as an artifact, not the look of the
playground application. The playground's `scale(0.35)` and its drag overlay
belong to the application that hosts the Player (D25.2), and they are not part
of what the Player renders. No 0.35 measurement was made.

Every row is bound to the following. A mismatch in any of them makes the
comparison refuse the row rather than produce a number:

- the runtime build the Player verified;
- the document text the host received, hashed the Producer's way;
- the time the Player confirmed;
- the golden file and its SHA-256.

On every golden row, the hand-derived DOM tree corroborates what was rendered
and when, wherever that tree differs between neighbouring frames.

A preflight runs before every capture and fails the measurement unless all of
these hold:

- device pixel ratio 1;
- a surface of exactly 1080x1920 at the origin;
- no transform, zoom, or pixel effect on any ancestor;
- only the reset style sheet;
- nothing selected or focused;
- fonts and images ready;
- the hand-derived DOM tree of that time.

The premise was proven first (D33.7). Each of these cases gives a non-zero
difference:

- a Player frame one grid step later;
- a Player frame of another golden timestamp;
- a golden frame shifted by one pixel column;
- a document that moves one node.

The Player frames go through the same capture function as the rows. The
shifted golden frame is pixels only.

### Environment of the recorded measurement

- Image: `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27` (linux/amd64), run with `--network none` (interfaces: lo; loopback only: true).
- Chromium: Playwright `1.63.0`, revision `1243`, reported version `153.0.8010.12`, channel `chromium`, arguments `--force-color-profile=srgb --disable-lcd-text --hide-scrollbars --mute-audio`.
- Context: viewport {"width":1080,"height":1920}, device scale factor 1, locale `en-US`, time zone `UTC`; Node `v24.20.0`.
- Runtime build: `sha256:b54743b4716562de078a04a42367508fd554130c53af4c190a43d498962d5115`.
- Document (composition hash): `sha256:fa3c3c3051acb473d8941c2286ea69df935ae6ee5d502ceeeebb9eeacabf0312`.
- Player dist tree (D33.10): `sha256:b3b6e61e4686427af9c6a9d798c335c8e1152132900e0fda6410416e9d4303a4`, 28 files, the manifest in the record.
- Golden manifest: `packages/test-fixtures/src/golden-frames/reference.golden-frames.json`, `sha256:6e4dc3973665fce575d7bdd3fc922eb112d191885ab5321bd5a2fcae767ba997`.
- Record: version 2, `gate: true`, thresholds `{"differingPixels":0,"maxChannelDifference":0}` (D34.1).
- Source: the first `test:pinned` pass of `pinned-run.sh reference` (PR-11), copied out before `goldens:update` (D33.6). The environment equals the golden frames' environment on every field that affects pixels, and the record is current with the build (checked by `check`).

### Numbers

Measured against the committed golden frames:

<!-- parity-table:start -->

| `timeUs` | Frame | Differing pixels |    Share | Max channel difference | Histogram 0 / 1 / 2-3 / 4-7 / 8-15 / 16-31 / 32-63 / 64-127 / 128-255 |
| :------- | ----: | ---------------: | -------: | ---------------------: | --------------------------------------------------------------------: |
| 0        |     0 |      0 / 2073600 | 0.0000 % |                      0 |                               2073600 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 |
| 2500000  |    75 |      0 / 2073600 | 0.0000 % |                      0 |                               2073600 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 |
| 5000000  |   150 |      0 / 2073600 | 0.0000 % |                      0 |                               2073600 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 |
| 7500000  |   225 |      0 / 2073600 | 0.0000 % |                      0 |                               2073600 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 |
| 9900000  |   297 |      0 / 2073600 | 0.0000 % |                      0 |                               2073600 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 |

<!-- parity-table:end -->

Worst case: 0 differing pixels (at 0 µs), share 0.0000 % (at 0 µs), maximum channel difference 0 (at 0 µs).

In every row the SHA-256 of the Player's PNG equals that of the golden PNG: in the pinned
environment the public Player produced the golden frames byte for byte.

Since PR-11 these numbers **are a gate** in the pinned environment:
[D34](../adr/D34-parity-thresholds.md) (accepted 2026-09-23) sets the
thresholds of D34.1, and the record carries them with `gate: true`. The gate
compares decoded pixels, not PNG bytes. A run that claims the pinned image
(`KADRION_PINNED_IMAGE`) in another environment fails; it never degrades to a
report. A failing gate never updates golden frames. In PR-10 the same
measurement was recorded without thresholds, as version 1.

Two assertions that are not thresholds are unchanged, and both passed:

- the equality gate of D28.5: the Player and the Producer in the same run and
  the same browser binary differ in zero pixels;
- the golden-frame equality of the Producer (D26.5).

**Informative only, not evidence (D33.9):** the same test on the Windows development machine
(`win32`/`x64`, Playwright Chromium `153.0.8010.12`, not the container)
measured its Player against the same committed golden frames, which a Linux container rendered.
This is a difference between environments, not between the two hosts: in the same Windows run the
D28.5 gate still found zero differing pixels between the Player and the Producer.

| `timeUs` | Differing pixels |    Share | Max channel difference | Histogram 0 / 1 / 2-3 / 4-7 / 8-15 / 16-31 / 32-63 / 64-127 / 128-255 |
| :------- | ---------------: | -------: | ---------------------: | --------------------------------------------------------------------: |
| 0        |  27033 / 2073600 | 1.3037 % |                    114 |           2046567 / 4135 / 6240 / 4951 / 8001 / 1523 / 1692 / 491 / 0 |
| 2500000  |  27031 / 2073600 | 1.3036 % |                    114 |           2046569 / 3781 / 5759 / 5375 / 7235 / 2302 / 2088 / 491 / 0 |
| 5000000  |  35457 / 2073600 | 1.7099 % |                    114 |          2038143 / 3295 / 6689 / 9356 / 11410 / 1196 / 3019 / 492 / 0 |
| 7500000  |  43422 / 2073600 | 2.0940 % |                    114 |         2030178 / 3936 / 9336 / 12003 / 13085 / 1309 / 2868 / 885 / 0 |
| 9900000  |  51769 / 2073600 | 2.4966 % |                    114 |         2021831 / 8123 / 7949 / 13934 / 16303 / 1707 / 2868 / 885 / 0 |

## 4. What held

- **One source of truth.** Every frame in both hosts is derived from
  `(validated document, timeUs)`. Seeks after play, after seeking back, and in
  shuffled order gave identical pixels.
- **The same runtime build in both hosts.** A single esbuild artifact addressed
  by SHA-256 (D21) is verified by the Player and by the Producer. Every parity
  row carries the hash the Player verified, and the comparison refuses a row
  whose hash differs from the golden manifest's.
- **Determinism.** The page clocks were replaced by throwing functions, and the
  frames stayed pixel-identical. Golden frames reproduced in a fresh container.
- **Pinned environment.** The Playwright image is pinned by digest, Chromium by
  revision, FFmpeg by SHA-256, and fonts come from asset bytes. The reference
  run has no network.
- **One command bus for the UI and the AI (D30, D31).** The drag and the tool
  call produce byte-identical documents and share one history. Since PR-10 the
  bus is a frozen facade (D30.13).
- **Custom HTML isolation.** It runs in a sandbox with an opaque origin and a
  policy that blocks network and storage. Self-navigation is refused by the
  page policy in both hosts (D28 measurements).
- **Streaming export.** Frames stream from the Producer to FFmpeg; none are
  stored on disk, and memory stays bounded.

## 5. What has to change (ADR proposals)

Proposed in PR-10 and **accepted by the project owner on 2026-09-23**:

- [D33](../adr/D33-parity-measurement.md): the parity measurement method, its
  bindings, and its record. It was amended in PR-11 at the owner's request by
  33.10, the Player's dist tree in the record.
- [D34](../adr/D34-parity-thresholds.md): parity thresholds from the measured
  numbers, gated in the pinned environment since PR-11.
- [D35](../adr/D35-schema-migration-policy.md): the schema migration policy
  (Q16), with the owner's refinements. It is in force from 2026-09-23.

Still open:

- **Still Proposed from earlier:** [D32](../adr/D32-playground-showcases.md)
  (playground showcases).
- **The process question of PR-10 is settled.** `docs/adr/README.md` now
  allows an additive amendment to an Accepted ADR on the owner's explicit
  instruction. Such an amendment carries an "Amended by" line, and a change of
  substance still needs a superseding ADR.
- **[D36](../adr/D36-webrtc-in-the-player.md), proposed in PR-12, accepted by
  the owner on 2026-09-24 with the corrections of PR-13:** WebRTC and the
  network isolation of Custom HTML in the Player. The reference run closes the
  channel by having no network (D28.9). A Player in a user's browser does not,
  so §7.3 is not met there. The evidence comes from the pinned Chromium only.
  The decision:
  - Custom HTML in the Player is a host opt-in;
  - the Player does not claim network isolation of untrusted Custom HTML;
  - untrusted Custom HTML is disabled by default in the interactive preview,
    and enabling it needs an explicit, documented decision of the host;
  - the Producer keeps `--network none`.

  The code of the policy comes in a separate pull request. Until then, the
  Player's behaviour is unchanged.

- **Not yet decided:** CI on a remote runner (Q14). See section 9.

## 6. D31 and the amendment D30.13

- **D31** (the AI tool contract `set_node_position`) was accepted by the project
  owner on 2026-09-23 without a change of substance.
- **D30.13** (an amendment at the owner's request): `createCommandBus()` returns
  a shallow `Object.freeze`d facade. No caller can replace, add, or delete a
  method of the bus it shares with the AI tool. The closure with the current
  document and the undo and redo stacks is not frozen, and neither behaviour
  nor signatures change. Five tests in `packages/editor-sdk/test/bus.test.ts`
  prove it, and the mutation table of PR-10 saw each of them fail.

## 7. Open questions of §11

| #   | Status after the spike                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Decided by D13                                                                                                                                                                    |
| Q2  | Answered, D29.5                                                                                                                                                                   |
| Q3  | Answered, D26 and D28                                                                                                                                                             |
| Q4  | Answered, D29.1–29.2                                                                                                                                                              |
| Q5  | Answered, D27                                                                                                                                                                     |
| Q6  | Decided by D14                                                                                                                                                                    |
| Q7  | Answered, D29.6                                                                                                                                                                   |
| Q8  | Answered by measurement: no LFS                                                                                                                                                   |
| Q9  | **Decided** by D33 and D34 (accepted 2026-09-23); gated in the pinned environment since PR-11                                                                                     |
| Q10 | Decided by D15                                                                                                                                                                    |
| Q11 | Decided by D16                                                                                                                                                                    |
| Q12 | Decided by D21                                                                                                                                                                    |
| Q13 | Decided by D16                                                                                                                                                                    |
| Q14 | **Open**: the workflow is prepared and checked locally (PR-11); the first push has not been made and the remote workflow has not run (PR-12, section 9); see docs/ci/first-run.md |
| Q15 | Decided by D20                                                                                                                                                                    |
| Q16 | **Decided** by D35 (accepted 2026-09-23, with the refinements of the owner); in force from then on                                                                                |
| Q17 | Answered: `ValidatedComposition`                                                                                                                                                  |

## 8. Recommended next phase

The first phase after the spike should keep the engine narrow and harden what
the spike proved, rather than widen it:

1. **Push and run CI (Q14).** The owner pushes the repository and runs the
   pinned workflow on a remote runner (docs/ci/first-run.md). This is the first
   evidence that the gates hold outside the development machine. PR-11 prepared
   the workflow and did not push, and PR-12 did not push either.
2. **Implement D36** (section 5): the host opt-in for Custom HTML in the
   Player, and no untrusted Custom HTML in the interactive preview by default.
   The decision was accepted on 2026-09-24, and its code comes in a pull
   request of its own.
3. **The first schema change under D35**, driven by the first real need of
   Taskio, together with the migration framework and the second editor command.
   D30.9's failing-undo test belongs with that command.

Taskio integration, a timeline UI, and a language model stay outside the next
phase until these hold.

## 9. CI status after PR-13 (Q14)

**Q14 is open.** On 2026-09-24:

- The first push has not been made. `HEAD` and `origin/main` are `0d7b40d`,
  and PR-02 to PR-13 are uncommitted local changes.
- The remote workflow has not run.
- No `kadrion-reports` artifact from CI exists.
- Local tests, including the pinned container runs, do not replace a run on a
  GitHub runner.

Nothing in this report reads or verifies a GitHub Actions result.

PR-13 prepared the evidence that the first run will produce:

- `.kadrion-out/vitest-pinned.json`, with its Kadrion-owned summary
  `pinned-test-summary.json`;
- `.kadrion-out/ci-identity.json`, the commit, run, workflow, image, FFmpeg,
  fonts, Player build, and runtime of the run, binding the other reports by
  hash.

It also prepared the validator that will check the evidence file of a real run.
It created no evidence file.

[docs/ci/first-run.md](../ci/first-run.md) lists the owner's eight criteria for
closing Q14 and the protocol for analysing a failing gate on the runner:

- what each comparison needs;
- where it is found in the artifact or in the job log;
- which items the identity or the summary adds;
- what is forbidden, namely raising thresholds, touching golden frames, gating
  a cross-environment record, and counting a red or partly skipped run as
  evidence.
