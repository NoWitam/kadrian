import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { agentsText, packageDirs, readJson, repoPath } from './repo.js';

interface Manifest {
  name?: string;
  private?: boolean;
  license?: string;
  type?: string;
  description?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface SolutionConfig {
  references?: { path: string }[];
}

const SCOPE = '@kadrion/';

/** Project references of a tsconfig, or none when the file does not exist. */
function referencesOf(...segments: string[]): string[] {
  if (!existsSync(repoPath(...segments))) return [];
  const config = readJson(...segments) as SolutionConfig;
  return (config.references ?? []).map((reference) => reference.path);
}

const workspaceNames = (dependencies: Record<string, string> = {}): string[] =>
  Object.keys(dependencies)
    .filter((name) => name.startsWith(SCOPE))
    .map((name) => name.slice(SCOPE.length));

/** Package names and responsibility lines exactly as `AGENTS.md` defines them. */
const defined = new Map(
  [...agentsText.matchAll(/`@kadrion\/([a-z-]+)`: ([^.]+\.)/g)].map((match) => [
    match[1] ?? '',
    match[2] ?? '',
  ]),
);

const referenced = referencesOf('tsconfig.json');

describe('workspace structure', () => {
  it('contains exactly the packages that AGENTS.md defines', () => {
    expect(packageDirs).toEqual([...defined.keys()].sort());
  });

  it('type-checks the repository-level tests', () => {
    expect(referenced).toContain('./tests');
  });
});

describe.each(packageDirs)('@kadrion/%s', (dir) => {
  const manifest = readJson('packages', dir, 'package.json') as Manifest;

  it('is a private, unlicensed ES module named after its directory', () => {
    expect(manifest).toMatchObject({
      name: `@kadrion/${dir}`,
      private: true,
      license: 'UNLICENSED',
      type: 'module',
    });
  });

  it('describes itself with the responsibility line from AGENTS.md', () => {
    expect(manifest.description).toBe(defined.get(dir));
  });

  it('is built by the root solution', () => {
    expect(existsSync(repoPath('packages', dir, 'src', 'index.ts'))).toBe(true);
    expect(referenced).toContain(`./packages/${dir}`);
  });

  it('has its tests type-checked whenever it has a test directory', () => {
    const hasTests = existsSync(repoPath('packages', dir, 'test'));
    const isTypeChecked =
      existsSync(repoPath('packages', dir, 'test', 'tsconfig.json')) &&
      referenced.includes(`./packages/${dir}/test`);
    expect(isTypeChecked).toBe(hasTests);
  });

  // D11: workspace packages resolve through `exports` to built output, so `tsc -b`
  // must build a dependency before whatever imports it. The renderer also exports
  // the runtime build artifact and its manifest (D21, D25.5), and nothing else.
  it('exports its built output', () => {
    const artifact =
      dir === 'renderer-dom'
        ? {
            './runtime-build/kadrion-runtime.js': './dist/runtime-build/kadrion-runtime.js',
            './runtime-build/kadrion-runtime.json': './dist/runtime-build/kadrion-runtime.json',
          }
        : {};
    expect(manifest.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      ...artifact,
    });
  });

  it('references the project of every workspace dependency', () => {
    expect(referencesOf('packages', dir, 'tsconfig.json')).toEqual(
      expect.arrayContaining(workspaceNames(manifest.dependencies).map((name) => `../${name}`)),
    );
    expect(referencesOf('packages', dir, 'test', 'tsconfig.json')).toEqual(
      expect.arrayContaining(
        workspaceNames(manifest.devDependencies).map((name) => `../../${name}`),
      ),
    );
  });
});
