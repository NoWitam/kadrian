# The first CI run (Q14)

`.github/workflows/ci.yml` (D26.6) has **never run**. Q14 stays open until a run
on a remote GitHub runner has met every criterion below. A local run of the same
commands, including `tests/pinned/container/pinned-run.sh`, does **not** verify
CI.

## Status after PR-13 (2026-09-24)

**Status: Q14 is open.**

- The first push has not been made: `HEAD` and `origin/main` are still
  `0d7b40d`, and PR-02 to PR-13 are uncommitted local changes.
- The remote workflow has not run.
- No `kadrion-reports` artifact from CI exists.
- Local tests, including the pinned container runs, do not replace a run on a
  GitHub runner.

PR-13 prepared the evidence that a run will produce, and the validator that
will check it. It did not run the workflow, and it created no evidence.

## What was checked locally (PR-11 to PR-13)

`tests/repo/pinned-environment.test.ts` checks the following. It proves the
workflow is consistent, not that it works:

- **YAML.** The workflow parses with Prettier's YAML parser.
- **Image.** The container image is
  `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`:
  - it is pinned by its full digest;
  - its tag's version is the `playwright-core` version;
  - the job repeats it as `KADRION_PINNED_IMAGE`, so the parity gate of D34
    applies in CI.
  - The image contains git 2.43.0 and Node 24, which the evidence steps need
    (checked with `docker run` on 2026-09-24).
- **Actions.** Actions are pinned by full 40-hex commit SHAs. On 2026-09-23 the
  GitHub API showed that:
  - `actions/checkout` `v5.1.0` is commit `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`;
  - `actions/upload-artifact` `v4.6.2` is commit
    `ea165f8d65b6e75b540449e92b4886f43607fa02`.
- **Commands.**
  - Installation uses `--frozen-lockfile`.
  - Then `check`, `ffmpeg:fetch`, and `node --run test:pinned` run, in that
    order.
  - `test:pinned` is exactly
    `node --run build && vitest run --config vitest.pinned.config.ts`.
  - Its configuration writes the raw report `.kadrion-out/vitest-pinned.json`
    and allows no retry.
- **Evidence steps (PR-13).** These run in this order, after the pinned tests:
  - **Pinned test summary** writes `.kadrion-out/pinned-test-summary.json`
    (`tests/ci/write-pinned-summary.ts`).
  - **CI identity** writes `.kadrion-out/ci-identity.json`
    (`tests/ci/write-ci-identity.ts`). It comes last, because it binds the
    other reports by hash.
  - **Reports** publishes the artifact.

  Only these three steps carry an `if:`, and it is `always()`. A missing
  report fails the job as an evidence error, and the Reports step still
  publishes everything there is. The workflow contains no `||`, no `set +e`,
  and no `continue-on-error`.

- **FFmpeg.** Its paths use `$GITHUB_WORKSPACE`, the container's view of the
  workspace, and the release that `ffmpeg:fetch` writes.
- **Reports.** `.kadrion-out/` is uploaded with `include-hidden-files: true`,
  and a missing directory is a warning, not silence.
- **Golden frames.** CI never runs `goldens:update`.

## What the artifact will carry (PR-13)

- **`vitest-pinned.json`:** the raw report of Vitest's `json` reporter.
- **`pinned-test-summary.json`:** the Kadrion-owned summary of that run
  (`tests/ci/pinned-summary.ts`). It records:
  - the seven pinned test files, sorted, each with its status, load message,
    and counts;
  - the totals: passed, failed, skipped and pending, and todo;
  - the start time and the end of the last test;
  - `success`.
- **`ci-identity.json`:** a versioned contract (`tests/ci/ci-identity.ts`,
  `schemaVersion` 1). It records:
  - the run: event, ref, workflow ref and commit, repository, run ID, and
    attempt;
  - the commit, `GITHUB_SHA`, which must equal `git rev-parse HEAD`;
  - the SHA-256 of the workflow file, both in the checkout and in the commit;
  - the runner's OS and architecture, and the declared pinned image;
  - FFmpeg as observed: `ffmpegSha256`, `ffprobeSha256`, their version lines,
    and the required encoders found by `ffmpeg -encoders`;
  - every font: `expectedSha256` from the document, `actualSha256` of the
    bytes the golden test actually served, and `fontVerificationPassed`;
  - `playerDistTreeSha256` and `runtimeArtifactSha256`;
  - the SHA-256 of every other report it binds.

  It reads the environment only by the exact names of a fixed list, and never
  writes the environment itself. If a field is missing or a hash differs, it
  writes nothing and fails.

- **`golden-comparison.json`:** the Producer's frames against the golden
  frames, and the hashes of the assets it served. If the golden gate fails, the
  file is written as `golden-comparison.failed.json` instead.
- **`export-report.json`:** now also records whether the export ran pinned,
  whether it compared the golden frames to the end, and which FFmpeg it
  verified and used.
- **`parity/parity-measurement.json`:** the gated parity record. If it fails,
  it is written as `parity-measurement.failed.json` instead.

The identity is auxiliary evidence. Closing Q14 still compares the run URL,
`head_sha`, attempt, event, and conclusion with the metadata of GitHub Actions
itself.

## The first push (the owner)

1. Review the local changes of PR-02 to PR-13 and commit them yourself. Nothing
   in this repository commits or pushes on its own.
2. Push to `origin` (`github.com/NoWitam/kadrian`). A branch plus a pull
   request runs the workflow twice (`push` and `pull_request`). A push to
   `main` runs it once.
3. Allow GitHub Actions for the repository if it asks. The job needs no secret.

## When Q14 may close (owner, 2026-09-24)

Q14 closes only when **all** of the following exist. In every other case it
stays open.

1. The URL of the GitHub Actions run.
2. The SHA of a commit that matches the run and the reviewed code.
3. A green result for every required step, with no gate skipped.
4. The `kadrion-reports` artifact, downloaded and verified.
5. A pinned parity record with `gate: true`.
6. `thresholds` equal to `{ "differingPixels": 0, "maxChannelDifference": 0 }`.
7. Every measured frame with 0 differing pixels and `maxChannelDifference` 0.
8. The golden-frame gate of D26.5 passed too.

A workflow marked "success" is not enough if the pinned tests, the parity
measurement, or the artifact upload were skipped.

Closing Q14 means writing `docs/ci/q14-evidence.json` from the real run and
artifact. `tests/repo/q14.test.ts` refuses any statement that Q14 is closed
unless that file passes `q14EvidenceProblems` (`tests/repo/q14-evidence.ts`).
The file holds:

- **The run, from the GitHub API.** Event, URL, `head_sha`, conclusion,
  attempt, `run_started_at`, and `updated_at`.
- **The job and its steps.** The job `pinned` of that attempt and its
  conclusion, and every step of the workflow, each `success`, none skipped.
- **The artifact.** Its name `kadrion-reports`, API id and digest, the SHA-256
  of the downloaded zip, and every file with its SHA-256.
- **The contents.** The verbatim texts of `ci-identity.json`,
  `vitest-pinned.json`, `pinned-test-summary.json`, `golden-comparison.json`,
  `parity/parity-measurement.json`, and `export-report.json`.

The machine checks, per criterion:

- **(1), (2) — the run and the commit.**
  - Only a `push` run counts: a `pull_request` run checks out a merge commit,
    not the reviewed one.
  - The identity's commit, run ID, attempt, event, repository, and workflow
    ref must be the run's.
  - Its workflow hash must be that of the committed `ci.yml`.
- **(3) — nothing skipped.**
  - Every step, the job, and the run are `success`.
  - The summary, derived again from the raw report, must be equal to the one
    in the artifact.
  - The summary must list exactly the seven pinned files, each `passed`, with
    no load message, with at least one test, and with every test passed. There
    must be 0 failed, 0 skipped or pending, and 0 todo tests.
  - "0 skipped" alone would not do: a file that was never collected does not
    show up as skipped.
  - The export must report that it ran pinned and compared the golden frames
    to the end.
- **(4) — the artifact.**
  - Every carried text must hash to its file entry, and the identity must bind
    each report by that hash.
  - Every time the reports record must lie within the run's start and end.
  - Neither `.failed` variant may be present.
- **(5)–(7) — the parity record.**
  - Gated, with thresholds 0/0 and every row 0/0, measured in the pinned
    image.
  - It must name the Player dist tree and the runtime artifact that the
    identity names.
- **(8) — the golden frames.** `golden-comparison.json` must be pinned, made
  in the pinned image, with golden frames, and with every frame compared and
  0/0.
- **FFmpeg.** The identity must name the build of D29.1, and it must be the
  build the export used.
- **The §11 row.** It must name the run URL and the commit.

The rest stays the owner's review:

- that the commit is the reviewed code;
- that the zip was downloaded from that run and attempt (the API digest and
  the zip hash make this checkable by hand);
- the Custom HTML findings. The WebRTC checks report only when the run has a
  network (D28.9); the reference run remains the evidence for the Producer,
  and the Player's policy is D36.

The counts to expect: **Check** reports 49 files and 1 858 tests, the count of the
final PR-13 tree on the development machine and in the pinned container, which
runs the same image as CI, unless a later PR changed it. The pinned step
reports `Test Files 7 passed (7)` and `Tests 85 passed (85)`. A mismatch is
investigated, never rounded away.

No evidence file exists while nothing has been pushed, and none may be made up.

## If a gate fails on the runner: analysis first (owner, 2026-09-24)

A cause report comes first. It compares the failing run with the reference run
of `pinned-run.sh` on each of these items, and it says so when the artifact
lacks one (for example, when the identity could not be written):

- **Commit SHA and workflow version.** In `ci-identity.json`: `commitSha`,
  `gitHead`, `workflowRef`, `workflowSha`, and the workflow hashes. Also on
  the run page (`head_sha`, attempt).
- **Playwright image digest.** In the identity (`pinnedImage`), in the parity
  record, and in `golden-comparison.json`, at `environment.image`.
- **Chromium version.** In the parity record and the golden comparison:
  `environment.chromiumRevision`, `chromiumVersion`, and `reportedVersion`.
- **`ffmpegSha256` and `ffprobeSha256`, the versions, and the encoders.** In
  the identity (observed) and in `export-report.json` (as the export used
  them).
- **`playerDistTreeSha256`.** In the identity and in the parity record, with
  its manifest.
- **Runtime artifact hash.** In the identity (`runtimeArtifactSha256`) and in
  the parity record (`reference.runtimeHash` and every row).
- **Fonts and assets.**
  - In the identity: `fonts`, with declared and served hashes.
  - In `golden-comparison.json`: `assetsServed`.
  - The document's `contentHash`, which the record's `compositionHash` binds.
- **DPR, viewport, and surface size.** In the parity record:
  `environment.deviceScaleFactor`, `environment.viewport`, and each row's
  `width` and `height`. The preflight of D33.2 fails, with a message in the
  log, on any other surface.
- **Locale, time zone, and launch arguments.** In the parity record:
  `environment.locale`, `timezone`, and `args`.
- **Per-frame rows.** For each frame: differing pixels, share, maximum channel
  difference, and histogram. They are in the parity record.
  `golden-comparison.json` has the Producer's frames against the golden frames,
  without a histogram.
- **The test run.** `pinned-test-summary.json` and `vitest-pinned.json`: which
  file failed, did not load, or was skipped.

Forbidden during the analysis:

- raising the thresholds of D34;
- regenerating or replacing golden frames;
- marking a cross-environment record `gate: true`;
- treating a red or partly skipped run as evidence of P1, P2, or P5.

A different runner CPU can change pixels that the browser rasterises in
software. In that case D26.5 and D34 fail together. If the analysis shows that
the CI runner needs a policy of its own, that is proposed to the project owner
first, before any ADR is written. `pinned-run.sh prepare`, `reference`, and
`repeat` on the development machine stay the only source of golden frames and
of the committed record (D28.9).
