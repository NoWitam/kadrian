# D26 — The pinned render environment

- Status: Accepted — by the project owner on 2026-09-22, without a change of substance
- Date: 2026-09-22
- Supersedes: —
- Related: D06, D11, D12, D21, D25, D27, D28,
  [specification](../spike/vertical-spike.md) §5 P1–P2, §6.1, §6.3, and open
  questions Q3, Q8, and Q14

## Context

P2 asks for "pinned Chromium on the server"; golden frames are "asserted only in
the pinned reference environment", and results from a developer machine are
informative only (§5 P2, §6.3). `AGENTS.md` requires that tools which influence
rendering reproducibility are pinned once the spike selects them. Open question
Q3 asked how Chromium is pinned; Q14 asked which CI environment runs the checks;
Q8 asked whether golden frames need Git LFS.

The project owner decided on 2026-09-22:

- **Chromium** comes from Playwright: an exact `playwright-core` version, no `^`
  or `~`, recorded in `pnpm-lock.yaml`, installed in CI with
  `--frozen-lockfile`; the Producer and the Player tests use the same
  Playwright-managed Chromium; the render manifest records the `playwright-core`
  version, the Chromium revision, and the version the running browser reports;
  a browser that is not the expected build is a typed error at launch.
- **Container**: `mcr.microsoft.com/playwright:v<version>-noble@sha256:<digest>`,
  whose version equals the `playwright-core` version. Golden frames and the
  evidence of P1 and P2 come from this container only; a Windows run is for
  development and for reporting differences, and never updates the golden frames
  or proves P1 or P2. Image digest, Playwright version, Chromium revision,
  architecture, locale, time zone, viewport, and device scale factor go into an
  environment manifest.

Evidence gathered on 2026-09-22:

1. npm: `playwright-core` 1.63.0 was published on 2026-09-04 (Apache-2.0, no
   install script, `engines.node >= 20`), older than the 24-hour cooling-off of
   `pnpm-workspace.yaml`. Its `browsers.json` pins `chromium` revision `1243`,
   browser version `153.0.8010.12`, titled "Chrome for Testing".
2. Microsoft Container Registry: the tag `v1.63.0-noble` is the OCI index
   `sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`,
   with the `linux/amd64` manifest
   `sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7` and
   the `linux/arm64` manifest
   `sha256:a0f4498920a5dbac63196d9140ed738ef00470f27e2e74029abd8850b7bd5717`.
3. On the Windows development machine (informative): Playwright launched
   `chrome.exe` 153.0.8010.12 in the new headless mode (`channel: 'chromium'`).
   Its default arguments include `--enable-features=CDPScreenshotNewSurface`
   and disable `PaintHolding`. `Target.getTargets` listed the sandboxed `srcdoc`
   frame of the render page as a target of its own (`iframe:about:srcdoc`), so
   sandboxed frames run out of process there (see D28).
4. The same machine cannot start Chromium from any directory directly below
   `%LOCALAPPDATA%` (Windows reports "side-by-side configuration is incorrect"
   for the assembly `153.0.8010.12`); the identical files start from another
   directory. `PLAYWRIGHT_BROWSERS_PATH`, Playwright's own setting, works around
   it for development. This says nothing about the container.
5. Docker 29.5.3 is installed on the development machine, but the project owner
   declined to pull the image for PR-06. The container has therefore **not been
   run**, no golden frame exists yet, and nothing here proves P1 or P2.

## Decision

**26.1 Pins.** `playwright-core` is exactly `1.63.0` wherever it is declared
(the runtime dependency of `@kadrion/producer`, and the root development
dependency of the browser tests). The expected Chromium is revision `1243`,
version `153.0.8010.12`, taken from that version's `browsers.json` and repeated
as constants in `@kadrion/producer`; the new headless mode (`channel:
'chromium'`, the full Chrome-for-Testing binary) is used, not
`chromium-headless-shell`.

**26.2 Container.** The pinned environment is

```text
mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
```

run as `linux/amd64` (manifest `sha256:bc6ab0d6…54c7`). It carries its own
Node.js and the browsers under `/ms-playwright`. A run is treated as the pinned
environment only when `KADRION_PINNED_IMAGE` equals that reference, the process
runs on `linux`/`x64`, and the launched browser reports the expected version.
The variable can be set by anyone, so this is a guard against mistakes, not
against intent: every golden file carries the environment manifest it was made
in (26.5), and review compares it.

**26.3 Launch.** One function, `launchChromium` of `@kadrion/producer`, launches
the browser for the Producer and for every browser test, so both use the same
executable, arguments, and context:

- arguments in addition to Playwright's defaults: `--force-color-profile=srgb`,
  `--disable-lcd-text`, `--hide-scrollbars`, `--mute-audio`;
- context: viewport = the composition's width and height in CSS pixels,
  `deviceScaleFactor: 1`, locale `en-US`, time zone `UTC`, colour scheme
  `light`, reduced motion `no-preference`;
- before the first page: `playwright-core`'s version and `browsers.json` must
  equal 26.1 (`chromium-mismatch`), the browser must start
  (`chromium-missing`), and `browser.version()` must equal `153.0.8010.12`
  (`chromium-mismatch`).

**26.4 Environment manifest.** `environmentManifest()` records: `pinned`
(26.2), `image` (the value of `KADRION_PINNED_IMAGE` or `null`),
`os`, `arch`, `node`, `playwrightCore`, `chromiumRevision`, `chromiumVersion`
(expected), `reportedVersion` (from the browser), `channel`, `args`, `locale`,
`timezone`, `viewport`, and `deviceScaleFactor`. The render manifest of D28
includes it.

**26.5 Golden frames (Q8, §6.3).** Five PNG files of the Producer at the golden
timestamps, and one `reference.golden-frames.json` with the render manifest,
the environment manifest, and the SHA-256 of every PNG, live in
`packages/test-fixtures/src/golden-frames/`. They are small enough for Git
without LFS (Q8). They are written only by `node --run goldens:update`, which
refuses to write unless the environment is pinned (26.2); the image diff is
reviewed like code. Tests read them by path; the package does not export them.
The golden test asserts pixel equality only in the pinned environment, and only
against a golden file whose environment manifest is pinned; elsewhere it prints
the difference and states that it proves nothing.

**26.6 CI (Q14).** `.github/workflows/ci.yml` runs one job in the container of
26.2 (`--platform linux/amd64`): `corepack pnpm install --frozen-lockfile`,
`corepack pnpm run check`, and `node --run test:pinned` with
`KADRION_PINNED_IMAGE` set. **It has not run:** nothing has been pushed, so the
workflow is unverified, and its first run is the first evidence that it works.

## Alternatives considered

- **Chrome for Testing downloaded by checksum** — what Playwright's revision is
  anyway (evidence 1), with more code of our own; the owner chose Playwright.
- **`chromium-headless-shell`** — Playwright's default for headless. It is a
  different binary from the Chrome a user previews in; the new headless mode
  runs the full browser.
- **A tag without a digest** — a tag can be moved; a digest cannot.
- **Git LFS for golden frames** — not needed for five PNGs (Q8).
- **Goldens produced on the development machine** — excluded by §6.3 and by
  the owner.

## Consequences

- `@kadrion/producer` gains its first external runtime dependency,
  `playwright-core` (Apache-2.0), recorded in the allowlist of D12.
- The root gains `test:pinned` and `goldens:update`. `check` does not start a
  browser; `test:pinned` needs the Playwright-managed Chromium
  (`corepack pnpm exec playwright-core install chromium --no-shell` outside the
  container).
- A `playwright-core` upgrade changes the browser, the image, and the golden
  frames together; `tests/repo/pinned-environment.test.ts` fails until all pins
  agree.
- Until the owner runs the container, P1 and P2 stay unproven and there are no
  golden frames (Consequences of D28).

## Verification

- `tests/repo/pinned-environment.test.ts`: `playwright-core` is exactly
  `1.63.0` in every manifest and in the lockfile; the installed `browsers.json`
  equals 26.1; the CI image equals 26.2, its tag version equals the
  `playwright-core` version, and CI installs with `--frozen-lockfile`.
- `packages/producer/test`: the launch options, the arguments, and the
  environment manifest; the pinned detection of 26.2 for each missing condition.
- `tests/pinned` (`node --run test:pinned`): the browser reports the expected
  version; the render page sees `devicePixelRatio === 1` in both hosts.
