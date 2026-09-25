/**
 * Q14 closes only on the evidence of a real run on a GitHub runner (owner,
 * 2026-09-24; docs/ci/first-run.md). Every place that states the status of Q14
 * states one status, in bold. "Open" is accepted only in its fixed markers;
 * any other bold phrase there — "closed", "passed", but also "no longer
 * open" — is a claim that Q14 is closed, unless it is on a short list of
 * neutral phrases. A claim in plain text,
 * outside bold, is beyond what this guard can read: review covers it. A
 * statement that Q14 is closed needs
 * `docs/ci/q14-evidence.json`, which must pass `q14EvidenceProblems` — every
 * criterion a machine can check — and the §11 row must name its run and
 * commit. The evidence file exists exactly when Q14 is closed; it is complete
 * and consistent (`q14EvidenceFileProblems`), and every place that states the
 * status names its run, its commit, the file, and the artifact. A diagnostic
 * of a failed stage is never evidence, not even under the name of a report it
 * would stand in for. The evidence file was written from a real run and its
 * artifact (2026-09-25); the validator and the file checks are tested on
 * synthetic evidence built in this file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { FFMPEG_SHA256, FFPROBE_SHA256, PINNED_IMAGE } from '@kadrion/producer';
import { goldenTimestamps } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { ciDiagnostic } from '../ci/diagnostic.js';
import { REQUIRED_PINNED_FILES, summarizeVitestReport } from '../ci/pinned-summary.js';
import type { GoldenManifest } from '../parity/parity.js';

import {
  ARTIFACT_FILES,
  criteriaOf,
  namesRunOfRepository,
  q14EvidenceFileProblems,
  q14EvidenceProblems,
  requiredSteps,
  sameRepository,
  type Q14Evidence,
} from './q14-evidence.js';
import { readJson, readText, repoPath } from './repo.js';

/** The only bold phrases that say Q14 is open, one per place. */
const OPEN_MARKERS = [
  /^\*\*Still open after PR-\d+\*\*$/,
  /^\*\*Open\*\*$/,
  /^\*\*Status: Q14 is open\.\*\*$/,
  /^\*\*Q14 is open\.\*\*$/,
];
/** Bold phrases in a status statement that say nothing about its status. */
const NEUTRAL = ['**unverified**'];

function boldPhrases(text: string): string[] {
  return text.match(/\*\*[^*]+\*\*/g) ?? [];
}

/** Whether a statement claims that Q14 is open: a fixed marker and no other status phrase. */
function claimsOpen(text: string): boolean {
  return boldPhrases(text).some((phrase) => OPEN_MARKERS.some((marker) => marker.test(phrase)));
}

/**
 * Whether a statement claims anything else. An allowlist, not a list of status
 * words: every bold phrase that is neither an open marker nor known to be
 * neutral counts as a claim that Q14 is closed.
 */
function claimsClosed(text: string): boolean {
  return boldPhrases(text).some(
    (phrase) => !NEUTRAL.includes(phrase) && !OPEN_MARKERS.some((marker) => marker.test(phrase)),
  );
}

const EVIDENCE = ['docs', 'ci', 'q14-evidence.json'];
const MANIFEST = [
  'packages',
  'test-fixtures',
  'src',
  'golden-frames',
  'reference.golden-frames.json',
];

function rowOf(markdown: string, question: string): string {
  const row = markdown.split('\n').find((line) => line.startsWith(`| ${question} `));
  if (row === undefined) throw new Error(`No row ${question}.`);
  return row;
}

/** The section whose heading starts with `heading`, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}`);
  if (start < 0) throw new Error(`No section ${heading}.`);
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

function statusSection(markdown: string): string {
  return section(markdown, 'Status after');
}

const spec = readText('docs', 'spike', 'vertical-spike.md');
const report = readText('docs', 'spike', 'report.md');
const firstRun = readText('docs', 'ci', 'first-run.md');
const workflow = readText('.github', 'workflows', 'ci.yml');
const readme = readText('README.md');
const context = {
  workflow,
  golden: {
    manifest: readJson(...MANIFEST) as GoldenManifest,
    manifestSha256: `sha256:${createHash('sha256')
      .update(readFileSync(repoPath(...MANIFEST)))
      .digest('hex')}`,
    timestamps: goldenTimestamps.map(({ timeUs }) => timeUs),
    width: 1080,
    height: 1920,
  },
};

const statements: [string, string][] = [
  ['§11 Q14 row', rowOf(spec, 'Q14')],
  ['report Q14 row', rowOf(report, 'Q14')],
  ['first-run.md status', statusSection(firstRun)],
  ['report §9', section(report, '9. CI status')],
];
const closed = statements.some(([, text]) => claimsClosed(text) || !claimsOpen(text));
const evidenceExists = existsSync(repoPath(...EVIDENCE));

describe('the status of Q14', () => {
  it.each(statements)('states one status, open or closed, in the %s', (_, text) => {
    expect(claimsOpen(text) !== claimsClosed(text), text).toBe(true);
  });

  it('is the same everywhere', () => {
    expect(statements.map(([, text]) => claimsClosed(text))).toEqual(statements.map(() => closed));
  });

  it('is stated the same way in the README', () => {
    expect(/Q14\s+is\s+closed/.test(readme), 'README.md').toBe(closed);
    if (closed) expect(readme).not.toMatch(/Q14\s+(is|stays)\s+open/);
  });

  it('has an evidence file exactly when it is closed', () => {
    expect(evidenceExists, 'docs/ci/q14-evidence.json').toBe(closed);
  });

  it('is closed only with evidence that passes every machine-checkable criterion', () => {
    if (!closed) return;
    const evidence = readJson(...EVIDENCE) as Q14Evidence;
    expect(q14EvidenceProblems(evidence, context)).toEqual([]);
    // Every place that states the status names the run and the validated commit.
    const places: [string, string][] = [
      ['§11 Q14 row', rowOf(spec, 'Q14')],
      ['report §9', section(report, '9. CI status')],
      ['first-run.md status', statusSection(firstRun)],
    ];
    for (const [place, text] of places) {
      expect(text, place).toContain(evidence.run.htmlUrl);
      expect(text, place).toContain(evidence.run.headSha);
      expect(text, place).toContain('docs/ci/q14-evidence.json');
      expect(text, place).toContain(String(evidence.artifact.id));
    }
    for (const text of [section(report, '9. CI status'), statusSection(firstRun)]) {
      expect(text).toMatch(/do not replace a run on a\s+GitHub runner/);
    }
    // The README names the same evidence.
    expect(readme).toContain('docs/ci/q14-evidence.json');
  });

  it('never keeps an evidence file that does not pass', () => {
    if (!evidenceExists) return;
    expect(q14EvidenceProblems(readJson(...EVIDENCE), context)).toEqual([]);
  });

  it('keeps the evidence file complete and consistent', () => {
    if (!evidenceExists) return;
    expect(criteriaOf(firstRun)).toHaveLength(8);
    expect(q14EvidenceFileProblems(readJson(...EVIDENCE), criteriaOf(firstRun))).toEqual([]);
  });
});

// --- the validator, on synthetic evidence (never a file) --------------------

const ROOT = '/__w/kadrian/kadrian/';
const RUN_START = Date.parse('2026-10-01T10:00:00.000Z');
const RUN_END = Date.parse('2026-10-01T10:40:00.000Z');
const HEAD = '0123456789abcdef0123456789abcdef01234567';

function hash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** The parts of a green run, as objects; `assemble` turns them into consistent evidence. */
interface Parts {
  vitest: {
    startTime: number;
    success: boolean;
    testResults: {
      name: string;
      status: string;
      message: string;
      startTime: number;
      endTime: number;
      assertionResults: { status: string; title: string }[];
    }[];
  };
  golden: Record<string, unknown> & { report: { timeUs: number; difference: unknown }[] };
  record: Record<string, unknown> & { rows: Record<string, unknown>[] };
  exportReport: Record<string, unknown>;
  identity: Record<string, unknown> & { reports?: Record<string, string> };
}

function parts(): Parts {
  const record = readJson('docs', 'spike', 'parity-measurement.json') as Parts['record'];
  return {
    vitest: {
      startTime: RUN_START + 60_000,
      success: true,
      testResults: REQUIRED_PINNED_FILES.map((file, index) => ({
        name: `${ROOT}${file}`,
        status: 'passed',
        message: '',
        startTime: RUN_START + 60_000 + index * 1_000,
        endTime: RUN_START + 61_000 + index * 1_000,
        assertionResults: [{ status: 'passed', title: 'a test' }],
      })),
    },
    golden: {
      environment: { pinned: true, image: PINNED_IMAGE },
      goldens: true,
      report: context.golden.timestamps.map((timeUs) => ({
        timeUs,
        difference: {
          differingPixels: 0,
          totalPixels: 2_073_600,
          share: 0,
          maxChannelDifference: 0,
        },
      })),
      assetsServed: [],
    },
    record,
    exportReport: {
      pinned: true,
      goldens: true,
      goldenFramesCompared: true,
      ffmpeg: { ffmpegSha256: FFMPEG_SHA256, ffprobeSha256: FFPROBE_SHA256 },
    },
    identity: {
      schemaVersion: 1,
      generatedAt: new Date(RUN_START + 120_000).toISOString(),
      eventName: 'push',
      commitSha: HEAD,
      gitHead: HEAD,
      workflowSha: HEAD,
      ref: 'refs/heads/main',
      workflowRef: 'NoWitam/Kadrian/.github/workflows/ci.yml@refs/heads/main',
      repository: 'NoWitam/Kadrian',
      workflowPath: '.github/workflows/ci.yml',
      workflowSha256: hash(workflow),
      workflowSha256AtCommit: hash(workflow),
      runId: 1,
      runAttempt: 1,
      runner: { os: 'Linux', arch: 'X64', platform: 'linux', processArch: 'x64' },
      pinnedImage: PINNED_IMAGE,
      ffmpegSha256: FFMPEG_SHA256,
      ffprobeSha256: FFPROBE_SHA256,
      ffmpegVersion: 'ffmpeg version n8.1.3-20260921',
      ffprobeVersion: 'ffprobe version n8.1.3-20260921',
      encoders: { required: ['libx264', 'aac'], found: ['libx264', 'aac'], passed: true },
      fonts: [
        {
          id: 'asset-font',
          expectedSha256: `sha256:${'8'.repeat(64)}`,
          actualSha256: `sha256:${'8'.repeat(64)}`,
          passed: true,
        },
      ],
      fontVerificationPassed: true,
      playerDistTreeSha256: record.playerDistTreeSha256,
      runtimeArtifactSha256: (record.reference as { runtimeHash: string }).runtimeHash,
    },
  };
}

/**
 * Evidence whose files hash to their entries and whose identity binds the
 * reports, as a real run would give it. `summary` defaults to the summary
 * derived from `vitest`.
 */
function assemble(given: Parts, summaryOverride?: unknown): Q14Evidence {
  const texts: Record<string, string> = {
    'vitest-pinned.json': JSON.stringify(given.vitest),
    'pinned-test-summary.json': JSON.stringify(
      summaryOverride ?? summarizeVitestReport(given.vitest, ROOT),
    ),
    'golden-comparison.json': JSON.stringify(given.golden),
    'parity/parity-measurement.json': JSON.stringify(given.record),
    'export-report.json': JSON.stringify(given.exportReport),
  };
  const reports = Object.fromEntries(
    Object.entries(texts).map(([path, text]) => [path, hash(text)]),
  );
  texts['ci-identity.json'] = JSON.stringify({
    ...given.identity,
    reports: given.identity.reports ?? reports,
  });
  return {
    evidenceVersion: 1,
    run: {
      event: 'push',
      htmlUrl: 'https://github.com/NoWitam/Kadrian/actions/runs/1',
      headSha: HEAD,
      conclusion: 'success',
      runAttempt: 1,
      runStartedAt: new Date(RUN_START).toISOString(),
      updatedAt: new Date(RUN_END).toISOString(),
    },
    job: { name: 'pinned', conclusion: 'success' },
    steps: requiredSteps(workflow).map((name) => ({ name, conclusion: 'success' })),
    artifact: {
      name: 'kadrion-reports',
      id: 7,
      digest: `sha256:${'a'.repeat(64)}`,
      zipSha256: `sha256:${'b'.repeat(64)}`,
      files: [
        ...Object.entries(texts).map(([path, text]) => ({ path, sha256: hash(text) })),
        { path: 'custom-html-probes.json', sha256: `sha256:${'c'.repeat(64)}` },
      ],
    },
    contents: texts,
  };
}

type Draft = Record<string, unknown> & {
  run: Record<string, unknown>;
  job: Record<string, unknown>;
  steps: Record<string, unknown>[];
  artifact: Record<string, unknown> & { files: { path: string; sha256: string }[] };
  contents: Record<string, string>;
};

function problemsOf(evidence: unknown): string {
  return q14EvidenceProblems(evidence, context).join(' | ');
}

/** Evidence built from edited parts: every hash and binding consistent, one fact wrong. */
function fromParts(edit: (given: Parts) => void, summaryOverride?: unknown): string {
  const given = parts();
  edit(given);
  return problemsOf(assemble(given, summaryOverride));
}

/** Evidence edited after assembly: a binding broken on purpose. */
function edited(edit: (draft: Draft) => void): string {
  const draft = structuredClone(assemble(parts())) as unknown as Draft;
  edit(draft);
  return problemsOf(draft);
}

describe('q14EvidenceProblems', () => {
  it('names the steps of the workflow, with the default name of the unnamed checkout', () => {
    expect(requiredSteps(workflow)).toEqual([
      'Run actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
      'Environment',
      'Install',
      'Check',
      'Pinned FFmpeg',
      'Browser and export tests in the pinned environment',
      'Pinned test summary',
      'CI identity',
      'Reports',
    ]);
  });

  it('refuses a workflow step that has neither a name nor uses, instead of dropping it', () => {
    const unnamed = workflow.replace(
      '      - name: Environment\n        run:',
      '      - run: echo unnamed\n      - name: Environment\n        run:',
    );
    expect(unnamed).not.toBe(workflow);
    expect(() => requiredSteps(unnamed)).toThrow(/neither a name nor uses/);
  });

  it('accepts evidence of a green, gated, bound run (the premise of every refusal below)', () => {
    expect(problemsOf(assemble(parts()))).toBe('');
  });

  it('refuses only the diagnostics directory, not a file whose name merely resembles it', () => {
    expect(
      edited((draft) =>
        draft.artifact.files.push({
          path: 'diagnostic-notes.txt',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      ),
    ).toBe('');
  });

  // The run, the job, the steps, and the artifact: GitHub's metadata.
  it.each<[string, (draft: Draft) => void, string]>([
    ['a pull_request run', (draft) => (draft.run.event = 'pull_request'), 'not push'],
    [
      'a run of another repository',
      (draft) => (draft.run.htmlUrl = 'https://github.com/other/kadrian/actions/runs/1'),
      'run URL',
    ],
    [
      'a short head SHA',
      (draft) => (draft.run.headSha = '0123456'),
      'the head SHA is not 40 hex digits',
    ],
    [
      'another evidence version',
      (draft) => (draft.evidenceVersion = 2),
      'evidenceVersion is not 1',
    ],
    ['a failed run', (draft) => (draft.run.conclusion = 'failure'), 'concluded failure'],
    ['no attempt', (draft) => (draft.run.runAttempt = 0), 'run attempt'],
    ['no start and end', (draft) => (draft.run.runStartedAt = 'soon'), 'no start and end'],
    ['another job', (draft) => (draft.job.name = 'lint'), 'the job is not pinned'],
    ['a failed job', (draft) => (draft.job.conclusion = 'failure'), 'the job concluded failure'],
    [
      'a skipped pinned step',
      (draft) => ((draft.steps[5] as Record<string, unknown>).conclusion = 'skipped'),
      'concluded skipped',
    ],
    ['a missing step', (draft) => draft.steps.splice(3, 1), 'the step "Check" is missing'],
    [
      'a skipped evidence step',
      (draft) => ((draft.steps[7] as Record<string, unknown>).conclusion = 'skipped'),
      'the step "CI identity" concluded skipped',
    ],
    ['another artifact', (draft) => (draft.artifact.name = 'other'), 'not kadrion-reports'],
    ['no artifact id', (draft) => delete draft.artifact.id, 'no API id'],
    ['no artifact digest', (draft) => (draft.artifact.digest = ''), 'no API digest'],
    ['no zip hash', (draft) => (draft.artifact.zipSha256 = 'x'), 'no zip SHA-256'],
    [
      'a path listed twice',
      (draft) =>
        draft.artifact.files.push({
          ...(draft.artifact.files[0] as { path: string; sha256: string }),
        }),
      'lists a path twice',
    ],
    [
      'a failed golden comparison in the artifact',
      (draft) =>
        draft.artifact.files.push({
          path: 'golden-comparison.failed.json',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      'golden-comparison.failed.json',
    ],
    [
      'a failed parity record in the artifact',
      (draft) =>
        draft.artifact.files.push({
          path: 'parity/parity-measurement.failed.json',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      'parity-measurement.failed.json',
    ],
    [
      'a diagnostic of a failed stage in the artifact',
      (draft) =>
        draft.artifact.files.push({
          path: 'diagnostics/pinned-ffmpeg.json',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      'the artifact has the diagnostic diagnostics/pinned-ffmpeg.json of a failed stage',
    ],
    [
      'a diagnostic in a subdirectory, of another type',
      (draft) =>
        draft.artifact.files.push({
          path: 'diagnostics/sub/notes.txt',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      'the diagnostic diagnostics/sub/notes.txt',
    ],
    [
      'a diagnostic in a directory of other letter case',
      (draft) =>
        draft.artifact.files.push({
          path: 'Diagnostics/pinned-ffmpeg.json',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      'the diagnostic Diagnostics/pinned-ffmpeg.json',
    ],
    [
      'a diagnostic behind a leading ./',
      (draft) =>
        draft.artifact.files.push({
          path: './diagnostics/ci-identity.json',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      'the diagnostic ./diagnostics/ci-identity.json',
    ],
    [
      'a diagnostic behind a leading /',
      (draft) =>
        draft.artifact.files.push({
          path: '/diagnostics/ci-identity.json',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      'the diagnostic /diagnostics/ci-identity.json',
    ],
    [
      'a diagnostic listed with a Windows separator',
      (draft) =>
        draft.artifact.files.push({
          path: 'diagnostics\\ci-identity.json',
          sha256: `sha256:${'d'.repeat(64)}`,
        }),
      'of a failed stage',
    ],
    [
      'no ci-identity.json',
      (draft) => delete draft.contents['ci-identity.json'],
      'does not carry ci-identity.json',
    ],
    [
      'no vitest report in the artifact',
      (draft) =>
        (draft.artifact.files = draft.artifact.files.filter(
          (file) => file.path !== 'vitest-pinned.json',
        )),
      'the artifact has no vitest-pinned.json',
    ],
    [
      'a text that does not hash to its entry',
      (draft) =>
        (draft.contents['export-report.json'] = `${draft.contents['export-report.json'] ?? ''} `),
      'export-report.json does not hash to its entry',
    ],
    [
      'a report swapped in after the identity was written',
      (draft) => {
        const text = JSON.stringify({
          ...(JSON.parse(draft.contents['golden-comparison.json'] ?? '{}') as object),
          note: 'another run',
        });
        draft.contents['golden-comparison.json'] = text;
        const entry = draft.artifact.files.find((file) => file.path === 'golden-comparison.json');
        if (entry !== undefined) entry.sha256 = hash(text);
      },
      'golden-comparison.json is not the one the identity bound',
    ],
  ])('refuses %s', (_, edit, problem) => {
    expect(edited(edit)).toContain(problem);
  });

  // The identity, the reports, and the times: consistent hashes, one fact wrong.
  it.each<[string, (given: Parts) => void, string]>([
    [
      'an identity of another commit',
      (given) => {
        given.identity.commitSha = 'f'.repeat(40);
        given.identity.gitHead = 'f'.repeat(40);
        given.identity.workflowSha = 'f'.repeat(40);
      },
      "commitSha is not the run's head SHA",
    ],
    ['an identity of another run', (given) => (given.identity.runId = 2), "runId is not the run's"],
    [
      'an identity of another attempt',
      (given) => (given.identity.runAttempt = 2),
      "runAttempt is not the run's attempt",
    ],
    [
      'an identity of a pull_request event',
      (given) => (given.identity.eventName = 'pull_request'),
      "eventName is not the run's event",
    ],
    [
      'an identity of another repository',
      (given) => (given.identity.repository = 'other/kadrian'),
      "the identity's repository is not NoWitam/Kadrian",
    ],
    [
      'an identity of another workflow ref',
      (given) =>
        (given.identity.workflowRef = 'other/kadrian/.github/workflows/ci.yml@refs/heads/main'),
      "the identity's workflowRef is not this repository's ci.yml",
    ],
    [
      'an identity of another workflow file',
      (given) => {
        given.identity.workflowSha256 = hash('other');
        given.identity.workflowSha256AtCommit = hash('other');
      },
      'another workflow file',
    ],
    [
      'an identity of another image',
      (given) => (given.identity.pinnedImage = 'image@sha256:other'),
      'another image',
    ],
    [
      'an identity of another FFmpeg',
      (given) => (given.identity.ffmpegSha256 = `sha256:${'e'.repeat(64)}`),
      'another FFmpeg build',
    ],
    [
      'an identity generated after the run',
      (given) => (given.identity.generatedAt = new Date(RUN_END + 1).toISOString()),
      'generated outside',
    ],
    [
      'an identity with a failed font',
      (given) => {
        given.identity.fontVerificationPassed = false;
      },
      'identity: fontVerificationPassed',
    ],
    [
      'a Vitest report from before the run',
      (given) => (given.vitest.startTime = RUN_START - 1),
      'times outside',
    ],
    [
      'a skipped pinned test',
      (given) =>
        ((given.vitest.testResults[2]?.assertionResults[0] as { status: string }).status =
          'skipped'),
      'summary: 1 tests were skipped',
    ],
    [
      'a pinned file that failed to import',
      (given) => {
        const file = given.vitest.testResults[4];
        if (file !== undefined) {
          file.status = 'failed';
          file.message = 'Cannot find module';
          file.assertionResults = [];
        }
      },
      'reported: Cannot find module',
    ],
    [
      'a pinned file that was not collected',
      (given) => given.vitest.testResults.splice(4, 1),
      'not exactly the seven',
    ],
    [
      'a pinned file without tests',
      (given) => {
        const file = given.vitest.testResults[0];
        if (file !== undefined) file.assertionResults = [];
      },
      'has no tests',
    ],
    [
      'a gated record with a differing row',
      (given) => ((given.record.rows[2] as Record<string, unknown>).maxChannelDifference = 3),
      'parity row 5000000 is not 0/0',
    ],
    [
      'a report-only parity record',
      (given) => {
        given.record.gate = false;
        given.record.thresholds = null;
      },
      'not gated',
    ],
    // Gated, 0/0, and well formed, but not measured against the committed golden
    // frames: only the checks of recordProblems (D33, D34.3) can see it.
    [
      'a parity record of other golden frames',
      (given) =>
        ((given.record.reference as Record<string, unknown>).goldenManifestSha256 =
          `sha256:${'0'.repeat(64)}`),
      'parity record: reference is',
    ],
    [
      'a parity record of another image',
      (given) =>
        ((given.record.environment as Record<string, unknown>).image = 'image@sha256:other'),
      'the parity record was not measured in the pinned image',
    ],
    [
      'a parity record with other thresholds',
      (given) => (given.record.thresholds = { differingPixels: 1, maxChannelDifference: 0 }),
      'does not carry the thresholds 0/0',
    ],
    [
      'a parity record without rows',
      (given) => (given.record.rows = []),
      'the parity record has no rows',
    ],
    [
      'a golden comparison of another image',
      (given) =>
        ((given.golden.environment as Record<string, unknown>).image = 'image@sha256:other'),
      'golden-comparison.json was not made in the pinned image',
    ],
    [
      'a golden comparison without golden frames',
      (given) => (given.golden.goldens = false),
      'golden-comparison.json had no golden frames',
    ],
    [
      'a golden comparison without a golden timestamp',
      (given) => given.golden.report.pop(),
      'does not cover the golden timestamps',
    ],
    [
      'a parity record of another Player build',
      (given) => (given.identity.playerDistTreeSha256 = `sha256:${'f'.repeat(64)}`),
      'another Player dist tree',
    ],
    [
      'a parity record of another runtime',
      (given) => (given.identity.runtimeArtifactSha256 = `sha256:${'f'.repeat(64)}`),
      'another runtime artifact',
    ],
    [
      'an unpinned golden comparison',
      (given) => ((given.golden.environment as Record<string, unknown>).pinned = false),
      'golden-comparison.json is not pinned',
    ],
    [
      'a golden frame not compared',
      (given) => ((given.golden.report[1] as { difference: unknown }).difference = null),
      'golden frame 2500000 differs or was not compared',
    ],
    [
      'an export that returned early',
      (given) => (given.exportReport.goldenFramesCompared = false),
      'the export did not run pinned',
    ],
    [
      'an export that did not run pinned',
      (given) => (given.exportReport.pinned = false),
      'the export did not run pinned',
    ],
    [
      'an export without golden frames',
      (given) => (given.exportReport.goldens = 'none'),
      'the export did not run pinned',
    ],
    [
      'an export with another FFmpeg',
      (given) =>
        (given.exportReport.ffmpeg = {
          ffmpegSha256: `sha256:${'e'.repeat(64)}`,
          ffprobeSha256: FFPROBE_SHA256,
        }),
      'the export used another FFmpeg',
    ],
  ])('refuses %s', (_, edit, problem) => {
    expect(fromParts(edit)).toContain(problem);
  });

  it('never takes a diagnostic for the identity or the summary it would stand in for', () => {
    const run = { GITHUB_SHA: HEAD, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };
    // Every file hashes to its entry and the identity binds them: only the content is wrong.
    const asIdentity = fromParts((given) => {
      given.identity = ciDiagnostic(
        'ci-identity',
        'identity-check-failed',
        run,
      ) as unknown as Parts['identity'];
    });
    expect(asIdentity).toContain('identity: unsupported identity schemaVersion');
    const asSummary = fromParts(
      () => undefined,
      ciDiagnostic('pinned-test-summary', 'missing-raw-report', run),
    );
    expect(asSummary).toContain('summary: unsupported summary schemaVersion');
    expect(asSummary).toContain('the summary is not the one derived from vitest-pinned.json');
  });

  it('refuses a raw report that is not a Vitest report, even beside a well-formed summary', () => {
    const summary = summarizeVitestReport(parts().vitest, ROOT);
    const problems = fromParts((given) => {
      (given as { vitest: unknown }).vitest = { startTime: RUN_START + 60_000 };
    }, summary);
    expect(problems).toContain('vitest-pinned.json: The Vitest report has no testResults.');
  });

  it('refuses a summary that is not the one derived from the raw report', () => {
    const given = parts();
    const derived = summarizeVitestReport(given.vitest, ROOT);
    const forged = { ...derived, lastTestEndedAt: new Date(RUN_START + 5_000).toISOString() };
    expect(problemsOf(assemble(given, forged))).toContain(
      'the summary is not the one derived from vitest-pinned.json',
    );
  });
});

// --- the repository of the run (PR-15) ---------------------------------------

/**
 * Evidence whose identity has `identity` merged in, and whose run has `htmlUrl`
 * when one is given: every hash and binding stays consistent.
 */
function repositoryProblems(identity: Record<string, unknown>, htmlUrl?: string): string {
  const given = parts();
  Object.assign(given.identity, identity);
  const evidence = assemble(given);
  const run = evidence.run as { htmlUrl: string };
  if (htmlUrl !== undefined) run.htmlUrl = htmlUrl;
  return problemsOf(evidence);
}

const RUN_1 = 'https://github.com/NoWitam/Kadrian/actions/runs/1';
const CI_YML = '.github/workflows/ci.yml';
const KELVIN = 'K';

describe('the repository of the run: owner and name without case, the workflow and its ref exactly (PR-15)', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['the canonical name everywhere', {}, RUN_1],
    [
      'the lower-case name everywhere',
      {
        repository: 'nowitam/kadrian',
        workflowRef: `nowitam/kadrian/${CI_YML}@refs/heads/main`,
      },
      'https://github.com/nowitam/kadrian/actions/runs/1',
    ],
    [
      'another letter case in every field',
      {
        repository: 'NOWITAM/KaDrIaN',
        workflowRef: `NoWitam/KADRIAN/${CI_YML}@refs/heads/main`,
      },
      'https://github.com/nowitam/Kadrian/actions/runs/1',
    ],
    [
      'the ref of the branch of PR-14',
      {
        ref: 'refs/heads/pr-14-ci-repair',
        workflowRef: `NoWitam/Kadrian/${CI_YML}@refs/heads/pr-14-ci-repair`,
      },
      RUN_1,
    ],
    [
      'the real run of PR-14',
      {
        runId: 36054995870,
        ref: 'refs/heads/pr-14-ci-repair',
        workflowRef: `NoWitam/Kadrian/${CI_YML}@refs/heads/pr-14-ci-repair`,
      },
      'https://github.com/NoWitam/Kadrian/actions/runs/36054995870',
    ],
    [
      'a ref that holds an @ on both sides',
      { ref: 'refs/heads/a@b', workflowRef: `NoWitam/Kadrian/${CI_YML}@refs/heads/a@b` },
      RUN_1,
    ],
  ])('accepts %s', (_, identity, htmlUrl) => {
    expect(repositoryProblems(identity, htmlUrl)).toBe('');
  });

  const URL_PROBLEM = 'the run URL is not a run of github.com/NoWitam/Kadrian';
  it.each([
    'https://github.com/Other/Kadrian/actions/runs/1',
    'https://github.com/NoWitam/Kadrion/actions/runs/1',
    'https://github.com/NoWitam/kadrian-fork/actions/runs/1',
    'https://github.com/ANoWitam/Kadrian/actions/runs/1',
    `https://github.com/NoWitam/${KELVIN}adrian/actions/runs/1`,
    'https://www.github.com/NoWitam/Kadrian/actions/runs/1',
    'http://github.com/NoWitam/Kadrian/actions/runs/1',
    'https://github.com.evil.example/NoWitam/Kadrian/actions/runs/1',
    'https://GitHub.com/NoWitam/Kadrian/actions/runs/1',
    'https://github.com/NoWitam/Kadrian/extra/actions/runs/1',
  ])('refuses the run URL %s', (htmlUrl) => {
    expect(repositoryProblems({}, htmlUrl)).toContain(URL_PROBLEM);
  });

  it.each([
    ['another run', 'https://github.com/NoWitam/Kadrian/actions/runs/2'],
    ['the same number written 01', 'https://github.com/NoWitam/Kadrian/actions/runs/01'],
  ])("refuses a run ID other than the identity's: %s", (_, htmlUrl) => {
    const problems = repositoryProblems({}, htmlUrl);
    expect(problems).toContain("the identity's runId is not the run's");
    expect(problems).not.toContain(URL_PROBLEM);
  });

  it.each([
    'Other/Kadrian',
    'NoWitam/Kadrion',
    'NoWitam/kadrian-fork',
    'ANoWitam/Kadrian',
    'NoWitam',
    'NoWitam/Kadrian/x',
    `NoWitam/${KELVIN}adrian`,
    ' NoWitam/Kadrian',
    'NoWitam/Kadrian ',
    'NoWitam/Kadrian\n',
    '',
    undefined,
    42,
  ])('refuses the repository %j', (repository) => {
    expect(repositoryProblems({ repository }, RUN_1)).toContain(
      "the identity's repository is not NoWitam/Kadrian",
    );
  });

  const WORKFLOW_PROBLEM = "the identity's workflowRef is not this repository's ci.yml";
  it.each([
    `Other/Kadrian/${CI_YML}@refs/heads/main`,
    `NoWitam/Kadrion/${CI_YML}@refs/heads/main`,
    `NoWitam/${KELVIN}adrian/${CI_YML}@refs/heads/main`,
    'NoWitam/Kadrian/.github/workflows/CI.yml@refs/heads/main',
    'NoWitam/Kadrian/.github/workflows/other.yml@refs/heads/main',
    'NoWitam/Kadrian/.GitHub/workflows/ci.yml@refs/heads/main',
    `NoWitam/Kadrian/sub/${CI_YML}@refs/heads/main`,
    `NoWitam/Kadrian/${CI_YML}`,
    ` NoWitam/Kadrian/${CI_YML}@refs/heads/main`,
    `@refs/heads/main`,
    '',
    undefined,
    42,
  ])('refuses the workflowRef %j', (workflowRef) => {
    expect(repositoryProblems({ workflowRef }, RUN_1)).toContain(WORKFLOW_PROBLEM);
  });

  const REF_PROBLEM = "the identity's workflowRef names another ref than the identity's ref";
  const NO_REF = "the identity's workflowRef names no ref";
  it.each<[string, Record<string, unknown>, string]>([
    ['another ref', { workflowRef: `NoWitam/Kadrian/${CI_YML}@refs/heads/other` }, REF_PROBLEM],
    [
      'a ref that differs only in letter case',
      { workflowRef: `NoWitam/Kadrian/${CI_YML}@refs/heads/MAIN` },
      REF_PROBLEM,
    ],
    [
      'a trailing space in the workflowRef',
      { workflowRef: `NoWitam/Kadrian/${CI_YML}@refs/heads/main ` },
      REF_PROBLEM,
    ],
    [
      'a leading space in the workflowRef',
      { workflowRef: `NoWitam/Kadrian/${CI_YML}@ refs/heads/main` },
      REF_PROBLEM,
    ],
    ["a trailing space in the identity's ref", { ref: 'refs/heads/main ' }, REF_PROBLEM],
    [
      'a second @ after the ref',
      { workflowRef: `NoWitam/Kadrian/${CI_YML}@refs/heads/main@evil` },
      REF_PROBLEM,
    ],
    ['an empty ref after the @', { workflowRef: `NoWitam/Kadrian/${CI_YML}@` }, NO_REF],
    ['an empty ref on both sides', { ref: '', workflowRef: `NoWitam/Kadrian/${CI_YML}@` }, NO_REF],
  ])('refuses %s', (_, identity, problem) => {
    const problems = repositoryProblems(identity, RUN_1);
    expect(problems).toContain(problem);
    expect(problems).not.toContain(WORKFLOW_PROBLEM);
  });

  it('compares owner and repository only, as ASCII segments, without case', () => {
    expect(sameRepository('NoWitam/Kadrian')).toBe(true);
    expect(sameRepository('nowitam/kadrian')).toBe(true);
    expect(sameRepository('NOWITAM/KADRIAN')).toBe(true);
    for (const name of [
      'NoWitam/Kadrion',
      'Other/Kadrian',
      'NoWitam',
      'NoWitam/Kadrian/x',
      '/Kadrian',
      'NoWitam/',
      `NoWitam/${KELVIN}adrian`,
      42,
      undefined,
    ]) {
      expect(sameRepository(name), String(name)).toBe(false);
    }
  });

  it('finds a run of this repository in a text, in the old and the new letter case', () => {
    expect(
      namesRunOfRepository('run https://github.com/NoWitam/kadrian/actions/runs/36009291627 (a)'),
    ).toBe(true);
    expect(namesRunOfRepository('run https://github.com/NoWitam/Kadrian/actions/runs/1.')).toBe(
      true,
    );
    for (const text of [
      'https://github.com/Other/Kadrian/actions/runs/1',
      'https://github.com/NoWitam/Kadrion/actions/runs/1',
      'https://www.github.com/NoWitam/Kadrian/actions/runs/1',
      'no run here',
    ]) {
      expect(namesRunOfRepository(text), text).toBe(false);
    }
  });
});

// --- the evidence file: complete and consistent (closing Q14) -----------------

const CRITERIA = criteriaOf(firstRun);

type EvidenceFile = Draft & { verification: Record<string, unknown> };

/** Synthetic evidence as the file holds it: the validator's parts and a verification record. */
function evidenceFile(): EvidenceFile {
  const evidence = structuredClone(assemble(parts())) as unknown as Draft;
  const listed = evidence.artifact.files;
  evidence.artifact.files = ARTIFACT_FILES.map(
    (path) =>
      listed.find((file) => file.path === path) ?? { path, sha256: `sha256:${'e'.repeat(64)}` },
  );
  const digest = evidence.artifact.digest as string;
  evidence.artifact.zipSha256 = digest;
  const verification = {
    validatedCommit: HEAD,
    runId: 1,
    runAttempt: 1,
    runUrl: RUN_1,
    event: 'push',
    artifactId: 7,
    zipSha256: digest,
    validator: `tests/repo/q14-evidence.ts at ${HEAD}`,
    verifiedOn: '2026-10-01',
    problems: [],
    criteria: CRITERIA.map((criterion, at) => ({
      id: at + 1,
      criterion,
      result: 'pass',
      detail: 'what showed it',
    })),
    closingCommit: `A later documentation commit; the evidence is of ${HEAD}.`,
    ownerReview: { reviewedCode: 'confirmed', download: 'checked', customHtml: 'reviewed' },
  };
  return Object.assign(evidence, { verification });
}

function criterionOf(file: EvidenceFile, at: number): Record<string, unknown> {
  return (file.verification.criteria as Record<string, unknown>[])[at] as Record<string, unknown>;
}

describe('the evidence file: complete and consistent', () => {
  it('reads the eight criteria of the owner from first-run.md, word for word', () => {
    expect(CRITERIA).toHaveLength(8);
    expect(CRITERIA[0]).toBe('The URL of the GitHub Actions run.');
    expect(CRITERIA[7]).toBe('The golden-frame gate of D26.5 passed too.');
    expect(criteriaOf('no such section')).toEqual([]);
  });

  it('reads a wrapped criterion whole, and no criteria from a list numbered otherwise', () => {
    const heading = '\n## When Q14 may close\n\n';
    expect(criteriaOf(`${heading}1. One\n   continued.\n2. Two.\n\n## Next\n3. Three.`)).toEqual([
      'One continued.',
      'Two.',
    ]);
    expect(criteriaOf(`${heading}1. One.\n3. Three.\n`)).toEqual([]);
    expect(criteriaOf(`${heading}2. Two.\n3. Three.\n`)).toEqual([]);
  });

  it('accepts a complete and consistent file (the premise of every refusal below)', () => {
    const file = evidenceFile();
    expect(q14EvidenceProblems(file, context)).toEqual([]);
    expect(q14EvidenceFileProblems(file, CRITERIA)).toEqual([]);
  });

  it.each<[string, (file: EvidenceFile) => void, string]>([
    ['an extra top-level key', (file) => (file.notes = 'x'), 'other keys than its format'],
    [
      'an extra carried text',
      (file) => (file.contents['custom-html-netlog.json'] = '{}'),
      'other texts than the six',
    ],
    [
      'a missing carried text',
      (file) => delete file.contents['export-report.json'],
      'other texts than the six',
    ],
    [
      'a ZIP hash other than the API digest',
      (file) => (file.artifact.zipSha256 = `sha256:${'b'.repeat(64)}`),
      "the ZIP's SHA-256 is not the artifact's API digest",
    ],
    [
      'a recorded step that was skipped',
      (file) => file.steps.push({ name: 'Post Run actions/checkout', conclusion: 'skipped' }),
      'a recorded step did not conclude success',
    ],
    ['no steps', (file) => file.steps.splice(0), 'a recorded step did not conclude success'],
    [
      'a step that is not an object',
      (file) => (file.steps as unknown[]).push(null),
      'a recorded step did not conclude success',
    ],
    [
      'a file entry that is not an object',
      (file) => (file.artifact.files as unknown[]).push(null),
      'other files than the pinned run writes',
    ],
    [
      'a file of the pinned run left out',
      (file) => file.artifact.files.splice(1, 1),
      'other files than the pinned run writes',
    ],
    [
      'an extra file',
      (file) =>
        file.artifact.files.push({ path: 'extra.json', sha256: `sha256:${'e'.repeat(64)}` }),
      'other files than the pinned run writes',
    ],
    [
      'no verification record',
      (file) => delete (file as Partial<EvidenceFile>).verification,
      'no verification record',
    ],
    [
      'an extra key in the record',
      (file) => (file.verification.note = 'x'),
      'the verification record has other keys than its format',
    ],
    [
      'another validated commit',
      (file) => (file.verification.validatedCommit = 'f'.repeat(40)),
      "the verification's validatedCommit is not the evidence's",
    ],
    [
      'another run ID',
      (file) => (file.verification.runId = 2),
      "the verification's runId is not the evidence's",
    ],
    [
      'the run ID as text',
      (file) => (file.verification.runId = '1'),
      "the verification's runId is not the evidence's",
    ],
    [
      'another attempt',
      (file) => (file.verification.runAttempt = 2),
      "the verification's runAttempt is not the evidence's",
    ],
    [
      'another run URL',
      (file) => (file.verification.runUrl = 'https://github.com/NoWitam/Kadrian/actions/runs/2'),
      "the verification's runUrl is not the evidence's",
    ],
    [
      'another event',
      (file) => (file.verification.event = 'pull_request'),
      "the verification's event is not the evidence's",
    ],
    [
      'another artifact',
      (file) => (file.verification.artifactId = 8),
      "the verification's artifactId is not the evidence's",
    ],
    [
      'another ZIP hash',
      (file) => (file.verification.zipSha256 = `sha256:${'c'.repeat(64)}`),
      "the verification's zipSha256 is not the evidence's",
    ],
    [
      'recorded problems',
      (file) => (file.verification.problems = ['something']),
      'the verification records problems',
    ],
    [
      'a validator of another commit',
      (file) => (file.verification.validator = 'tests/repo/q14-evidence.ts at main'),
      "the verification's validator does not name the validated commit",
    ],
    [
      'a closing note without the validated commit',
      (file) => (file.verification.closingCommit = 'A later commit.'),
      "the verification's closingCommit does not name the validated commit",
    ],
    [
      'no date',
      (file) => (file.verification.verifiedOn = 'today'),
      "the verification's verifiedOn is not a date",
    ],
    [
      'an owner review without the download',
      (file) => (file.verification.ownerReview = { reviewedCode: 'x', customHtml: 'z' }),
      "the verification's ownerReview is incomplete",
    ],
    [
      'an empty owner review entry',
      (file) =>
        (file.verification.ownerReview = { reviewedCode: '', download: 'y', customHtml: 'z' }),
      "the verification's ownerReview is incomplete",
    ],
    [
      'seven criteria',
      (file) => (file.verification.criteria as unknown[]).pop(),
      'the verification does not record the eight criteria',
    ],
    [
      'a criterion in other words',
      (file) => (criterionOf(file, 2).criterion = 'All steps are fine.'),
      "criterion 3 of the verification is not the owner's, passed",
    ],
    [
      'a criterion that failed',
      (file) => (criterionOf(file, 4).result = 'fail'),
      "criterion 5 of the verification is not the owner's, passed",
    ],
    [
      'criteria out of order',
      (file) => (file.verification.criteria as unknown[]).reverse(),
      "criterion 1 of the verification is not the owner's, passed",
    ],
    [
      'a criterion that is not an object',
      (file) => ((file.verification.criteria as unknown[])[5] = null),
      "criterion 6 of the verification is not the owner's, passed",
    ],
    [
      'a criterion under another number',
      (file) => (criterionOf(file, 0).id = 2),
      "criterion 1 of the verification is not the owner's, passed",
    ],
    [
      'a criterion without a detail',
      (file) => (criterionOf(file, 7).detail = ''),
      "criterion 8 of the verification is not the owner's, passed",
    ],
  ])('refuses %s', (_, edit, problem) => {
    const file = evidenceFile();
    edit(file);
    expect(q14EvidenceFileProblems(file, CRITERIA).join(' | ')).toContain(problem);
  });

  it('refuses a record checked against other than the eight criteria of the docs', () => {
    expect(q14EvidenceFileProblems(evidenceFile(), CRITERIA.slice(0, 7)).join(' | ')).toContain(
      'the verification does not record the eight criteria',
    );
    // Seven in the docs and seven in the record agree with each other, and are still refused.
    const seven = evidenceFile();
    (seven.verification.criteria as unknown[]).pop();
    expect(q14EvidenceFileProblems(seven, CRITERIA.slice(0, 7)).join(' | ')).toContain(
      'the verification does not record the eight criteria',
    );
  });
});
