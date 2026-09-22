import { describe, expect, it } from 'vitest';

import { listFiles, packageDirs, readJson, readText } from './repo.js';

interface BoundaryMap {
  packages: Record<string, { allowedDependencies: string[]; devOnly?: boolean }>;
  prohibited: { from: string[]; to: string[]; reason: string }[];
  externalRuntimeDependencies: Record<string, { reason: string; license: string }>;
}

type DependencyField =
  'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
type Manifest = Partial<Record<DependencyField, Record<string, string>>>;

const SCOPE = '@kadrion/';
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/**
 * Packages that a source text imports. Relative and `node:` specifiers are left
 * out: Node.js built-ins are gated by `types` in each tsconfig (D11).
 */
function importedPackages(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)]
    .map((match) => match[1] ?? '')
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
    .map((specifier) =>
      specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/'),
    );
}

const map = readJson('docs', 'architecture', 'package-boundaries.json') as BoundaryMap;
const names = Object.keys(map.packages).sort();
const devOnly = names.filter((name) => map.packages[name]?.devOnly === true);
const allowed = (name: string): string[] => map.packages[name]?.allowedDependencies ?? [];

/** Edges that may exist: allowed runtime edges plus "anyone may devDepend on a dev-only package". */
const edges = (name: string): string[] =>
  devOnly.includes(name) ? allowed(name) : [...allowed(name), ...devOnly];

function findCycle(node: string, path: string[]): string[] | undefined {
  if (path.includes(node)) return [...path, node];
  for (const next of edges(node)) {
    const cycle = findCycle(next, [...path, node]);
    if (cycle) return cycle;
  }
  return undefined;
}

describe('package boundary map', () => {
  it('lists exactly the workspace packages', () => {
    expect(names).toEqual(packageDirs);
  });

  it('only allows runtime edges to known packages that are not dev-only', () => {
    const runtimeTargets = names.filter((name) => !devOnly.includes(name));
    for (const name of names) expect(runtimeTargets).toEqual(expect.arrayContaining(allowed(name)));
  });

  it('allows no prohibited runtime edge', () => {
    const violations = map.prohibited.flatMap((rule) =>
      rule.from.flatMap((from) =>
        allowed(from)
          .filter((to) => rule.to.includes('*') || rule.to.includes(to))
          .map((to) => `${from} -> ${to}`),
      ),
    );
    expect(violations).toEqual([]);
  });

  it('is acyclic, including dev-only edges', () => {
    expect(names.map((name) => findCycle(name, [])).filter(Boolean)).toEqual([]);
  });
});

describe('import scan', () => {
  it('finds every form of import and ignores relative and node: specifiers', () => {
    const source = [
      "import value from 'default-import';",
      "import { named } from '@scope/named-import/deep/path.js';",
      "import type { Type } from 'type-import';",
      "export { again } from 're-export';",
      "import 'side-effect';",
      "const lazy = await import('dynamic-import');",
      "import { local } from './local.js';",
      "import { readFileSync } from 'node:fs';",
    ].join('\n');
    expect(importedPackages(source)).toEqual([
      'default-import',
      '@scope/named-import',
      'type-import',
      're-export',
      'side-effect',
      'dynamic-import',
    ]);
  });
});

describe.each(packageDirs)('dependencies declared by @kadrion/%s', (dir) => {
  const manifest = readJson('packages', dir, 'package.json') as Manifest;
  const entries = (fields: readonly DependencyField[]): [string, string][] =>
    fields.flatMap((field) => Object.entries(manifest[field] ?? {}));
  const internal = (list: [string, string][]): string[] =>
    list.filter(([name]) => name.startsWith(SCOPE)).map(([name]) => name.slice(SCOPE.length));

  it('has only allowed workspace runtime dependencies', () => {
    expect(allowed(dir)).toEqual(expect.arrayContaining(internal(entries(RUNTIME_FIELDS))));
  });

  it('has only allowed workspace devDependencies', () => {
    expect(edges(dir)).toEqual(expect.arrayContaining(internal(entries(['devDependencies']))));
  });

  it('has only allowlisted external runtime dependencies', () => {
    const external = entries(RUNTIME_FIELDS).filter(([name]) => !name.startsWith(SCOPE));
    const allowlist = Object.keys(map.externalRuntimeDependencies);
    expect(allowlist).toEqual(expect.arrayContaining(external.map(([name]) => name)));
  });

  // A devDependency is resolvable from src by walking up to a node_modules
  // directory, so checking the manifest alone is not enough (D12).
  it('imports only declared runtime dependencies from its sources', () => {
    const declared = entries(RUNTIME_FIELDS).map(([name]) => name);
    const undeclared = listFiles('packages', dir, 'src')
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => importedPackages(readText(file)).map((name) => `${file}: ${name}`))
      .filter((line) => !declared.some((name) => line.endsWith(`: ${name}`)));
    expect(undeclared).toEqual([]);
  });

  it('links workspace packages with the workspace: protocol', () => {
    const links = entries([...RUNTIME_FIELDS, 'devDependencies']).filter(([name]) =>
      name.startsWith(SCOPE),
    );
    for (const [, range] of links) expect(range).toMatch(/^workspace:/);
  });
});
