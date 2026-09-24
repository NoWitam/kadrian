/**
 * The pins of the render environment agree everywhere (D26): the exact
 * `playwright-core` version in every manifest and in the lockfile, the image of
 * CI and the constant of the Producer and the ADR, the image tag and the
 * Playwright version, and an install from the frozen lockfile. An upgrade has
 * to move all of them together.
 */
import { format } from 'prettier';
import { describe, expect, it } from 'vitest';

import { listDirs, packageDirs, readJson, readText } from './repo.js';

const VERSION = '1.63.0';
const IMAGE =
  'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27';

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifests: [string, Manifest][] = [
  ['package.json', readJson('package.json') as Manifest],
  ...packageDirs.map((dir): [string, Manifest] => [
    `packages/${dir}/package.json`,
    readJson('packages', dir, 'package.json') as Manifest,
  ]),
  ...listDirs('apps').map((dir): [string, Manifest] => [
    `apps/${dir}/package.json`,
    readJson('apps', dir, 'package.json') as Manifest,
  ]),
];

const declaring = manifests.flatMap(([file, manifest]) =>
  (['dependencies', 'devDependencies'] as const).flatMap((field) => {
    const range = manifest[field]?.['playwright-core'];
    return range === undefined ? [] : [`${file} ${field} ${range}`];
  }),
);

const workflow = readText('.github', 'workflows', 'ci.yml');
const producerPins = readText('packages', 'producer', 'src', 'environment.ts');

describe('the pinned render environment (D26)', () => {
  it('declares playwright-core exactly, at runtime in the Producer only', () => {
    expect(declaring).toEqual([
      `package.json devDependencies ${VERSION}`,
      `packages/producer/package.json dependencies ${VERSION}`,
    ]);
  });

  it('resolves exactly one playwright-core version in the lockfile', () => {
    const lock = readText('pnpm-lock.yaml');
    const versions = new Set(
      [...lock.matchAll(/playwright-core@(\d+\.\d+\.\d+)/g)].map((m) => m[1]),
    );
    expect([...versions]).toEqual([VERSION]);
  });

  it('runs CI in the pinned image, whose tag is the Playwright version', () => {
    const images = [...workflow.matchAll(/mcr\.microsoft\.com\/playwright:\S+/g)].map((m) => m[0]);
    expect(images).toEqual([IMAGE, IMAGE]);
    expect(/playwright:v(\d+\.\d+\.\d+)-noble@/.exec(IMAGE)?.[1]).toBe(VERSION);
    expect(workflow).toContain('--platform linux/amd64');
    expect(workflow).toContain(`KADRION_PINNED_IMAGE: ${IMAGE}`);
  });

  it('installs from the frozen lockfile, fetches the pinned FFmpeg, and runs check and the browser tests', () => {
    expect(workflow).toContain('corepack pnpm install --frozen-lockfile');
    expect(workflow).not.toMatch(/pnpm install(?! --frozen-lockfile)/);
    const order = ['pnpm run check', 'node --run ffmpeg:fetch', 'node --run test:pinned'].map(
      (step) => workflow.indexOf(step),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('writes no golden frames: CI has a network, and golden frames come from the isolated run (D28.9)', () => {
    expect(workflow).not.toContain('goldens:update');
    expect(readText('tests', 'pinned', 'container', 'pinned-run.sh')).toContain('--network none');
  });

  it('pins the actions of the workflow by commit', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
  });

  it('repeats the same pins in the Producer and in D26', () => {
    expect(producerPins).toContain(`'${IMAGE}'`);
    expect(producerPins).toContain(`PLAYWRIGHT_CORE_VERSION = '${VERSION}'`);
    expect(readText('docs', 'adr', 'D26-pinned-render-environment.md')).toContain(IMAGE);
  });

  it("parses as YAML with Prettier's parser, and still says that it is unverified until Q14 closes", async () => {
    await expect(format(workflow, { parser: 'yaml' })).resolves.toBeTypeOf('string');
    expect(workflow).toMatch(/^# .*UNVERIFIED until Q14 closes\.$/m);
    // Not the claims of PR-13 and PR-14, which the first two runs made false.
    expect(workflow).not.toMatch(/has never run/);
    expect(workflow).not.toMatch(/no run has passed/);
  });

  it('runs exactly the root script test:pinned, which builds and runs the pinned Vitest configuration', () => {
    const scripts = (readJson('package.json') as { scripts: Record<string, string> }).scripts;
    expect(scripts['test:pinned']).toBe(
      'node --run build && vitest run --config vitest.pinned.config.ts',
    );
    expect([...workflow.matchAll(/^\s+node --run test:pinned\s*$/gm)]).toHaveLength(1);
  });

  it('points FFmpeg at the container workspace and the release that ffmpeg:fetch writes (D29.1)', () => {
    // In a container job, the expression github.workspace names the runner's path.
    expect(workflow).not.toContain('github.workspace');
    const release = /FFMPEG_RELEASE = '([^']+)'/.exec(
      readText('packages', 'producer', 'src', 'ffmpeg.ts'),
    )?.[1];
    expect(release).toBeDefined();
    // Exactly twice each: for the pinned tests, and for the CI identity, which
    // must observe the same executables the export used (PR-13).
    for (const binary of ['ffmpeg', 'ffprobe']) {
      const line = `export KADRION_${binary.toUpperCase()}="$GITHUB_WORKSPACE/.kadrion-cache/ffmpeg/${release ?? ''}/bin/${binary}"`;
      expect(workflow.split(line)).toHaveLength(3);
      expect(workflow.split(`KADRION_${binary.toUpperCase()}=`)).toHaveLength(3);
    }
  });

  it('uploads the hidden .kadrion-out directory, and warns when it is missing', () => {
    expect(workflow).toMatch(
      /path: \.kadrion-out\/\n\s+include-hidden-files: true\n\s+if-no-files-found: warn/,
    );
    expect(workflow).toContain("COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'");
  });

  it('never lets a failing gate update golden frames (D34.3)', () => {
    const script = readText('tests', 'pinned', 'container', 'pinned-run.sh');
    const body = (name: string): string => {
      const start = script.indexOf(`\n${name}() {`);
      const end = script.indexOf('\n}\n', start);
      expect(start, name).toBeGreaterThanOrEqual(0);
      return script.slice(start, end);
    };
    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(body('isolated')).toContain('bash -o pipefail -c');
    const reference = body('reference');
    // The isolated block that runs the gate must stop at its first failure; the
    // export block further down has its own set -e, which must not count here.
    const isolatedBlock = reference.slice(reference.indexOf("isolated '"));
    expect(isolatedBlock).toMatch(/^isolated '\n\s+set -e\n/);
    const blockEnd = isolatedBlock.indexOf("'\n", "isolated '".length);
    expect(blockEnd).toBeGreaterThan(0);
    expect(isolatedBlock.indexOf('node --run test:pinned')).toBeLessThan(blockEnd);
    const firstTest = reference.indexOf('node --run test:pinned');
    expect(firstTest).toBeGreaterThanOrEqual(0);
    expect(firstTest).toBeLessThan(reference.indexOf('node --run goldens:update'));
    expect(firstTest).toBeLessThan(reference.indexOf('parity-measurement-1.json'));
    const repeat = body('repeat');
    const copy = repeat.indexOf('cp -r "$OUT/goldens-1" "$ROOT/$GOLDENS"');
    expect(copy).toBeGreaterThan(repeat.indexOf('node --run test:pinned'));
    expect(copy).toBeGreaterThan(repeat.indexOf('goldens-repeatability.txt'));
  });

  it('cannot be green while a step was bypassed (Q14, criterion 3)', () => {
    expect(workflow).not.toMatch(/continue-on-error/);
    // No fallback of any kind: `|| true`, `|| :`, `|| exit 0`.
    expect(workflow).not.toMatch(/\|\|/);
    expect(workflow).not.toMatch(/set \+e/);
    // Only the evidence steps and the upload of the reports run whatever happened
    // before them (PR-13), in this order, after the pinned tests.
    const conditions = [...workflow.matchAll(/^\s+if:\s*(.+)$/gm)].map((m) => m[1]);
    expect(conditions).toEqual(['always()', 'always()', 'always()']);
    const conditioned = [...workflow.matchAll(/- name: (.+)\n\s+if: (.+)/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(conditioned).toEqual([
      ['Pinned test summary', 'always()'],
      ['CI identity', 'always()'],
      ['Reports', 'always()'],
    ]);
    const order = [
      'node --run test:pinned',
      'tests/ci/write-pinned-summary.ts',
      'tests/ci/write-ci-identity.ts',
      '- name: Reports',
    ].map((step) => workflow.indexOf(step));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it('writes the raw report the summary reads, without retries or an empty pass (PR-13)', () => {
    const config = readText('vitest.pinned.config.ts');
    expect(config).toContain(
      "reporters: ['default', ['json', { outputFile: '.kadrion-out/vitest-pinned.json' }]]",
    );
    expect(config).toMatch(/^\s+retry: 0,$/m);
    expect(config).toMatch(/^\s+passWithNoTests: false,$/m);
    expect(readText('tests', 'ci', 'write-pinned-summary.ts')).toContain(
      "join(root, '.kadrion-out', 'vitest-pinned.json')",
    );
  });

  it('writes a summary right after every pinned pass of the reference run, so no copy pairs a report with another pass (PR-13)', () => {
    const script = readText('tests', 'pinned', 'container', 'pinned-run.sh');
    // The commands only: a comment between a pass and its summary does not count.
    const lines = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    const passes = lines.flatMap((line, at) =>
      line.startsWith('node --run test:pinned ') ? [at] : [],
    );
    expect(passes).toHaveLength(3);
    for (const at of passes) {
      expect(lines[at + 1]).toMatch(
        /^node --experimental-strip-types tests\/ci\/write-pinned-summary\.ts 2>&1 \| tee \/out\/pinned-summary-\d\.log$/,
      );
    }
    expect(lines.filter((line) => line.includes('write-pinned-summary.ts'))).toHaveLength(3);
    expect(script).toContain('cp .kadrion-out/vitest-pinned.json /out/vitest-pinned-1.json');
  });

  it('keeps the reports and measurements of the browser tests out of Git', () => {
    expect(readText('.gitignore')).toMatch(/^\.kadrion-out\/$/m);
  });
});
