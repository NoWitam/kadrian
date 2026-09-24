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
 * commit. While Q14 is open, the report and the first-run notes say plainly
 * that nothing was pushed and nothing ran. No evidence file exists for the
 * current state, and none is made up here: the validator is tested on
 * synthetic evidence built in this file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { FFMPEG_SHA256, FFPROBE_SHA256, PINNED_IMAGE } from '@kadrion/producer';
import { goldenTimestamps } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { REQUIRED_PINNED_FILES, summarizeVitestReport } from '../ci/pinned-summary.js';
import type { GoldenManifest } from '../parity/parity.js';

import { q14EvidenceProblems, requiredSteps, type Q14Evidence } from './q14-evidence.js';
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

  it('is closed only with evidence that passes every machine-checkable criterion', () => {
    if (!closed) return;
    expect(evidenceExists, 'docs/ci/q14-evidence.json').toBe(true);
    const evidence = readJson(...EVIDENCE) as Q14Evidence;
    expect(q14EvidenceProblems(evidence, context)).toEqual([]);
    const row = rowOf(spec, 'Q14');
    expect(row).toContain(evidence.run.htmlUrl);
    expect(row).toContain(evidence.run.headSha);
  });

  it('never keeps an evidence file that does not pass', () => {
    if (!evidenceExists) return;
    expect(q14EvidenceProblems(readJson(...EVIDENCE), context)).toEqual([]);
  });

  it('while open, says that nothing was pushed and no remote run or artifact exists', () => {
    if (closed) return;
    // The sections that state the status, not the whole files: a sentence
    // elsewhere (the Q14 row) must not stand in for one of these.
    for (const text of [section(report, '9. CI status'), statusSection(firstRun)]) {
      expect(text).toMatch(/first push (?:was|has) not been made/);
      expect(text).toMatch(/remote workflow (?:was not run|did not run|has not run)/);
      expect(text).toMatch(/No `kadrion-reports` artifact from CI exists/);
      expect(text).toMatch(/do not replace a run on a\s+GitHub runner/);
    }
    // The §11 row says the same in its own words.
    const row = rowOf(spec, 'Q14');
    expect(row).toMatch(/the first push has not been made/);
    expect(row).toMatch(/the remote workflow has not run/);
    expect(row).toMatch(/no CI artifact exists/);
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
      workflowRef: 'NoWitam/kadrian/.github/workflows/ci.yml@refs/heads/main',
      repository: 'NoWitam/kadrian',
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
      htmlUrl: 'https://github.com/NoWitam/kadrian/actions/runs/1',
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
      'repository is not NoWitam/kadrian',
    ],
    [
      'an identity of another workflow ref',
      (given) =>
        (given.identity.workflowRef = 'other/kadrian/.github/workflows/ci.yml@refs/heads/main'),
      'workflowRef',
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
