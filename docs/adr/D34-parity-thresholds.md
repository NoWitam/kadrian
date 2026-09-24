# D34 — Parity thresholds from the first measurement

- Status: Accepted — by the project owner on 2026-09-23, without a change of substance
- Date: 2026-09-23
- Supersedes: —
- Related: D26, D28, D33,
  [specification](../spike/vertical-spike.md) §6.2 and open question Q9,
  [spike report](../spike/report.md) §3

## Context

Q9 asks which parity thresholds apply. It requires "Measure, then fix
thresholds", and the project owner decided that PR-10 sets no threshold and
enables no gate: this ADR proposes thresholds from the real numbers, and they
become a CI gate only after the owner accepts it.

The measurement of D33 in PR-10 produced these numbers
(`docs/spike/parity-measurement.json`, report §3):

- **Pinned environment** (the container of D26.2, `--network none`, Chromium
  `153.0.8010.12`): the public Player against the committed golden frames at
  all five golden timestamps:
  - 0 differing pixels out of 2 073 600;
  - maximum channel difference 0;
  - the SHA-256 of every Player PNG equals the golden PNG's;
  - the record of the second `test:pinned` pass of the same reference run
    (`/out/kadrion-out-1/parity/parity-measurement.json`), against the frames
    that `goldens:update` had just rewritten byte-identically, shows the same
    zeros and the same PNG hashes. It was read by hand, not gated.
- **Development machine, informative only** (Windows, the same Playwright
  Chromium version, D33.9): between 27 031 and 51 769 differing pixels (1.30 %
  to 2.50 %), maximum channel difference 114. Of the differing pixels, 81.9 %
  to 89.5 % differ by 15 or less and 491 to 885 by 64 or more (the histograms
  are in report §3). In the same Windows run the Player and the Producer
  differed in zero pixels (the D28.5 gate). The difference therefore comes from
  the environment (operating system, font rasterisation, graphics backend),
  not from the two hosts.

The pinned zero is not an independent discovery. It follows from two gates that
already hold in that environment: the Player equals the Producer of the same
run (D28.5), and the Producer equals the committed golden frames (D26.5). The
measurement confirms that the public Player, in the conformance host, closes
that chain.

What the numbers show:

- Within one pinned environment there is no noise to tolerate.
- Across environments the difference is large, and it varies from frame to
  frame (it is largest at 9 900 000 µs). One data point from one machine is not
  a basis for a tolerance.

## Decision

**34.1 Reference parity: exact.** In the pinned environment, the Player's
frame of a golden timestamp must equal the committed golden frame:

- `differingPixels === 0` in every row;
- therefore `maxChannelDifference === 0` in every row.

This is a threshold of zero, not a tolerance. Any difference there is a
regression of the runtime build, the Player, the embedding, or the environment
pins, and it is reviewed like a golden-frame change.

**34.2 Cross-environment preview parity: reported, not gated.** A Player in a
browser or on an operating system other than the pinned one is measured and
reported the D33 way, with its environment in the record, and gated by nothing.

A tolerance for previews in users' browsers needs measurements from more than
one such environment, for example Chrome stable on Windows, macOS, and Linux.
Collecting them is the next phase's work. The Windows numbers above are the
first reference point, not a limit.

**34.3 How the gate lands after acceptance.**

- `tests/pinned/parity.pinned.test.ts` asserts 34.1 on its rows when the
  environment is pinned. Elsewhere it stays informative.
- The record becomes `recordVersion` 2. `thresholds` names 34.1
  (`{ "differingPixels": 0, "maxChannelDifference": 0 }`) and `gate` is `true`.
- `recordProblems` checks that every row of a pinned record meets the
  thresholds.
- The CI job of D26.6, which runs `test:pinned` in the container, is meant to
  enforce the gate from then on. That job has never run (Q14, still open), so
  until it has, the gate holds only in the local reference run of
  `pinned-run.sh`.

**34.4 Changing a threshold** takes a new ADR with the measurements that justify
it. It never happens by editing a number in a test.

## Alternatives considered

- **A small tolerance in the pinned environment**, for example 0.01 % of the
  pixels (207 pixels). No measured noise justifies it, and it would hide real
  regressions: the Custom HTML progress bar is 40 pixels high, so a bar one
  pixel too long or too short changes 40 pixels and would pass.
- **One threshold for every environment, taken from the Windows numbers.** A
  3 % tolerance would make the pinned gate meaningless. It would also be
  derived from a single machine.
- **A per-channel limit only.** A limit on the maximum channel difference
  misses a shift that moves many pixels by a small amount. A limit on the share
  of pixels misses a single strongly wrong pixel. 34.1 bounds both.
- **Perceptual metrics (SSIM, PSNR).** They are useful for the encoded MP4
  (D29 reports PSNR), but §6.2 compares the pre-encode frames, where exact
  equality is attainable and was measured.

## Consequences

- Once accepted, any change that alters pixels in the pinned environment fails
  `test:pinned` until `goldens:update` has been run and the new golden frames
  reviewed. That is already the rule for the Producer (D26.5).
- The committed parity record must be renewed together with the golden frames
  (D33.6).
- Nothing changes before acceptance: PR-10 records `thresholds: null` and
  `gate: false`.

## Implementation notes (PR-11)

These are the owner's decisions of 2026-09-23. They implement 34.3 without
changing 34.1–34.4.

- **Pixels, not bytes.** The threshold applies to decoded pixels. Two PNGs with
  different metadata or compression and identical pixel arrays meet it.
  `playerPng === goldenPng` is never required.
- **When the gate applies.** `gate: true` only for a measurement in the pinned
  environment whose pixel-relevant environment equals the golden frames'
  environment. Such a record carries `thresholds` equal to 34.1. A report-only
  record carries `thresholds: null`. A cross-environment record may never
  claim the gate.
- **Three cases.** A run with `KADRION_PINNED_IMAGE` set is gated. The
  variable must name the pinned reference, and the environment must be the
  golden frames' environment, or the run fails. It never falls back to a
  report. Only a run without the variable reports.
- **A failed record under its own name.** A record that fails its checks is
  written as `parity-measurement.failed.json`, never under the name of a good
  record that `pinned-run.sh` and CI copy out.
- **No automatic goldens.** A failing gate never updates golden frames.
  `pinned-run.sh reference` runs its first `test:pinned` before
  `goldens:update`, under `set -e` and `pipefail`. CI never runs
  `goldens:update`.

## Verification

- `tests/parity/parity.test.ts`: the thresholds as a literal, every rejection
  of `recordProblems`, and identical pixels behind different PNG bytes.
- `tests/pinned/parity.pinned.test.ts`: zero and zero per row in the gated
  case, and the three cases above.
- `tests/repo/parity-record.test.ts`: the committed record is a gated
  version-2 record of the reference run and is current with the build.
- `tests/repo/pinned-environment.test.ts`: the order in `pinned-run.sh` and
  the workflow's commands.
- The CI job of D26.6 has **not** run yet (Q14).
