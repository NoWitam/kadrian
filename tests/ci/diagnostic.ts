/**
 * The diagnostic of a failed CI stage (owner, 2026-09-24):
 * `.kadrion-out/diagnostics/<stage>.json`. The first run failed before any
 * report existed, so the artifact was never uploaded; a diagnostic says which
 * stage failed and why.
 *
 * It is never evidence. It says `"evidence": false`, and
 * `tests/repo/q14-evidence.ts` refuses an artifact that has anything under
 * `diagnostics/`. It carries only the stage, a fixed error code, and the
 * identity of the run, each value read by exact name and kept only if it has
 * its expected format. No message, no path, no other variable, and no secret.
 *
 * It is written only in GitHub Actions (`GITHUB_ACTIONS=true`). The root and
 * the environment are parameters: the entry scripts pass the checkout and
 * `process.env`, and the tests pass their own.
 *
 * Node built-ins only, for `--experimental-strip-types`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIAGNOSTIC_VERSION = 1;

/** Every stage that writes a diagnostic, with the codes it may report. */
export const DIAGNOSTIC_CODES = Object.freeze({
  'pinned-ffmpeg': Object.freeze([
    'download-failed',
    'archive-hash-mismatch',
    'no-decompressor',
    'extract-failed',
    'binary-hash-mismatch',
    'unexpected',
  ]),
  'pinned-test-summary': Object.freeze(['missing-raw-report', 'summary-rules-failed']),
  'ci-identity': Object.freeze(['identity-check-failed']),
} as const);

export type DiagnosticStage = keyof typeof DIAGNOSTIC_CODES;

export interface CiDiagnostic {
  readonly diagnosticVersion: 1;
  readonly kind: 'kadrion-ci-diagnostic';
  readonly evidence: false;
  readonly stage: DiagnosticStage;
  readonly errorType: string;
  readonly commitSha: string | null;
  readonly runId: number | null;
  readonly runAttempt: number | null;
  readonly workflowRef: string | null;
  readonly workflowSha: string | null;
}

export type DiagnosticEnv = Readonly<Record<string, string | undefined>>;

const COMMIT = /^[0-9a-f]{40}$/;
const WORKFLOW_REF =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/[A-Za-z0-9_./-]+$/;

function commit(value: string | undefined): string | null {
  return value !== undefined && COMMIT.test(value) ? value : null;
}

function positive(value: string | undefined): number | null {
  return value !== undefined && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : null;
}

/** The diagnostic of `stage`, from the named variables of `env` only. */
export function ciDiagnostic(
  stage: DiagnosticStage,
  errorType: string,
  env: DiagnosticEnv,
): CiDiagnostic {
  const codes: readonly string[] = DIAGNOSTIC_CODES[stage];
  if (!codes.includes(errorType)) {
    throw new Error(`"${errorType}" is not a diagnostic code of ${stage}.`);
  }
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  return {
    diagnosticVersion: DIAGNOSTIC_VERSION,
    kind: 'kadrion-ci-diagnostic',
    evidence: false,
    stage,
    errorType,
    commitSha: commit(env.GITHUB_SHA),
    runId: positive(env.GITHUB_RUN_ID),
    runAttempt: positive(env.GITHUB_RUN_ATTEMPT),
    workflowRef: workflowRef !== undefined && WORKFLOW_REF.test(workflowRef) ? workflowRef : null,
    workflowSha: commit(env.GITHUB_WORKFLOW_SHA),
  };
}

/**
 * Writes the diagnostic under `<root>/.kadrion-out/diagnostics/` when `env` is
 * GitHub Actions, and returns its path; elsewhere writes nothing and returns
 * `null`.
 */
export function writeCiDiagnostic(
  root: string,
  stage: DiagnosticStage,
  errorType: string,
  env: DiagnosticEnv,
): string | null {
  const diagnostic = ciDiagnostic(stage, errorType, env);
  if (env.GITHUB_ACTIONS !== 'true') return null;
  const directory = join(root, '.kadrion-out', 'diagnostics');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${stage}.json`);
  writeFileSync(path, `${JSON.stringify(diagnostic, null, 2)}\n`);
  return path;
}
