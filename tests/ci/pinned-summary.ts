/**
 * The Kadrion-owned summary of the pinned test run (owner, 2026-09-24): a
 * stable contract derived from the raw report of Vitest's `json` reporter
 * (`.kadrion-out/vitest-pinned.json`), and the rules that make it evidence.
 *
 * A count of zero skipped tests proves little on its own: a test file that was
 * never collected, failed to import, or had every test removed does not show up
 * as skipped. So the rules require the exact set of pinned test files, each
 * `passed`, without a load message, with at least one test, and every test
 * `passed`.
 *
 * Pure: node built-ins only, so that `write-pinned-summary.ts` can run it with
 * `node --experimental-strip-types`.
 */
import { posix, relative, sep } from 'node:path';

export const PINNED_SUMMARY_SCHEMA_VERSION = 1;

/** The pinned test files, sorted. `tests/ci/ci.test.ts` compares this list with the disk. */
export const REQUIRED_PINNED_FILES: readonly string[] = Object.freeze([
  'tests/pinned/custom-html.pinned.test.ts',
  'tests/pinned/editor.pinned.test.ts',
  'tests/pinned/export.pinned.test.ts',
  'tests/pinned/goldens.pinned.test.ts',
  'tests/pinned/parity.pinned.test.ts',
  'tests/pinned/player.pinned.test.ts',
  'tests/pinned/producer.pinned.test.ts',
]);

/** The file of the golden-frame test (D26.5) and of the parity test (D33, D34). */
export const GOLDEN_TEST_FILE = 'tests/pinned/producer.pinned.test.ts';
export const PARITY_TEST_FILE = 'tests/pinned/parity.pinned.test.ts';

export interface PinnedTestFile {
  readonly path: string;
  readonly status: string;
  /** The load or collection error Vitest reports for the file; empty when there is none. */
  readonly message: string;
  readonly tests: number;
  readonly passed: number;
}

export interface PinnedTestSummary {
  readonly schemaVersion: 1;
  /** The checkout the report's absolute paths are relative to, so the summary can be derived again anywhere. */
  readonly root: string;
  readonly testFileCount: number;
  /** Repository-relative POSIX paths, sorted. */
  readonly testFiles: readonly string[];
  readonly files: readonly PinnedTestFile[];
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  /** Skipped, and Vitest's other pending states (`only`, `run`, `queued`). */
  readonly skipped: number;
  readonly todo: number;
  /** The start of the run, as the reporter recorded it (ISO 8601). */
  readonly startedAt: string;
  /** The end of the last test (ISO 8601): not the end of the run. */
  readonly lastTestEndedAt: string;
  /** Every required condition of this summary, not the reporter's own `success`. */
  readonly success: boolean;
}

interface RawAssertion {
  readonly status?: unknown;
}

interface RawFile {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly message?: unknown;
  readonly startTime?: unknown;
  readonly endTime?: unknown;
  readonly assertionResults?: unknown;
}

export class PinnedSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinnedSummaryError';
  }
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PinnedSummaryError(`${what} is not a finite number.`);
  }
  return value;
}

/**
 * The summary of a raw Vitest JSON report. Throws when the report is not one:
 * a missing report is an evidence error, never an empty summary.
 */
export function summarizeVitestReport(raw: unknown, root: string): PinnedTestSummary {
  const report = raw as { startTime?: unknown; testResults?: unknown } | null;
  if (typeof report !== 'object' || report === null || !Array.isArray(report.testResults)) {
    throw new PinnedSummaryError('The Vitest report has no testResults.');
  }
  const startedAt = finite(report.startTime, 'startTime');
  let lastEnd = startedAt;
  const counts = { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  const files = (report.testResults as RawFile[]).map((file) => {
    if (typeof file.name !== 'string') throw new PinnedSummaryError('A test file has no name.');
    // A POSIX root (the CI container) stays POSIX even when the summary is derived again on Windows.
    const path = root.startsWith('/')
      ? posix.relative(root, file.name)
      : relative(root, file.name).split(sep).join(posix.sep);
    const assertions = Array.isArray(file.assertionResults)
      ? (file.assertionResults as RawAssertion[])
      : [];
    lastEnd = Math.max(lastEnd, finite(file.endTime, `endTime of ${path}`));
    let passed = 0;
    for (const assertion of assertions) {
      counts.tests += 1;
      if (assertion.status === 'passed') {
        passed += 1;
        counts.passed += 1;
      } else if (assertion.status === 'failed') counts.failed += 1;
      else if (assertion.status === 'todo') counts.todo += 1;
      // `skipped`, `pending`, and any status Vitest may add later.
      else counts.skipped += 1;
    }
    return {
      path,
      status: typeof file.status === 'string' ? file.status : 'unknown',
      message: typeof file.message === 'string' ? file.message : JSON.stringify(file.message ?? ''),
      tests: assertions.length,
      passed,
    };
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const testFiles = files.map((file) => file.path);
  const summary = {
    schemaVersion: PINNED_SUMMARY_SCHEMA_VERSION,
    root,
    testFileCount: files.length,
    testFiles,
    files,
    ...counts,
    startedAt: new Date(startedAt).toISOString(),
    lastTestEndedAt: new Date(lastEnd).toISOString(),
    success: false,
  } as const;
  return { ...summary, success: pinnedSummaryProblems({ ...summary, success: true }).length === 0 };
}

function count(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Everything that keeps a summary from being evidence of a complete, green pinned run. */
export function pinnedSummaryProblems(value: unknown): string[] {
  const summary = value as Partial<PinnedTestSummary> | null;
  if (typeof summary !== 'object' || summary === null) return ['the summary is not an object'];
  const problems: string[] = [];
  if (summary.schemaVersion !== PINNED_SUMMARY_SCHEMA_VERSION) {
    problems.push(`unsupported summary schemaVersion ${JSON.stringify(summary.schemaVersion)}`);
  }
  for (const field of ['tests', 'passed', 'failed', 'skipped', 'todo', 'testFileCount'] as const) {
    if (!count(summary[field])) problems.push(`${field} is not a non-negative integer`);
  }
  if (summary.failed !== 0) problems.push(`${String(summary.failed)} tests failed`);
  if (summary.skipped !== 0) problems.push(`${String(summary.skipped)} tests were skipped`);
  if (summary.todo !== 0) problems.push(`${String(summary.todo)} tests are todo`);
  if (
    (summary.passed ?? 0) + (summary.failed ?? 0) + (summary.skipped ?? 0) + (summary.todo ?? 0) !==
    summary.tests
  ) {
    problems.push('the counts do not add up to the number of tests');
  }
  if (summary.success !== true) problems.push('success is not true');
  const testFiles = Array.isArray(summary.testFiles) ? summary.testFiles : [];
  if (JSON.stringify(testFiles) !== JSON.stringify(REQUIRED_PINNED_FILES)) {
    problems.push(
      `the test files are ${JSON.stringify(testFiles)}, not exactly the seven pinned files`,
    );
  }
  if (summary.testFileCount !== testFiles.length) {
    problems.push('testFileCount is not the number of test files');
  }
  for (const required of [GOLDEN_TEST_FILE, PARITY_TEST_FILE]) {
    if (!testFiles.includes(required)) problems.push(`the run has no ${required}`);
  }
  const files: readonly PinnedTestFile[] = Array.isArray(summary.files)
    ? (summary.files as readonly PinnedTestFile[])
    : [];
  if (JSON.stringify(files.map((file) => file.path)) !== JSON.stringify(testFiles)) {
    problems.push('files and testFiles disagree');
  }
  for (const file of files) {
    if (file.status !== 'passed') problems.push(`${file.path} is ${file.status}`);
    if (file.message !== '') problems.push(`${file.path} reported: ${file.message}`);
    if (!(file.tests >= 1)) problems.push(`${file.path} has no tests`);
    if (file.passed !== file.tests) problems.push(`${file.path}: not every test passed`);
  }
  for (const field of ['startedAt', 'lastTestEndedAt'] as const) {
    const time = summary[field];
    if (typeof time !== 'string' || Number.isNaN(Date.parse(time))) {
      problems.push(`${field} is not a time`);
    }
  }
  return problems;
}
