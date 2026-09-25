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
 * No evidence exists until a green run of the reviewed commit and its artifact
 * have been checked. This module only states
 * what one must contain; it never creates one.
 */
import { createHash } from 'node:crypto';

import { FFMPEG_SHA256, FFPROBE_SHA256, PINNED_IMAGE } from '@kadrion/producer';

import {
  BOUND_REPORTS,
  ciIdentityProblems,
  WORKFLOW_PATH,
  type CiIdentity,
} from '../ci/ci-identity.js';
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

/**
 * The repository the evidence must come from (owner, 2026-09-24: it was renamed
 * from `NoWitam/kadrian`). GitHub treats owner and repository names without
 * case, so they alone are compared without case (PR-15); the host, the workflow
 * path, the ref, and the run ID are compared exactly.
 */
export const REPOSITORY = 'NoWitam/Kadrian';
/** A run on github.com over https: owner, repository, and run ID. */
export const RUN_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)$/;
/** An owner or repository name: ASCII only, so no other letter can lower-case into it. */
const NAME = /^[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * Whether `name` is `owner/repository` of `REPOSITORY`: exactly two ASCII
 * segments, each equal to its counterpart without case.
 */
export function sameRepository(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const segments = name.split('/');
  const expected = REPOSITORY.split('/');
  return (
    segments.length === expected.length &&
    segments.every(
      (segment, at) => NAME.test(segment) && segment.toLowerCase() === expected[at]?.toLowerCase(),
    )
  );
}

/** Whether `text` names a run of this repository by its URL (for the status in the docs). */
export function namesRunOfRepository(text: string): boolean {
  return [
    ...text.matchAll(/https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/\d+/g),
  ].some((match) => sameRepository(`${match[1] ?? ''}/${match[2] ?? ''}`));
}

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
  const runMatch = typeof run?.htmlUrl === 'string' ? RUN_URL.exec(run.htmlUrl) : null;
  const runUrl =
    runMatch !== null && sameRepository(`${runMatch[1] ?? ''}/${runMatch[2] ?? ''}`)
      ? runMatch
      : null;
  if (runUrl === null) problems.push(`the run URL is not a run of github.com/${REPOSITORY}`);
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
  if (runUrl !== null && String(identity?.runId) !== runUrl[3]) {
    problems.push("the identity's runId is not the run's");
  }
  if (identity?.runAttempt !== run?.runAttempt) {
    problems.push("the identity's runAttempt is not the run's attempt");
  }
  if (identity?.eventName !== run?.event) {
    problems.push("the identity's eventName is not the run's event");
  }
  if (!sameRepository(identity?.repository)) {
    problems.push(`the identity's repository is not ${REPOSITORY}`);
  }
  // `owner/repository/<workflow path>@<ref>`, split at the first @: owner and
  // repository without case, the path and the ref exactly as they are.
  const workflowRef = typeof identity?.workflowRef === 'string' ? identity.workflowRef : '';
  const at = workflowRef.indexOf('@');
  const [owner = '', repository = '', ...path] = (at < 0 ? '' : workflowRef.slice(0, at)).split(
    '/',
  );
  if (at < 0 || !sameRepository(`${owner}/${repository}`) || path.join('/') !== WORKFLOW_PATH) {
    problems.push("the identity's workflowRef is not this repository's ci.yml");
  } else {
    const ref = workflowRef.slice(at + 1);
    if (ref === '') problems.push("the identity's workflowRef names no ref");
    else if (ref !== identity?.ref) {
      problems.push("the identity's workflowRef names another ref than the identity's ref");
    }
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

// --- the evidence file: complete and consistent (closing Q14, 2026-09-25) ---

/** The top-level keys of `docs/ci/q14-evidence.json`, exactly. */
export const EVIDENCE_KEYS = Object.freeze([
  'evidenceVersion',
  'run',
  'job',
  'steps',
  'artifact',
  'contents',
  'verification',
]);

/** The files the pinned run leaves in `.kadrion-out`, which the artifact holds, sorted. */
export const ARTIFACT_FILES = Object.freeze([
  'ci-identity.json',
  'custom-html-netlog.json',
  'custom-html-probes.json',
  'export-memory.json',
  'export-report.json',
  'exports/video-1080p.mp4',
  'exports/video-720p.mp4',
  'golden-comparison.json',
  'parity/parity-measurement.json',
  'pinned-test-summary.json',
  'presentation-barrier.json',
  'producer-processes.json',
  'vitest-pinned.json',
]);

/** The keys of the verification record, exactly. */
export const VERIFICATION_KEYS = Object.freeze([
  'validatedCommit',
  'runId',
  'runAttempt',
  'runUrl',
  'event',
  'artifactId',
  'zipSha256',
  'validator',
  'verifiedOn',
  'problems',
  'criteria',
  'closingCommit',
  'ownerReview',
]);

/**
 * The eight criteria of the owner, word for word, from the numbered list of
 * first-run.md: an item wrapped over indented lines is one criterion. A list
 * numbered other than 1, 2, 3, … yields no criteria.
 */
export function criteriaOf(firstRun: string): string[] {
  const start = firstRun.indexOf('\n## When Q14 may close');
  const end = firstRun.indexOf('\n## ', start + 1);
  const list = start < 0 ? '' : firstRun.slice(start, end < 0 ? undefined : end);
  const items = [...list.matchAll(/^(\d+)\. (.+(?:\n {2,}\S.*)*)$/gm)];
  if (items.some((match, at) => match[1] !== String(at + 1))) return [];
  return items.map((match) => (match[2] ?? '').replace(/\n +/g, ' '));
}

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * What keeps `value` from being a complete and consistent evidence file,
 * beyond `q14EvidenceProblems`: exactly its keys and its six texts, the ZIP
 * hash equal to the API digest, every recorded step `success`, the files the
 * pinned run writes, and a verification record that agrees with the run, the
 * commit, and the artifact and names the eight criteria word for word, each
 * `pass`. The record states what was checked; it proves nothing on its own.
 */
export function q14EvidenceFileProblems(value: unknown, criteria: readonly string[]): string[] {
  const evidence = value as
    (Partial<Q14Evidence> & { verification?: Record<string, unknown> }) | null;
  if (typeof evidence !== 'object' || evidence === null) return ['the evidence is not an object'];
  const problems: string[] = [];
  if (!same(Object.keys(evidence).sort(), [...EVIDENCE_KEYS].sort())) {
    problems.push('the evidence has other keys than its format');
  }
  if (!same(Object.keys(evidence.contents ?? {}).sort(), [...EVIDENCE_FILES].sort())) {
    problems.push('the evidence carries other texts than the six it needs');
  }
  const run = evidence.run;
  const artifact = evidence.artifact;
  if (typeof artifact?.digest !== 'string' || artifact.digest !== artifact.zipSha256) {
    problems.push("the ZIP's SHA-256 is not the artifact's API digest");
  }
  const steps: readonly unknown[] = Array.isArray(evidence.steps) ? evidence.steps : [];
  const conclusionOf = (step: unknown): unknown =>
    (step as { conclusion?: unknown } | null)?.conclusion;
  if (steps.length === 0 || steps.some((step) => conclusionOf(step) !== 'success')) {
    problems.push('a recorded step did not conclude success');
  }
  const paths: unknown[] = Array.isArray(artifact?.files)
    ? artifact.files.map((file: unknown) => (file as { path?: unknown } | null)?.path)
    : [];
  if (!same([...paths].sort(), [...ARTIFACT_FILES])) {
    problems.push('the artifact holds other files than the pinned run writes');
  }
  const verification: unknown = evidence.verification;
  if (typeof verification !== 'object' || verification === null) {
    problems.push('the evidence has no verification record');
    return problems;
  }
  const record = verification as Record<string, unknown>;
  if (!same(Object.keys(record).sort(), [...VERIFICATION_KEYS].sort())) {
    problems.push('the verification record has other keys than its format');
  }
  const runUrl = typeof run?.htmlUrl === 'string' ? RUN_URL.exec(run.htmlUrl) : null;
  const runId = runUrl?.[3];
  const facts: [string, unknown, unknown][] = [
    ['validatedCommit', record.validatedCommit, run?.headSha],
    ['runId', record.runId, runId === undefined ? undefined : Number(runId)],
    ['runAttempt', record.runAttempt, run?.runAttempt],
    ['runUrl', record.runUrl, run?.htmlUrl],
    ['event', record.event, run?.event],
    ['artifactId', record.artifactId, artifact?.id],
    ['zipSha256', record.zipSha256, artifact?.zipSha256],
  ];
  for (const [name, recorded, actual] of facts) {
    if (actual === undefined || recorded !== actual) {
      problems.push(`the verification's ${name} is not the evidence's`);
    }
  }
  if (!Array.isArray(record.problems) || record.problems.length !== 0) {
    problems.push('the verification records problems');
  }
  const commit = typeof record.validatedCommit === 'string' ? record.validatedCommit : '';
  for (const name of ['validator', 'closingCommit'] as const) {
    const text = record[name];
    if (commit === '' || typeof text !== 'string' || !text.includes(commit)) {
      problems.push(`the verification's ${name} does not name the validated commit`);
    }
  }
  if (typeof record.verifiedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.verifiedOn)) {
    problems.push("the verification's verifiedOn is not a date");
  }
  const review = record.ownerReview as Record<string, unknown> | null | undefined;
  if (
    typeof review !== 'object' ||
    review === null ||
    !same(Object.keys(review).sort(), ['customHtml', 'download', 'reviewedCode']) ||
    Object.values(review).some((text) => typeof text !== 'string' || text === '')
  ) {
    problems.push("the verification's ownerReview is incomplete");
  }
  const recorded: readonly (Record<string, unknown> | null)[] = Array.isArray(record.criteria)
    ? (record.criteria as readonly (Record<string, unknown> | null)[])
    : [];
  if (criteria.length !== 8 || recorded.length !== criteria.length) {
    problems.push('the verification does not record the eight criteria');
  }
  recorded.forEach((criterion, at) => {
    if (
      criterion?.id !== at + 1 ||
      criterion.criterion !== criteria[at] ||
      criterion.result !== 'pass' ||
      typeof criterion.detail !== 'string' ||
      criterion.detail === ''
    ) {
      problems.push(`criterion ${String(at + 1)} of the verification is not the owner's, passed`);
    }
  });
  return problems;
}
