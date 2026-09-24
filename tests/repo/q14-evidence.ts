/**
 * The evidence that may close Q14 (owner, 2026-09-24; docs/ci/first-run.md): a
 * structural record of one GitHub Actions run and of its `kadrion-reports`
 * artifact, checked against every criterion a machine can check.
 *
 * - The run, the job, and the steps come from the GitHub API.
 * - The artifact is recorded by its API id and digest, the SHA-256 of its zip,
 *   and the SHA-256 of every file in it.
 * - The texts of the files the checks read are carried verbatim, and each must
 *   hash to its entry.
 *
 * The files are bound to this run and this commit by three means:
 * - `ci-identity.json` names the commit, run, attempt, event, repository, and
 *   workflow, and it binds the other reports by hash;
 * - every time a report records lies within the run's start and end;
 * - the summary is derived again from the raw Vitest report and must be equal.
 *
 * The rest stays the owner's review: that the commit is the reviewed code, and
 * that the zip was downloaded from that run and attempt.
 *
 * No evidence exists while no run has passed. This module only states
 * what one must contain; it never creates one.
 */
import { createHash } from 'node:crypto';

import { FFMPEG_SHA256, FFPROBE_SHA256, PINNED_IMAGE } from '@kadrion/producer';

import { BOUND_REPORTS, ciIdentityProblems, type CiIdentity } from '../ci/ci-identity.js';
import {
  pinnedSummaryProblems,
  summarizeVitestReport,
  type PinnedTestSummary,
} from '../ci/pinned-summary.js';
import {
  PARITY_THRESHOLDS,
  recordProblems,
  type ParityRecord,
  type ParityRow,
} from '../parity/parity.js';

export const REPOSITORY = 'NoWitam/kadrian';
export const RUN_URL = /^https:\/\/github\.com\/NoWitam\/kadrian\/actions\/runs\/(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

/** The files of the artifact whose texts the evidence carries and the checks read. */
export const EVIDENCE_FILES = Object.freeze(['ci-identity.json', ...BOUND_REPORTS] as const);

/** Files that mark a failed gate: their presence refuses the evidence. */
export const FAILED_VARIANTS = Object.freeze([
  'golden-comparison.failed.json',
  'parity/parity-measurement.failed.json',
]);

/** The directory of the diagnostics of failed stages: anything in it refuses the evidence. */
export const DIAGNOSTICS = 'diagnostics';

export interface Q14Evidence {
  readonly evidenceVersion: 1;
  /** From the GitHub API of the run (`/actions/runs/<id>`). */
  readonly run: {
    readonly event: string;
    readonly htmlUrl: string;
    readonly headSha: string;
    readonly conclusion: string;
    readonly runAttempt: number;
    /** `run_started_at` and `updated_at` of that attempt. */
    readonly runStartedAt: string;
    readonly updatedAt: string;
  };
  /** The job `pinned` of that attempt (`/actions/runs/<id>/attempts/<n>/jobs`). */
  readonly job: { readonly name: string; readonly conclusion: string };
  /** The steps of that job. */
  readonly steps: readonly { readonly name: string; readonly conclusion: string }[];
  /** The artifact of the same run and attempt, as downloaded. */
  readonly artifact: {
    readonly name: string;
    /** The API id and digest of the artifact, and the SHA-256 of the downloaded zip. */
    readonly id: number;
    readonly digest: string;
    readonly zipSha256: string;
    /** Every file of the artifact, as a path inside it and the SHA-256 of its bytes. */
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
  };
  /** The texts of `EVIDENCE_FILES`, verbatim. */
  readonly contents: Readonly<Record<string, string>>;
}

/**
 * The step names a job of the workflow reports: a step's `name`, or GitHub's
 * default `Run <uses>` for an unnamed action step. The workflow has one job,
 * `pinned`; a second job would need its own list, not a merged one.
 */
export function requiredSteps(workflow: string): string[] {
  const names: string[] = [];
  const steps = workflow.slice(workflow.indexOf('\n    steps:\n'));
  for (const match of steps.matchAll(/^ {6}- (.*)$/gm)) {
    const start = match[1] ?? '';
    const named = /^name: (.+)$/.exec(start);
    const used = /^uses: (\S+)/.exec(start);
    if (named?.[1] !== undefined) names.push(named[1].trim());
    else if (used?.[1] !== undefined) names.push(`Run ${used[1]}`);
    else throw new Error(`A step of the workflow has neither a name nor uses: "${start}".`);
  }
  return names;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Everything that keeps `value` from being evidence that Q14 is closed. Empty when it is. */
export function q14EvidenceProblems(
  value: unknown,
  context: {
    readonly workflow: string;
    readonly golden: Parameters<typeof recordProblems>[1];
  },
): string[] {
  const evidence = value as Partial<Q14Evidence> | null;
  if (typeof evidence !== 'object' || evidence === null) return ['the evidence is not an object'];
  const problems: string[] = [];
  if (evidence.evidenceVersion !== 1) problems.push('evidenceVersion is not 1');

  // The run, the job, and the steps: GitHub's own metadata.
  const run = evidence.run;
  if (run?.event !== 'push') problems.push(`the run's event is ${String(run?.event)}, not push`);
  const runUrl = typeof run?.htmlUrl === 'string' ? RUN_URL.exec(run.htmlUrl) : null;
  if (runUrl === null) problems.push('the run URL is not a run of github.com/NoWitam/kadrian');
  if (typeof run?.headSha !== 'string' || !SHA.test(run.headSha)) {
    problems.push('the head SHA is not 40 hex digits');
  }
  if (run?.conclusion !== 'success') problems.push(`the run concluded ${String(run?.conclusion)}`);
  if (!Number.isSafeInteger(run?.runAttempt) || (run?.runAttempt ?? 0) < 1) {
    problems.push('the run attempt is not a positive integer');
  }
  const started = Date.parse(run?.runStartedAt ?? '');
  const ended = Date.parse(run?.updatedAt ?? '');
  if (Number.isNaN(started) || Number.isNaN(ended) || started > ended) {
    problems.push('the run has no start and end');
  }
  const within = (time: number): boolean =>
    !Number.isNaN(time) && !Number.isNaN(started) && time >= started && time <= ended;

  const job = evidence.job;
  if (job?.name !== 'pinned') problems.push('the job is not pinned');
  if (job?.conclusion !== 'success') problems.push(`the job concluded ${String(job?.conclusion)}`);
  const steps: readonly { name?: unknown; conclusion?: unknown }[] = Array.isArray(evidence.steps)
    ? (evidence.steps as readonly { name?: unknown; conclusion?: unknown }[])
    : [];
  for (const name of requiredSteps(context.workflow)) {
    const step = steps.find((candidate) => candidate.name === name);
    if (step === undefined) problems.push(`the step "${name}" is missing`);
    else if (step.conclusion !== 'success') {
      problems.push(`the step "${name}" concluded ${String(step.conclusion)}`);
    }
  }

  // The artifact: its files, their hashes, and the texts the checks read.
  const artifact = evidence.artifact;
  if (artifact?.name !== 'kadrion-reports') problems.push('the artifact is not kadrion-reports');
  if (!Number.isSafeInteger(artifact?.id) || (artifact?.id ?? 0) < 1) {
    problems.push('the artifact has no API id');
  }
  if (typeof artifact?.digest !== 'string' || !HASH.test(artifact.digest)) {
    problems.push('the artifact has no API digest');
  }
  if (typeof artifact?.zipSha256 !== 'string' || !HASH.test(artifact.zipSha256)) {
    problems.push('the artifact has no zip SHA-256');
  }
  const files: readonly { path: string; sha256: string }[] = Array.isArray(artifact?.files)
    ? (artifact.files as readonly { path: string; sha256: string }[])
    : [];
  const hashOf = new Map(files.map((file) => [file.path, file.sha256]));
  if (hashOf.size !== files.length) problems.push('the artifact lists a path twice');
  const contents = evidence.contents ?? {};
  for (const path of EVIDENCE_FILES) {
    if (!hashOf.has(path)) problems.push(`the artifact has no ${path}`);
    const text = contents[path];
    if (typeof text !== 'string') problems.push(`the evidence does not carry ${path}`);
    else if (sha256(text) !== hashOf.get(path)) problems.push(`${path} does not hash to its entry`);
  }
  for (const path of FAILED_VARIANTS) {
    if (hashOf.has(path)) problems.push(`the artifact has ${path}`);
  }
  // A diagnostic of a failed stage (tests/ci/diagnostic.ts) is never evidence,
  // wherever a path puts the directory (`./diagnostics/…`, `/diagnostics/…`)
  // and in any letter case.
  for (const { path } of files as readonly { path?: unknown }[]) {
    if (
      typeof path === 'string' &&
      path
        .replaceAll('\\', '/')
        .split('/')
        .some((segment) => segment.toLowerCase() === DIAGNOSTICS)
    ) {
      problems.push(`the artifact has the diagnostic ${path} of a failed stage`);
    }
  }

  // The identity: which run and commit wrote these files.
  const identity = parse(contents['ci-identity.json']) as Partial<CiIdentity> | undefined;
  for (const problem of ciIdentityProblems(identity)) problems.push(`identity: ${problem}`);
  if (identity?.commitSha !== run?.headSha) {
    problems.push("the identity's commitSha is not the run's head SHA");
  }
  if (runUrl !== null && String(identity?.runId) !== runUrl[1]) {
    problems.push("the identity's runId is not the run's");
  }
  if (identity?.runAttempt !== run?.runAttempt) {
    problems.push("the identity's runAttempt is not the run's attempt");
  }
  if (identity?.eventName !== run?.event) {
    problems.push("the identity's eventName is not the run's event");
  }
  if (identity?.repository !== REPOSITORY) {
    problems.push(`the identity's repository is not ${REPOSITORY}`);
  }
  if (
    typeof identity?.workflowRef !== 'string' ||
    !identity.workflowRef.startsWith(`${REPOSITORY}/.github/workflows/ci.yml@`)
  ) {
    problems.push("the identity's workflowRef is not this repository's ci.yml");
  }
  if (identity?.workflowSha256 !== sha256(context.workflow)) {
    problems.push('the identity names another workflow file than the committed one');
  }
  if (identity?.pinnedImage !== PINNED_IMAGE) problems.push('the identity names another image');
  if (identity?.ffmpegSha256 !== FFMPEG_SHA256 || identity.ffprobeSha256 !== FFPROBE_SHA256) {
    problems.push('the identity names another FFmpeg build than D29.1');
  }
  if (!within(Date.parse(identity?.generatedAt ?? ''))) {
    problems.push("the identity was generated outside the run's time");
  }
  for (const path of BOUND_REPORTS) {
    if (identity?.reports?.[path] !== hashOf.get(path)) {
      problems.push(`${path} is not the one the identity bound`);
    }
  }

  // The pinned test run: the summary, derived again from the raw report.
  const raw = parse(contents['vitest-pinned.json']) as
    { startTime?: unknown; testResults?: { endTime?: unknown }[] } | undefined;
  const summary = parse(contents['pinned-test-summary.json']) as
    Partial<PinnedTestSummary> | undefined;
  for (const problem of pinnedSummaryProblems(summary)) problems.push(`summary: ${problem}`);
  try {
    const derived = summarizeVitestReport(raw, summary?.root ?? '');
    if (JSON.stringify(derived) !== JSON.stringify(summary)) {
      problems.push('the summary is not the one derived from vitest-pinned.json');
    }
  } catch (reason) {
    problems.push(
      `vitest-pinned.json: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  }
  const times = [raw?.startTime, ...(raw?.testResults ?? []).map((file) => file.endTime)];
  if (!times.every((time) => typeof time === 'number' && within(time))) {
    problems.push("the Vitest report has times outside the run's time");
  }

  // The parity gate (D33, D34).
  const record = parse(contents['parity/parity-measurement.json']) as
    Partial<ParityRecord> | undefined;
  for (const problem of recordProblems(record, context.golden, { reference: false })) {
    problems.push(`parity record: ${problem}`);
  }
  if (record?.gate !== true) problems.push('the parity record is not gated');
  if ((record?.environment as { image?: unknown } | undefined)?.image !== PINNED_IMAGE) {
    problems.push('the parity record was not measured in the pinned image');
  }
  if (JSON.stringify(record?.thresholds) !== JSON.stringify(PARITY_THRESHOLDS)) {
    problems.push('the parity record does not carry the thresholds 0/0 of D34.1');
  }
  const rows: readonly Partial<ParityRow>[] = Array.isArray(record?.rows)
    ? (record.rows as readonly Partial<ParityRow>[])
    : [];
  if (rows.length === 0) problems.push('the parity record has no rows');
  for (const row of rows) {
    if (row.differingPixels !== 0 || row.maxChannelDifference !== 0) {
      problems.push(`parity row ${String(row.timeUs)} is not 0/0`);
    }
  }
  if (record?.playerDistTreeSha256 !== identity?.playerDistTreeSha256) {
    problems.push('the parity record measured another Player dist tree than the identity names');
  }
  if (record?.reference?.runtimeHash !== identity?.runtimeArtifactSha256) {
    problems.push('the parity record measured another runtime artifact than the identity names');
  }

  // The golden frames (D26.5).
  const golden = parse(contents['golden-comparison.json']) as
    | {
        environment?: { pinned?: unknown; image?: unknown };
        goldens?: unknown;
        report?: {
          timeUs?: unknown;
          difference?: { differingPixels?: unknown; maxChannelDifference?: unknown } | null;
        }[];
      }
    | undefined;
  if (golden?.environment?.pinned !== true) problems.push('golden-comparison.json is not pinned');
  if (golden?.environment?.image !== PINNED_IMAGE) {
    problems.push('golden-comparison.json was not made in the pinned image');
  }
  if (golden?.goldens !== true) problems.push('golden-comparison.json had no golden frames');
  const report = Array.isArray(golden?.report) ? golden.report : [];
  if (
    JSON.stringify(report.map((entry) => entry.timeUs)) !==
    JSON.stringify(context.golden.timestamps)
  ) {
    problems.push('golden-comparison.json does not cover the golden timestamps');
  }
  for (const entry of report) {
    if (
      entry.difference === null ||
      entry.difference === undefined ||
      entry.difference.differingPixels !== 0 ||
      entry.difference.maxChannelDifference !== 0
    ) {
      problems.push(`golden frame ${String(entry.timeUs)} differs or was not compared`);
    }
  }

  // The export (P5): it ran pinned, compared the golden frames, and used the observed FFmpeg.
  const exported = parse(contents['export-report.json']) as
    | {
        pinned?: unknown;
        goldens?: unknown;
        goldenFramesCompared?: unknown;
        ffmpeg?: { ffmpegSha256?: unknown; ffprobeSha256?: unknown };
      }
    | undefined;
  if (
    exported?.pinned !== true ||
    exported.goldens !== true ||
    exported.goldenFramesCompared !== true
  ) {
    problems.push('the export did not run pinned against the golden frames');
  }
  if (
    exported?.ffmpeg?.ffmpegSha256 !== identity?.ffmpegSha256 ||
    exported?.ffmpeg?.ffprobeSha256 !== identity?.ffprobeSha256
  ) {
    problems.push('the export used another FFmpeg than the identity names');
  }
  return problems;
}
