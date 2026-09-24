/**
 * `node --experimental-strip-types tests/ci/write-pinned-summary.ts` (owner,
 * 2026-09-24): derives `.kadrion-out/pinned-test-summary.json` from the raw
 * report that `test:pinned` writes to `.kadrion-out/vitest-pinned.json`.
 *
 * A missing raw report — Vitest crashed before writing it — is an evidence
 * error: nothing is written, and the script fails. A summary whose rules fail is
 * still written, with `success: false`, for diagnosis, and the script fails too.
 * In GitHub Actions either failure also leaves
 * `.kadrion-out/diagnostics/pinned-test-summary.json` (`diagnostic.ts`), which is
 * never evidence.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeCiDiagnostic } from './diagnostic.ts';
import { pinnedSummaryProblems, summarizeVitestReport } from './pinned-summary.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const raw = join(root, '.kadrion-out', 'vitest-pinned.json');

if (!existsSync(raw)) {
  console.error(
    'There is no .kadrion-out/vitest-pinned.json: Vitest wrote no report. That is an evidence error, not an empty run.',
  );
  process.exitCode = 1;
  writeCiDiagnostic(root, 'pinned-test-summary', 'missing-raw-report', process.env);
} else {
  const summary = summarizeVitestReport(JSON.parse(readFileSync(raw, 'utf8')), root);
  writeFileSync(
    join(root, '.kadrion-out', 'pinned-test-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  const problems = pinnedSummaryProblems(summary);
  if (problems.length > 0) {
    console.error(`The pinned test run is not evidence:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
    writeCiDiagnostic(root, 'pinned-test-summary', 'summary-rules-failed', process.env);
  } else {
    console.log(
      `pinned-test-summary.json: ${String(summary.testFileCount)} files, ${String(summary.passed)} of ${String(summary.tests)} tests passed.`,
    );
  }
}
