/**
 * The identity of a CI run (owner, 2026-09-24): `.kadrion-out/ci-identity.json`,
 * a versioned contract that says which commit, workflow, runner, image, FFmpeg,
 * fonts, Player build, and runtime artifact a run used, and binds the run's
 * reports by their SHA-256. It is written last, so a report from another run
 * cannot be swapped in later (review of PR-13).
 *
 * It is auxiliary evidence. Closing Q14 still compares the run URL, head SHA,
 * attempt, event, and conclusion with the metadata of GitHub Actions itself.
 *
 * The environment is read by exact name from a fixed list — never by prefix,
 * never in full — so no secret such as GITHUB_TOKEN can reach the file.
 *
 * Pure: node built-ins only; every observation comes through `CiIdentityIo`, so
 * `tests/ci/ci.test.ts` runs it without git, FFmpeg, or GitHub.
 */
import { createHash } from 'node:crypto';

export const CI_IDENTITY_SCHEMA_VERSION = 1;

/** The only environment variables the identity reads, by exact name. */
export const IDENTITY_ENV = Object.freeze([
  'GITHUB_EVENT_NAME',
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'RUNNER_OS',
  'RUNNER_ARCH',
  'KADRION_PINNED_IMAGE',
  'KADRION_FFMPEG',
  'KADRION_FFPROBE',
] as const);
export type IdentityEnv = (typeof IDENTITY_ENV)[number];

export const WORKFLOW_PATH = '.github/workflows/ci.yml';

/** The reports of `.kadrion-out` that the identity binds by hash. */
export const BOUND_REPORTS = Object.freeze([
  'vitest-pinned.json',
  'pinned-test-summary.json',
  'golden-comparison.json',
  'parity/parity-measurement.json',
  'export-report.json',
] as const);

export interface CiIdentity {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly eventName: string;
  /** `GITHUB_SHA`. */
  readonly commitSha: string;
  /** `git rev-parse HEAD` of the checkout. */
  readonly gitHead: string;
  /** `GITHUB_WORKFLOW_SHA`: the commit the workflow file was read from. */
  readonly workflowSha: string;
  readonly ref: string;
  readonly workflowRef: string;
  readonly repository: string;
  readonly workflowPath: string;
  /** SHA-256 of the workflow file in the checkout. */
  readonly workflowSha256: string;
  /** SHA-256 of the workflow file in the commit (`git show <commitSha>:<path>`). */
  readonly workflowSha256AtCommit: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly runner: {
    readonly os: string;
    readonly arch: string;
    /** What the container itself reports. */
    readonly platform: string;
    readonly processArch: string;
  };
  /** `KADRION_PINNED_IMAGE`: the image the job declared (D26.2). */
  readonly pinnedImage: string;
  /** Observed: SHA-256 of the executables at KADRION_FFMPEG and KADRION_FFPROBE. */
  readonly ffmpegSha256: string;
  readonly ffprobeSha256: string;
  /** Observed: the first line of `-version` of each executable. */
  readonly ffmpegVersion: string;
  readonly ffprobeVersion: string;
  /** Observed: `ffmpeg -encoders` against the encoders the export used (D29.1). */
  readonly encoders: {
    readonly required: readonly string[];
    readonly found: readonly string[];
    readonly passed: boolean;
  };
  readonly fonts: readonly {
    readonly id: string;
    /** The `contentHash` the document declares. */
    readonly expectedSha256: string;
    /** SHA-256 of the bytes the resolver actually served in the golden test. */
    readonly actualSha256: string;
    readonly passed: boolean;
  }[];
  readonly fontVerificationPassed: boolean;
  readonly playerDistTreeSha256: string;
  /** SHA-256 of `kadrion-runtime.js`, equal to its manifest's `contentHash`. */
  readonly runtimeArtifactSha256: string;
  /** SHA-256 of each bound report of `.kadrion-out`. */
  readonly reports: Readonly<Record<string, string>>;
}

export interface ProcessOutput {
  readonly code: number | null;
  readonly stdout: string;
}

/** Everything the identity observes, injected. */
export interface CiIdentityIo {
  env(name: IdentityEnv): string | undefined;
  /** The raw standard output of `git <args>` in the checkout; throws when git fails. */
  git(args: readonly string[]): string;
  /** A file of the checkout, by repository-relative path; throws when it is missing. */
  readFile(path: string): Uint8Array;
  /** A file by absolute path (the FFmpeg executables); throws when it is missing. */
  readAbsolute(path: string): Uint8Array;
  run(executable: string, args: readonly string[]): ProcessOutput;
  readonly platform: string;
  readonly arch: string;
  now(): Date;
  /** `playerDistTreeSha256` of the current dist (D33.10). */
  playerDistTreeSha256(): string;
}

/** What the identity must find, from the pins of the repository. */
export interface CiIdentityExpectations {
  readonly pinnedImage: string;
  readonly ffmpegSha256: string;
  readonly ffprobeSha256: string;
  /** The font assets of the reference composition: id and declared content hash. */
  readonly fonts: readonly { readonly id: string; readonly contentHash: string }[];
}

export class CiIdentityError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The CI identity cannot be written:\n- ${problems.join('\n- ')}`);
    this.name = 'CiIdentityError';
    this.problems = problems;
  }
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Observes the run and returns its identity, or throws a `CiIdentityError`
 * listing every missing field and every mismatch. Nothing is written by this
 * function; `write-ci-identity.ts` writes the result only when it succeeds.
 */
export function collectCiIdentity(io: CiIdentityIo, expected: CiIdentityExpectations): CiIdentity {
  const problems: string[] = [];
  const attempt = <T>(what: string, action: () => T, fallback: T): T => {
    try {
      return action();
    } catch (reason) {
      problems.push(`${what}: ${reason instanceof Error ? reason.message : String(reason)}`);
      return fallback;
    }
  };
  const env = (name: IdentityEnv): string => {
    const value = io.env(name);
    if (value === undefined || value === '') {
      problems.push(`${name} is not set`);
      return '';
    }
    return value;
  };

  const eventName = env('GITHUB_EVENT_NAME');
  const commitSha = env('GITHUB_SHA');
  const workflowSha = env('GITHUB_WORKFLOW_SHA');
  const ref = env('GITHUB_REF');
  const workflowRef = env('GITHUB_WORKFLOW_REF');
  const repository = env('GITHUB_REPOSITORY');
  const runIdText = env('GITHUB_RUN_ID');
  const runAttemptText = env('GITHUB_RUN_ATTEMPT');
  const runnerOs = env('RUNNER_OS');
  const runnerArch = env('RUNNER_ARCH');
  const pinnedImage = env('KADRION_PINNED_IMAGE');
  const ffmpegPath = env('KADRION_FFMPEG');
  const ffprobePath = env('KADRION_FFPROBE');

  const gitHead = attempt('git rev-parse HEAD', () => io.git(['rev-parse', 'HEAD']).trim(), '');
  if (commitSha !== '' && gitHead !== '' && commitSha !== gitHead) {
    problems.push(`GITHUB_SHA ${commitSha} is not git rev-parse HEAD ${gitHead}`);
  }
  if (commitSha !== '' && workflowSha !== '' && workflowSha !== commitSha) {
    problems.push(`GITHUB_WORKFLOW_SHA ${workflowSha} is not GITHUB_SHA ${commitSha}`);
  }
  const runId = Number(runIdText);
  const runAttempt = Number(runAttemptText);
  if (runIdText !== '' && !(Number.isSafeInteger(runId) && runId > 0)) {
    problems.push(`GITHUB_RUN_ID ${runIdText} is not a positive integer`);
  }
  if (runAttemptText !== '' && !(Number.isSafeInteger(runAttempt) && runAttempt > 0)) {
    problems.push(`GITHUB_RUN_ATTEMPT ${runAttemptText} is not a positive integer`);
  }
  if (pinnedImage !== '' && pinnedImage !== expected.pinnedImage) {
    problems.push(`KADRION_PINNED_IMAGE ${pinnedImage} is not the pinned image`);
  }

  const workflowSha256 = attempt(WORKFLOW_PATH, () => sha256(io.readFile(WORKFLOW_PATH)), '');
  const workflowSha256AtCommit = attempt(
    `git show ${WORKFLOW_PATH}`,
    () => (commitSha === '' ? '' : sha256(io.git(['show', `${commitSha}:${WORKFLOW_PATH}`]))),
    '',
  );
  if (
    workflowSha256 !== '' &&
    workflowSha256AtCommit !== '' &&
    workflowSha256 !== workflowSha256AtCommit
  ) {
    problems.push('the workflow file of the checkout is not the one of the commit');
  }

  // FFmpeg: observed, and compared with the pins and with what the export used.
  const ffmpegSha256 = attempt('ffmpeg', () => sha256(io.readAbsolute(ffmpegPath)), '');
  const ffprobeSha256 = attempt('ffprobe', () => sha256(io.readAbsolute(ffprobePath)), '');
  if (ffmpegSha256 !== '' && ffmpegSha256 !== expected.ffmpegSha256) {
    problems.push(`ffmpeg has ${ffmpegSha256}, not the pinned ${expected.ffmpegSha256}`);
  }
  if (ffprobeSha256 !== '' && ffprobeSha256 !== expected.ffprobeSha256) {
    problems.push(`ffprobe has ${ffprobeSha256}, not the pinned ${expected.ffprobeSha256}`);
  }
  const firstLine = (executable: string, name: string): string => {
    if (executable === '') return '';
    const output = io.run(executable, ['-hide_banner', '-version']);
    const line = output.stdout.split('\n')[0]?.trimEnd() ?? '';
    if (output.code !== 0 || line === '') problems.push(`${name} -version failed`);
    return line;
  };
  const ffmpegVersion = firstLine(ffmpegPath, 'ffmpeg');
  const ffprobeVersion = firstLine(ffprobePath, 'ffprobe');
  const exportReport = attempt(
    '.kadrion-out/export-report.json',
    () =>
      JSON.parse(text(io.readFile('.kadrion-out/export-report.json'))) as {
        ffmpeg?: {
          ffmpegSha256?: unknown;
          ffprobeSha256?: unknown;
          version?: unknown;
          encoders?: unknown;
        };
      },
    {},
  );
  const used = exportReport.ffmpeg;
  if (used === undefined) {
    problems.push('export-report.json does not record the FFmpeg the export used');
  } else {
    if (used.ffmpegSha256 !== ffmpegSha256 || used.ffprobeSha256 !== ffprobeSha256) {
      problems.push('the export used other FFmpeg executables than the ones observed');
    }
    if (typeof used.version !== 'string' || !ffmpegVersion.includes(used.version)) {
      problems.push(`ffmpeg reports "${ffmpegVersion}", not the version the export used`);
    }
  }
  const required = Array.isArray(used?.encoders) ? (used.encoders as string[]) : [];
  if (required.length === 0) problems.push('no required encoders are known');
  const listed =
    ffmpegPath === '' ? { code: 1, stdout: '' } : io.run(ffmpegPath, ['-hide_banner', '-encoders']);
  const found = required.filter(
    (encoder) =>
      listed.code === 0 &&
      new RegExp(`^\\s*[VA][A-Z.]{5}\\s+${encoder}\\s`, 'm').test(listed.stdout),
  );
  const encoders = {
    required,
    found,
    passed: required.length > 0 && found.length === required.length,
  };
  if (!encoders.passed)
    problems.push(`ffmpeg lists ${JSON.stringify(found)} of ${JSON.stringify(required)}`);

  // Fonts: declared hash against the bytes the resolver served in the golden test.
  const served = attempt(
    '.kadrion-out/golden-comparison.json',
    () =>
      (
        JSON.parse(text(io.readFile('.kadrion-out/golden-comparison.json'))) as {
          assetsServed?: { id: string; sha256: string }[];
        }
      ).assetsServed ?? [],
    [] as { id: string; sha256: string }[],
  );
  const fonts = expected.fonts.map(({ id, contentHash }) => {
    const actualSha256 = served.find((asset) => asset.id === id)?.sha256 ?? '';
    return { id, expectedSha256: contentHash, actualSha256, passed: actualSha256 === contentHash };
  });
  const fontVerificationPassed = fonts.length > 0 && fonts.every((font) => font.passed);
  if (!fontVerificationPassed)
    problems.push('the served font bytes do not match the declared hashes');

  const playerDistTreeSha256 = attempt('the Player dist tree', () => io.playerDistTreeSha256(), '');
  const runtimeArtifactSha256 = attempt(
    'the runtime artifact',
    () => {
      const hash = sha256(
        io.readFile('packages/renderer-dom/dist/runtime-build/kadrion-runtime.js'),
      );
      const manifest = JSON.parse(
        text(io.readFile('packages/renderer-dom/dist/runtime-build/kadrion-runtime.json')),
      ) as { contentHash?: unknown };
      if (manifest.contentHash !== hash) {
        throw new Error(
          `kadrion-runtime.js has ${hash}, its manifest says ${String(manifest.contentHash)}`,
        );
      }
      return hash;
    },
    '',
  );
  const reports = Object.fromEntries(
    BOUND_REPORTS.map((path) => [
      path,
      attempt(`.kadrion-out/${path}`, () => sha256(io.readFile(`.kadrion-out/${path}`)), ''),
    ]),
  );

  if (problems.length > 0) throw new CiIdentityError(problems);
  return {
    schemaVersion: CI_IDENTITY_SCHEMA_VERSION,
    generatedAt: io.now().toISOString(),
    eventName,
    commitSha,
    gitHead,
    workflowSha,
    ref,
    workflowRef,
    repository,
    workflowPath: WORKFLOW_PATH,
    workflowSha256,
    workflowSha256AtCommit,
    runId,
    runAttempt,
    runner: { os: runnerOs, arch: runnerArch, platform: io.platform, processArch: io.arch },
    pinnedImage,
    ffmpegSha256,
    ffprobeSha256,
    ffmpegVersion,
    ffprobeVersion,
    encoders,
    fonts,
    fontVerificationPassed,
    playerDistTreeSha256,
    runtimeArtifactSha256,
    reports,
  };
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The top-level keys of an identity, exactly: an extra key could carry anything. */
export const IDENTITY_KEYS = Object.freeze([
  'schemaVersion',
  'generatedAt',
  'eventName',
  'commitSha',
  'gitHead',
  'workflowSha',
  'ref',
  'workflowRef',
  'repository',
  'workflowPath',
  'workflowSha256',
  'workflowSha256AtCommit',
  'runId',
  'runAttempt',
  'runner',
  'pinnedImage',
  'ffmpegSha256',
  'ffprobeSha256',
  'ffmpegVersion',
  'ffprobeVersion',
  'encoders',
  'fonts',
  'fontVerificationPassed',
  'playerDistTreeSha256',
  'runtimeArtifactSha256',
  'reports',
]);

/** Everything that keeps `value` from being a well-formed, internally consistent identity. */
export function ciIdentityProblems(value: unknown): string[] {
  const identity = value as Partial<CiIdentity> | null;
  if (typeof identity !== 'object' || identity === null) return ['the identity is not an object'];
  const problems: string[] = [];
  if (identity.schemaVersion !== CI_IDENTITY_SCHEMA_VERSION) {
    return [`unsupported identity schemaVersion ${JSON.stringify(identity.schemaVersion)}`];
  }
  if (JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify([...IDENTITY_KEYS].sort())) {
    problems.push('the identity has other keys than its contract');
  }
  for (const field of [
    'eventName',
    'ref',
    'workflowRef',
    'repository',
    'pinnedImage',
    'ffmpegVersion',
    'ffprobeVersion',
  ] as const) {
    if (typeof identity[field] !== 'string' || identity[field] === '')
      problems.push(`${field} is empty`);
  }
  for (const field of ['commitSha', 'gitHead', 'workflowSha'] as const) {
    if (typeof identity[field] !== 'string' || !COMMIT.test(identity[field])) {
      problems.push(`${field} is not 40 hex digits`);
    }
  }
  if (identity.commitSha !== identity.gitHead) problems.push('commitSha is not gitHead');
  if (identity.workflowSha !== identity.commitSha) problems.push('workflowSha is not commitSha');
  if (identity.workflowPath !== WORKFLOW_PATH) problems.push('workflowPath is not the workflow');
  for (const field of [
    'workflowSha256',
    'workflowSha256AtCommit',
    'ffmpegSha256',
    'ffprobeSha256',
    'playerDistTreeSha256',
    'runtimeArtifactSha256',
  ] as const) {
    if (typeof identity[field] !== 'string' || !HASH.test(identity[field])) {
      problems.push(`${field} is not a sha256: hash`);
    }
  }
  if (identity.workflowSha256 !== identity.workflowSha256AtCommit) {
    problems.push('the workflow of the checkout is not the one of the commit');
  }
  for (const field of ['runId', 'runAttempt'] as const) {
    const number = identity[field];
    if (!(typeof number === 'number' && Number.isSafeInteger(number) && number > 0)) {
      problems.push(`${field} is not a positive integer`);
    }
  }
  if (typeof identity.generatedAt !== 'string' || Number.isNaN(Date.parse(identity.generatedAt))) {
    problems.push('generatedAt is not a time');
  }
  const runner = identity.runner;
  if (
    typeof runner?.os !== 'string' ||
    runner.os === '' ||
    typeof runner.arch !== 'string' ||
    runner.arch === '' ||
    typeof runner.platform !== 'string' ||
    typeof runner.processArch !== 'string'
  ) {
    problems.push('the runner is incomplete');
  }
  const encoders = identity.encoders;
  if (
    encoders?.passed !== true ||
    !Array.isArray(encoders.required) ||
    encoders.required.length === 0 ||
    JSON.stringify(encoders.found) !== JSON.stringify(encoders.required)
  ) {
    problems.push('the encoder check did not pass');
  }
  // Read as untrusted: every field is checked, not assumed.
  const fonts: readonly {
    id?: unknown;
    expectedSha256?: unknown;
    actualSha256?: unknown;
    passed?: unknown;
  }[] = Array.isArray(identity.fonts) ? (identity.fonts as readonly Record<string, unknown>[]) : [];
  if (fonts.length === 0) problems.push('no font was verified');
  for (const font of fonts) {
    if (
      typeof font.expectedSha256 !== 'string' ||
      !HASH.test(font.expectedSha256) ||
      font.actualSha256 !== font.expectedSha256 ||
      font.passed !== true
    ) {
      problems.push(`the font ${String(font.id)} was not verified`);
    }
  }
  if (identity.fontVerificationPassed !== true || !fonts.every((font) => font.passed === true)) {
    problems.push('fontVerificationPassed is not true');
  }
  const reports = identity.reports ?? {};
  for (const path of BOUND_REPORTS) {
    if (typeof reports[path] !== 'string' || !HASH.test(reports[path])) {
      problems.push(`the report ${path} is not bound by a hash`);
    }
  }
  if (Object.keys(reports).length !== BOUND_REPORTS.length) {
    problems.push('the identity binds other reports than its contract');
  }
  return problems;
}
