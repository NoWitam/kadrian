# The first CI run (Q14)

`.github/workflows/ci.yml` (D26.6) failed on its first run and passed on the run
of PR-14 (below). Q14 stays open until a run of the reviewed commit on a remote
GitHub runner has met every criterion below. A local run of the same commands,
including `tests/pinned/container/pinned-run.sh`, does **not** verify CI.

## Status after PR-15 (2026-09-25)

**Status: Q14 is open.**

- The first run, https://github.com/NoWitam/kadrian/actions/runs/36009291627
  (commit `3ddd29d05be2938aabd996701abf9575f219ed33`, attempt 1, event `push`)
  failed at the step `Pinned FFmpeg`: the pinned tests were skipped, and it
  left no artifact.
- PR-14 was committed as `a58ffc335283d2ad64078cabc4757dbc645a57c0` on the
  branch `pr-14-ci-repair`. Its run
  https://github.com/NoWitam/Kadrian/actions/runs/36054995870 (attempt 1,
  event `push`) passed every step.
- Its `kadrion-reports` artifact (id `10832915218`, digest
  `sha256:f95ae9e24e3988716f967898fb37827af25d9033e65337d12ac081b873f744db`)
  exists and was checked on 2026-09-25. It met every machine-checkable
  criterion except the letter case of the repository name (`NoWitam/Kadrian`,
  renamed from `NoWitam/kadrian`), which PR-15 fixes in the validator.
- That run confirms PR-14, but it cannot close Q14 for the commit of PR-15. A
  new green run of that commit, with its own artifact, is required.
- No evidence file exists: `docs/ci/q14-evidence.json` is written only from
  that new run and its artifact.
- Local tests, including the pinned container runs, do not replace a run on a
  GitHub runner.

PR-14 fixed the cause of the first failure (below), and PR-15 fixed the letter
case of the repository name in the Q14 validator.

## The first run and its cause (PR-14)

The step conclusions come from the public page of the run. Its logs need a
signed-in account and were not read; the cause was reproduced instead:

- **Cause.** `node --run ffmpeg:fetch` extracted the archive with `tar -xJf`.
  The pinned Playwright image has no `xz` program, so `tar` could not
  decompress the archive (`xz: Cannot exec`), after the archive had passed its
  SHA-256. This was reproduced as root in the pinned image on 2026-09-24. The
  image has `python3` with its standard `lzma` module.
- **A second fault.** GNU tar run as root gives the extracted files the
  archive's owner, uid 1001. Where root cannot do that (for example on a WSL
  mount), tar fails with "Cannot change ownership". In Docker Desktop it
  succeeds, so this was not the cause of the run, but it is fixed too.
- **Fix** (`tests/ci/ffmpeg-install.ts`), in this order:
  1. The archive is verified by its SHA-256.
  2. It is decompressed by `xz -dc` if `xz` runs, otherwise by `python3` with
     `lzma`. Neither is an explicit `no-decompressor` error.
  3. The stream goes to `tar -x -f - --no-same-owner`. Both processes are
     started without a shell, and both must exit 0.
  4. Only `bin/ffmpeg`, `bin/ffprobe`, and `LICENSE.txt` are extracted, into a
     staging directory.
  5. Both binaries must hash to their pins; then the staging directory is
     renamed to the target. Any failure removes the staging directory, and a
     verified installation is reused on the next run.

  A cached archive with another hash is removed, and the run fails; the next
  run downloads it again. The real `python3` path was run in the pinned image,
  and the `xz` path on the development machine. The process handling is tested
  with `node` standing in for the decompressor and `tar`.

  The FFmpeg release, its URL, the three hashes, the image, and the steps of
  the workflow are unchanged.

- **Diagnostics.** In GitHub Actions, when `ffmpeg:fetch`, the summary, or the
  identity refuses, it now writes `.kadrion-out/diagnostics/<stage>.json`: the
  stage, a fixed error code, and the commit, run, attempt, and workflow of the
  run. A crash before that point (for example a build error) leaves none. With
  it, the artifact is expected to be uploaded even after an early failure; no
  run has shown that yet. A diagnostic is never evidence, and an artifact that
  holds one, in a directory named `diagnostics` in any letter case, cannot
  close Q14.

## What was checked locally (PR-11 to PR-14)

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
  - It has `python3` with `lzma` and no `xz`, so `ffmpeg:fetch` decompresses
    with Python there (PR-14).
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
- **FFmpeg install (PR-14).** `tests/ci/ffmpeg-install.test.ts` checks, without
  a network, the three ways of decompressing (`xz`, `python3` with `lzma`,
  neither) and the arguments of `tar`. It also checks that the staging
  directory is removed after every failure, and that a verified installation
  is reused.
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
- **`diagnostics/<stage>.json` (PR-14):** only when a stage failed:
  `pinned-ffmpeg`, `pinned-test-summary`, or `ci-identity`
  (`tests/ci/diagnostic.ts`). It holds `"evidence": false`, the stage, a fixed
  error code, and the commit, run ID, attempt, workflow ref, and workflow
  commit, each kept only if it has its format. It holds no message, no path,
  and no other variable.

The identity is auxiliary evidence. Closing Q14 still compares the run URL,
`head_sha`, attempt, event, and conclusion with the metadata of GitHub Actions
itself.

## Pushing (the owner)

The owner made the first push on 2026-09-24 (`3ddd29d`). PR-14 was committed
as `a58ffc3` and pushed on the branch `pr-14-ci-repair`. For every push:

1. Every commit and push needs the owner's approval. Nothing in this
   repository commits or pushes on its own.
2. Push to `origin` (`github.com/NoWitam/Kadrian`; the repository was renamed
   from `NoWitam/kadrian`, and GitHub redirects the old name). A branch plus a pull
   request runs the workflow twice (`push` and `pull_request`). A push to
   `main` runs it once.
3. The job needs no secret.

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
  - The repository is `NoWitam/Kadrian`. Only its owner and name are compared
    without case, as GitHub does (PR-15): `nowitam/kadrian` is the same
    repository, and any other owner or name is refused. The run URL must be on
    `https://github.com` with exactly the identity's run ID.
  - `workflowRef` must be `<owner>/<repository>/.github/workflows/ci.yml@<ref>`:
    the workflow path exactly, and the ref after the first `@` exactly the
    identity's `ref` (for a push, `refs/heads/<branch>`), with the same letter
    case, not trimmed, and not empty. Both come from the identity the run
    wrote; the evidence holds no branch from the GitHub API to compare them
    with, so whether the ref is the reviewed branch is left to the owner's
    review.
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
  - Neither `.failed` variant may be present, and nothing under
    `diagnostics/`.
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

What the runs must show is a rule, not a count: `check` passes with no failed
or skipped test, and the pinned step runs exactly the seven pinned test files,
each with every test passed and none skipped, as the summary checks. The
number of tests changes from one pull request to the next and is not part of
the evidence; a different number on the development machine and in the pinned
container, which runs the same image as CI, is investigated, never rounded
away.

No evidence file exists until a green run of the reviewed commit and its own
artifact have been checked, and none may be made up.

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
