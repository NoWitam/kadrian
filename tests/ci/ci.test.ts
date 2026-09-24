/**
 * The contracts of the CI evidence (owner, 2026-09-24), without CI: the pinned
 * test summary derived from a Vitest JSON report, and the CI identity collected
 * through a fake IO. Every refusal names its problem, so a rule that another
 * rule happens to cover as well is still seen doing its own work.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BOUND_REPORTS,
  ciIdentityProblems,
  CiIdentityError,
  collectCiIdentity,
  IDENTITY_ENV,
  IDENTITY_KEYS,
  type CiIdentityIo,
  type IdentityEnv,
} from './ci-identity.js';
import {
  PinnedSummaryError,
  pinnedSummaryProblems,
  REQUIRED_PINNED_FILES,
  summarizeVitestReport,
} from './pinned-summary.js';

const ROOT = '/__w/kadrian/kadrian/';

function hash(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

// --- the pinned test summary ----------------------------------------------

interface RawFile {
  name: string;
  status: string;
  message: string;
  startTime: number;
  endTime: number;
  assertionResults: { status: string }[];
}

function raw(): { startTime: number; success: boolean; testResults: RawFile[] } {
  return {
    startTime: 1_000,
    success: true,
    // Unsorted on purpose: the summary sorts.
    testResults: [...REQUIRED_PINNED_FILES].reverse().map((file, index) => ({
      name: `${ROOT}${file}`,
      status: 'passed',
      message: '',
      startTime: 2_000 + index,
      endTime: 3_000 + index,
      assertionResults: [{ status: 'passed' }, { status: 'passed' }],
    })),
  };
}

describe('the pinned test summary', () => {
  it('lists exactly the pinned test files on disk', () => {
    const onDisk = readdirSync(new URL('../pinned/', import.meta.url))
      .filter((file) => file.endsWith('.pinned.test.ts'))
      .map((file) => `tests/pinned/${file}`)
      .sort();
    expect([...REQUIRED_PINNED_FILES]).toEqual(onDisk);
  });

  it('summarises a green report: sorted POSIX paths, counts, times, success', () => {
    const summary = summarizeVitestReport(raw(), ROOT);
    expect(summary).toMatchObject({
      schemaVersion: 1,
      root: ROOT,
      testFileCount: 7,
      testFiles: [...REQUIRED_PINNED_FILES],
      tests: 14,
      passed: 14,
      failed: 0,
      skipped: 0,
      todo: 0,
      startedAt: new Date(1_000).toISOString(),
      lastTestEndedAt: new Date(3_006).toISOString(),
      success: true,
    });
    expect(pinnedSummaryProblems(summary)).toEqual([]);
  });

  it('derives the same POSIX paths from a POSIX root on any platform', () => {
    expect(summarizeVitestReport(raw(), ROOT).testFiles[0]).toBe(REQUIRED_PINNED_FILES[0]);
  });

  it('refuses a report that is not one: a missing report is an error, not an empty run', () => {
    expect(() => summarizeVitestReport(undefined, ROOT)).toThrow(PinnedSummaryError);
    expect(() => summarizeVitestReport({ startTime: 1 }, ROOT)).toThrow(/no testResults/);
    expect(() => summarizeVitestReport({ testResults: [] }, ROOT)).toThrow(/startTime/);
  });

  it.each<[string, (report: ReturnType<typeof raw>) => void, string]>([
    [
      'a failed test',
      (report) =>
        ((report.testResults[0]?.assertionResults[0] as { status: string }).status = 'failed'),
      '1 tests failed',
    ],
    [
      'a skipped test',
      (report) =>
        ((report.testResults[1]?.assertionResults[0] as { status: string }).status = 'skipped'),
      '1 tests were skipped',
    ],
    [
      'a pending test (only, run, queued)',
      (report) =>
        ((report.testResults[1]?.assertionResults[0] as { status: string }).status = 'pending'),
      '1 tests were skipped',
    ],
    [
      'a test of an unknown status',
      (report) =>
        ((report.testResults[1]?.assertionResults[0] as { status: string }).status = 'flaky'),
      '1 tests were skipped',
    ],
    [
      'a todo test',
      (report) =>
        ((report.testResults[1]?.assertionResults[0] as { status: string }).status = 'todo'),
      '1 tests are todo',
    ],
    [
      'a file that failed to import',
      (report) => {
        const file = report.testResults[2];
        if (file !== undefined) {
          file.status = 'failed';
          file.message = 'Cannot find module';
          file.assertionResults = [];
        }
      },
      'reported: Cannot find module',
    ],
    [
      'a file without tests',
      (report) => {
        const file = report.testResults[3];
        if (file !== undefined) file.assertionResults = [];
      },
      'has no tests',
    ],
    [
      'a missing pinned file',
      (report) => report.testResults.splice(0, 1),
      'not exactly the seven pinned files',
    ],
    [
      'an extra test file',
      (report) =>
        report.testResults.push({
          ...(report.testResults[0] as RawFile),
          name: `${ROOT}tests/pinned/extra.pinned.test.ts`,
        }),
      'not exactly the seven pinned files',
    ],
    [
      'a file that failed after its tests passed (an afterAll error)',
      (report) => {
        const file = report.testResults[4];
        if (file !== undefined) file.status = 'failed';
      },
      'tests/pinned/export.pinned.test.ts is failed',
    ],
    [
      'a load message that is not text',
      (report) => {
        const file = report.testResults[4];
        if (file !== undefined) (file as { message: unknown }).message = { stack: 'boom' };
      },
      'tests/pinned/export.pinned.test.ts reported: {"stack":"boom"}',
    ],
  ])('refuses %s', (_, edit, problem) => {
    const report = raw();
    edit(report);
    const summary = summarizeVitestReport(report, ROOT);
    expect(summary.success).toBe(false);
    expect(pinnedSummaryProblems(summary).join(' | ')).toContain(problem);
  });

  it.each<[string, (summary: Record<string, unknown>) => void, string]>([
    [
      'another schema version',
      (summary) => (summary.schemaVersion = 2),
      'unsupported summary schemaVersion',
    ],
    ['counts that do not add up', (summary) => (summary.passed = 13), 'do not add up'],
    ['a negative count', (summary) => (summary.todo = -1), 'todo is not a non-negative integer'],
    ['success set by hand', (summary) => (summary.success = false), 'success is not true'],
    [
      'a file count that disagrees',
      (summary) => (summary.testFileCount = 6),
      'testFileCount is not the number',
    ],
    [
      'files and paths that disagree',
      (summary) => (summary.files as unknown[]).pop(),
      'files and testFiles disagree',
    ],
    [
      'a file without the golden test',
      (summary) =>
        (summary.testFiles = (summary.testFiles as string[]).filter(
          (file) => !file.includes('producer'),
        )),
      'the run has no tests/pinned/producer.pinned.test.ts',
    ],
    ['no time', (summary) => (summary.lastTestEndedAt = 'later'), 'lastTestEndedAt is not a time'],
    [
      'a file whose tests did not all pass',
      (summary) => (((summary.files as { passed: number }[])[0] as { passed: number }).passed = 1),
      'tests/pinned/custom-html.pinned.test.ts: not every test passed',
    ],
  ])('refuses a summary with %s', (_, edit, problem) => {
    const summary = structuredClone(summarizeVitestReport(raw(), ROOT)) as unknown as Record<
      string,
      unknown
    >;
    edit(summary);
    expect(pinnedSummaryProblems(summary).join(' | ')).toContain(problem);
  });
});

// --- the CI identity ------------------------------------------------------

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const FFMPEG = new Uint8Array([1, 2, 3]);
const FFPROBE = new Uint8Array([4, 5, 6]);
const FONT = new Uint8Array([7, 8, 9]);
const RUNTIME = new Uint8Array([10, 11]);
const WORKFLOW = 'name: ci\n';
const EXPECTED = {
  pinnedImage: 'image@sha256:pinned',
  ffmpegSha256: hash(FFMPEG),
  ffprobeSha256: hash(FFPROBE),
  fonts: [{ id: 'asset-font', contentHash: hash(FONT) }],
};

interface World {
  env: Record<string, string>;
  files: Map<string, Uint8Array | string>;
  gitHead: string;
  gitWorkflow: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  encoders: string;
  encodersCode: number;
}

function world(): World {
  return {
    env: {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: HEAD,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: 'NoWitam/kadrian/.github/workflows/ci.yml@refs/heads/main',
      GITHUB_WORKFLOW_SHA: HEAD,
      GITHUB_REPOSITORY: 'NoWitam/kadrian',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      KADRION_PINNED_IMAGE: 'image@sha256:pinned',
      KADRION_FFMPEG: '/opt/ffmpeg',
      KADRION_FFPROBE: '/opt/ffprobe',
      // Secrets the identity must never read.
      GITHUB_TOKEN: 'ghs_secret_token',
      ACTIONS_RUNTIME_TOKEN: 'runtime_secret_token',
    },
    files: new Map<string, Uint8Array | string>([
      ['.github/workflows/ci.yml', WORKFLOW],
      ['/opt/ffmpeg', FFMPEG],
      ['/opt/ffprobe', FFPROBE],
      ['packages/renderer-dom/dist/runtime-build/kadrion-runtime.js', RUNTIME],
      [
        'packages/renderer-dom/dist/runtime-build/kadrion-runtime.json',
        JSON.stringify({ contentHash: hash(RUNTIME) }),
      ],
      ['.kadrion-out/vitest-pinned.json', '{"v":1}'],
      ['.kadrion-out/pinned-test-summary.json', '{"s":1}'],
      [
        '.kadrion-out/golden-comparison.json',
        JSON.stringify({ assetsServed: [{ id: 'asset-font', sha256: hash(FONT) }] }),
      ],
      ['.kadrion-out/parity/parity-measurement.json', '{"p":1}'],
      [
        '.kadrion-out/export-report.json',
        JSON.stringify({
          ffmpeg: {
            ffmpegSha256: hash(FFMPEG),
            ffprobeSha256: hash(FFPROBE),
            version: 'n8.1.3-20260921',
            encoders: ['libx264', 'aac'],
          },
        }),
      ],
    ]),
    gitHead: `${HEAD}\n`,
    gitWorkflow: WORKFLOW,
    ffmpegVersion: 'ffmpeg version n8.1.3-20260921 Copyright (c) 2000-2026',
    ffprobeVersion: 'ffprobe version n8.1.3-20260921',
    encoders: ' V....D libx264              libx264 H.264\n A....D aac                  AAC\n',
    encodersCode: 0,
  };
}

function io(given: World): CiIdentityIo {
  const read = (path: string): Uint8Array => {
    const found = given.files.get(path);
    if (found === undefined) throw new Error(`no ${path}`);
    return typeof found === 'string' ? new TextEncoder().encode(found) : found;
  };
  return {
    env: (name: IdentityEnv) => given.env[name],
    git: (args) => {
      if (args[0] === 'rev-parse') return given.gitHead;
      if (args[0] === 'show') return given.gitWorkflow;
      throw new Error(`git ${args.join(' ')}`);
    },
    readFile: read,
    readAbsolute: read,
    run: (executable, args) =>
      args.includes('-encoders')
        ? { code: given.encodersCode, stdout: given.encoders }
        : {
            code: 0,
            stdout: executable.endsWith('ffprobe')
              ? `${given.ffprobeVersion}\n`
              : `${given.ffmpegVersion}\n`,
          },
    platform: 'linux',
    arch: 'x64',
    now: () => new Date('2026-10-01T10:02:00.000Z'),
    playerDistTreeSha256: () => `sha256:${'9'.repeat(64)}`,
  };
}

function problemsOf(given: World, expected = EXPECTED): string {
  try {
    collectCiIdentity(io(given), expected);
    return '';
  } catch (reason) {
    if (!(reason instanceof CiIdentityError)) throw reason;
    return reason.problems.join(' | ');
  }
}

describe('the CI identity', () => {
  it('reads the environment by exact name only, and no secret name is on the list', () => {
    for (const name of IDENTITY_ENV) expect(name).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY/);
    expect(IDENTITY_ENV.every((name) => !name.endsWith('*'))).toBe(true);
  });

  it('collects a well-formed identity that binds every report and carries no secret', () => {
    const identity = collectCiIdentity(io(world()), EXPECTED);
    expect(ciIdentityProblems(identity)).toEqual([]);
    expect(Object.keys(identity).sort()).toEqual([...IDENTITY_KEYS].sort());
    expect(Object.keys(identity.reports)).toEqual([...BOUND_REPORTS]);
    expect(identity).toMatchObject({
      commitSha: HEAD,
      gitHead: HEAD,
      runId: 42,
      runAttempt: 1,
      ffmpegSha256: hash(FFMPEG),
      fontVerificationPassed: true,
      runtimeArtifactSha256: hash(RUNTIME),
      generatedAt: '2026-10-01T10:02:00.000Z',
    });
    const text = JSON.stringify(identity);
    expect(text).not.toContain('secret');
  });

  it.each<[string, (given: World) => void, string]>([
    [
      'GITHUB_SHA other than git rev-parse HEAD',
      (given) => (given.gitHead = `${'f'.repeat(40)}\n`),
      'is not git rev-parse HEAD',
    ],
    [
      'a missing GITHUB_RUN_ID',
      (given) => delete given.env.GITHUB_RUN_ID,
      'GITHUB_RUN_ID is not set',
    ],
    [
      'an empty GITHUB_REPOSITORY',
      (given) => (given.env.GITHUB_REPOSITORY = ''),
      'GITHUB_REPOSITORY is not set',
    ],
    [
      'a run attempt that is not a number',
      (given) => (given.env.GITHUB_RUN_ATTEMPT = 'one'),
      'GITHUB_RUN_ATTEMPT one is not a positive integer',
    ],
    [
      'a workflow of another commit',
      (given) => (given.env.GITHUB_WORKFLOW_SHA = 'e'.repeat(40)),
      'GITHUB_WORKFLOW_SHA',
    ],
    [
      'another pinned image',
      (given) => (given.env.KADRION_PINNED_IMAGE = 'image@sha256:other'),
      'is not the pinned image',
    ],
    [
      'a workflow file changed in the checkout',
      (given) => given.files.set('.github/workflows/ci.yml', 'name: other\n'),
      'the workflow file of the checkout is not the one of the commit',
    ],
    [
      'another ffmpeg executable',
      (given) => given.files.set('/opt/ffmpeg', new Uint8Array([0])),
      'not the pinned',
    ],
    [
      'another ffprobe executable',
      (given) => given.files.set('/opt/ffprobe', new Uint8Array([0])),
      `ffprobe has ${hash(new Uint8Array([0]))}, not the pinned`,
    ],
    [
      'a missing ffprobe',
      (given) => given.files.delete('/opt/ffprobe'),
      'ffprobe: no /opt/ffprobe',
    ],
    [
      'another ffmpeg version',
      (given) => (given.ffmpegVersion = 'ffmpeg version 7.0'),
      'not the version the export used',
    ],
    [
      'a missing encoder',
      (given) => (given.encoders = ' V....D libx264   libx264\n'),
      'ffmpeg lists ["libx264"] of ["libx264","aac"]',
    ],
    [
      'an export that used another FFmpeg',
      (given) =>
        given.files.set(
          '.kadrion-out/export-report.json',
          JSON.stringify({
            ffmpeg: {
              ffmpegSha256: hash('x'),
              ffprobeSha256: hash(FFPROBE),
              version: 'n8.1.3-20260921',
              encoders: ['libx264', 'aac'],
            },
          }),
        ),
      'the export used other FFmpeg executables',
    ],
    [
      'a served font of other bytes',
      (given) =>
        given.files.set(
          '.kadrion-out/golden-comparison.json',
          JSON.stringify({ assetsServed: [{ id: 'asset-font', sha256: hash('x') }] }),
        ),
      'the served font bytes do not match',
    ],
    [
      'a runtime that is not its manifest',
      (given) =>
        given.files.set(
          'packages/renderer-dom/dist/runtime-build/kadrion-runtime.js',
          new Uint8Array([0]),
        ),
      'its manifest says',
    ],
    [
      'a missing report',
      (given) => given.files.delete('.kadrion-out/pinned-test-summary.json'),
      '.kadrion-out/pinned-test-summary.json: no',
    ],
    [
      'a run id that is not a number',
      (given) => (given.env.GITHUB_RUN_ID = '4x2'),
      'GITHUB_RUN_ID 4x2 is not a positive integer',
    ],
    [
      'an ffprobe that prints no version',
      (given) => (given.ffprobeVersion = ''),
      'ffprobe -version failed',
    ],
    [
      'an export report without its FFmpeg',
      (given) => given.files.set('.kadrion-out/export-report.json', '{}'),
      'export-report.json does not record the FFmpeg the export used',
    ],
    [
      'an export report without encoders',
      (given) =>
        given.files.set(
          '.kadrion-out/export-report.json',
          JSON.stringify({
            ffmpeg: {
              ffmpegSha256: hash(FFMPEG),
              ffprobeSha256: hash(FFPROBE),
              version: 'n8.1.3-20260921',
              encoders: [],
            },
          }),
        ),
      'no required encoders are known',
    ],
    [
      'an encoder listing that failed',
      (given) => (given.encodersCode = 1),
      'ffmpeg lists [] of ["libx264","aac"]',
    ],
    [
      'an encoder named only in the description of another',
      (given) => (given.encoders = ' V....D libx264              libx264 H.264 (no aac here)\n'),
      'ffmpeg lists ["libx264"] of ["libx264","aac"]',
    ],
  ])('refuses %s', (_, edit, problem) => {
    const given = world();
    edit(given);
    expect(problemsOf(given)).toContain(problem);
  });

  it('refuses a run without any font to verify', () => {
    expect(problemsOf(world(), { ...EXPECTED, fonts: [] })).toContain(
      'the served font bytes do not match the declared hashes',
    );
  });

  it.each<[string, (identity: Record<string, unknown>) => void, string]>([
    [
      'another schema version',
      (identity) => (identity.schemaVersion = 2),
      'unsupported identity schemaVersion',
    ],
    [
      'an extra key (the environment, for example)',
      (identity) => (identity.env = { GITHUB_TOKEN: 'x' }),
      'other keys than its contract',
    ],
    [
      'commitSha other than gitHead',
      (identity) => (identity.gitHead = 'f'.repeat(40)),
      'commitSha is not gitHead',
    ],
    [
      'a short commit',
      (identity) => {
        identity.commitSha = '0123';
      },
      'commitSha is not 40 hex digits',
    ],
    [
      'a workflow changed after the commit',
      (identity) => (identity.workflowSha256AtCommit = hash('other')),
      'the workflow of the checkout is not the one of the commit',
    ],
    ['a zero run id', (identity) => (identity.runId = 0), 'runId is not a positive integer'],
    [
      'a failed encoder check',
      (identity) => ((identity.encoders as Record<string, unknown>).passed = false),
      'the encoder check did not pass',
    ],
    [
      'an unverified font',
      (identity) =>
        ((identity.fonts as Record<string, unknown>[])[0] = {
          id: 'asset-font',
          expectedSha256: hash(FONT),
          actualSha256: hash('x'),
          passed: false,
        }),
      'the font asset-font was not verified',
    ],
    [
      'a font check forged to true',
      (identity) => (identity.fontVerificationPassed = false),
      'fontVerificationPassed is not true',
    ],
    [
      'an unbound report',
      (identity) => delete (identity.reports as Record<string, unknown>)['export-report.json'],
      'the report export-report.json is not bound',
    ],
    [
      'an extra bound report',
      (identity) => ((identity.reports as Record<string, unknown>)['other.json'] = hash('x')),
      'binds other reports',
    ],
    [
      'an incomplete runner',
      (identity) => ((identity.runner as Record<string, unknown>).os = ''),
      'the runner is incomplete',
    ],
    [
      'no generation time',
      (identity) => (identity.generatedAt = 'now'),
      'generatedAt is not a time',
    ],
    ['an empty ref', (identity) => (identity.ref = ''), 'ref is empty'],
    [
      'a workflow of another commit',
      (identity) => (identity.workflowSha = 'e'.repeat(40)),
      'workflowSha is not commitSha',
    ],
    [
      'another workflow path',
      (identity) => (identity.workflowPath = '.github/workflows/other.yml'),
      'workflowPath is not the workflow',
    ],
    [
      'a dist tree hash that is not a sha256: hash',
      (identity) => (identity.playerDistTreeSha256 = 'b3b6e61e'),
      'playerDistTreeSha256 is not a sha256: hash',
    ],
    [
      'fewer encoders found than required, marked passed',
      (identity) => ((identity.encoders as Record<string, unknown>).found = ['libx264']),
      'the encoder check did not pass',
    ],
    ['no fonts', (identity) => (identity.fonts = []), 'no font was verified'],
    [
      'a font of other bytes, marked passed',
      (identity) =>
        ((identity.fonts as Record<string, unknown>[])[0] = {
          id: 'asset-font',
          expectedSha256: hash(FONT),
          actualSha256: hash('x'),
          passed: true,
        }),
      'the font asset-font was not verified',
    ],
  ])('refuses an identity with %s', (_, edit, problem) => {
    const identity = structuredClone(collectCiIdentity(io(world()), EXPECTED)) as unknown as Record<
      string,
      unknown
    >;
    edit(identity);
    expect(ciIdentityProblems(identity).join(' | ')).toContain(problem);
  });
});

// --- the generators, as the workflow runs them --------------------------------

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function runScript(
  script: string,
  env: NodeJS.ProcessEnv = process.env,
): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script], {
    encoding: 'utf8',
    env,
  });
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('the generators', () => {
  // write-pinned-summary.ts reads and writes relative to its own checkout: run a
  // copy of it in a temporary one, so the real .kadrion-out is never touched.
  function checkout(): { root: string; script: string; out: string } {
    const root = mkdtempSync(join(tmpdir(), 'kadrion-summary-'));
    mkdirSync(join(root, 'tests', 'ci'), { recursive: true });
    for (const file of ['write-pinned-summary.ts', 'pinned-summary.ts']) {
      copyFileSync(new URL(file, import.meta.url), join(root, 'tests', 'ci', file));
    }
    writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
    mkdirSync(join(root, '.kadrion-out'));
    return {
      root,
      script: join(root, 'tests', 'ci', 'write-pinned-summary.ts'),
      out: join(root, '.kadrion-out'),
    };
  }

  function nativeReport(root: string): ReturnType<typeof raw> {
    const report = raw();
    for (const file of report.testResults) {
      file.name = join(root, ...file.name.slice(ROOT.length).split('/'));
    }
    return report;
  }

  it('fails and writes nothing when Vitest wrote no raw report: an evidence error', () => {
    const { root, script, out } = checkout();
    try {
      const { code, output } = runScript(script);
      expect(code).toBe(1);
      expect(output).toContain('There is no .kadrion-out/vitest-pinned.json');
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes the summary of a green report and succeeds', () => {
    const { root, script, out } = checkout();
    try {
      const report = nativeReport(root);
      writeFileSync(join(out, 'vitest-pinned.json'), JSON.stringify(report));
      const { code } = runScript(script);
      expect(code).toBe(0);
      const written: unknown = JSON.parse(
        readFileSync(join(out, 'pinned-test-summary.json'), 'utf8'),
      );
      expect(written).toEqual(summarizeVitestReport(report, `${root}${sep}`));
      expect(written).toMatchObject({ success: true, testFiles: [...REQUIRED_PINNED_FILES] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes the summary of a failed run for diagnosis, and fails', () => {
    const { root, script, out } = checkout();
    try {
      const report = nativeReport(root);
      (report.testResults[0] as RawFile).assertionResults[0] = { status: 'failed' };
      writeFileSync(join(out, 'vitest-pinned.json'), JSON.stringify(report));
      const { code, output } = runScript(script);
      expect(code).toBe(1);
      expect(output).toContain('1 tests failed');
      const written: unknown = JSON.parse(
        readFileSync(join(out, 'pinned-test-summary.json'), 'utf8'),
      );
      expect(written).toMatchObject({ success: false, failed: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses to write an identity outside CI, names every missing variable, and prints no secret', () => {
    const target = join(REPOSITORY_ROOT, '.kadrion-out', 'ci-identity.json');
    const before = existsSync(target) ? readFileSync(target) : null;
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!/^(GITHUB|RUNNER|KADRION)_/.test(name)) env[name] = value;
    }
    env.GITHUB_TOKEN = 'kadrion-test-secret-token';
    env.ACTIONS_RUNTIME_TOKEN = 'kadrion-test-secret-runtime';
    const { code, output } = runScript(
      join(REPOSITORY_ROOT, 'tests', 'ci', 'write-ci-identity.ts'),
      env,
    );
    expect(code).toBe(1);
    expect(output).toContain('The CI identity cannot be written');
    for (const name of IDENTITY_ENV) expect(output).toContain(`${name} is not set`);
    expect(output).not.toContain('kadrion-test-secret');
    expect(existsSync(target) ? readFileSync(target) : null).toEqual(before);
  }, 60_000);
});
