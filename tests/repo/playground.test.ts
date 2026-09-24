/**
 * The playground is an application, not a package (D25.8, D25.9, D32.7): it
 * depends on the Player, the command bus, the AI tool, the schema's frame grid,
 * the renderer's artifact, and the fixtures only;
 * no package depends on it; and its server serves nothing but the files it names.
 *
 * It is also the one place where P3 meets a pointer, so the boundary of D30.10
 * is asserted here too: the gesture imports the bus and nothing else, and the
 * frame it drags over has an opaque origin.
 */
import { execFileSync } from 'node:child_process';

import { RENDER_PAGE_SANDBOX } from '@kadrion/renderer-dom';
import { describe, expect, it } from 'vitest';

import { listFiles, packageDirs, readJson, readText, repoRoot } from './repo.js';

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
const specifiers = (source: string): string[] =>
  [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? '');

describe('the playground application (D25.9)', () => {
  it('depends on the packages D32.7 names and on nothing else', () => {
    const manifest = readJson('apps', 'playground', 'package.json') as {
      private?: boolean;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({
      '@kadrion/ai-sdk': 'workspace:*',
      '@kadrion/editor-sdk': 'workspace:*',
      '@kadrion/player': 'workspace:*',
      '@kadrion/renderer-dom': 'workspace:*',
      '@kadrion/schema': 'workspace:*',
      '@kadrion/test-fixtures': 'workspace:*',
    });
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('imports the Player, the bus, and the fixtures in the page, and only built-ins in its scripts', () => {
    const sources = listFiles('apps', 'playground').filter(
      (file) =>
        file.endsWith('.ts') && !file.includes('/dist/') && !file.includes('/node_modules/'),
    );
    expect(sources).toEqual([
      'apps/playground/scripts/serve.ts',
      'apps/playground/src/app.ts',
      'apps/playground/src/drag.ts',
      'apps/playground/src/main.ts',
      'apps/playground/src/showcases.ts',
    ]);
    expect(specifiers(readText('apps', 'playground', 'src', 'main.ts')).sort()).toEqual([
      './app.js',
      './showcases.js',
      '@kadrion/ai-sdk',
      '@kadrion/editor-sdk',
      '@kadrion/player',
      '@kadrion/schema',
      '@kadrion/test-fixtures',
    ]);
    // The manifest of the showcases is data: it imports nothing (D32.1).
    expect(specifiers(readText('apps', 'playground', 'src', 'showcases.ts'))).toEqual([]);
    for (const specifier of specifiers(readText('apps', 'playground', 'scripts', 'serve.ts'))) {
      expect(specifier).toMatch(/^node:/);
    }
  });

  it('keeps the gesture and the editing on the command bus, away from the renderer (D30.10)', () => {
    // `main.ts` is bootstrap: it owns the Player. Everything that edits lives in
    // `app.ts` and `drag.ts`, which know the bus and nothing below it, so the
    // jsdom test can drive exactly what the page runs.
    expect(specifiers(readText('apps', 'playground', 'src', 'drag.ts'))).toEqual([
      '@kadrion/editor-sdk',
    ]);
    expect(specifiers(readText('apps', 'playground', 'src', 'app.ts')).sort()).toEqual([
      './drag.js',
      '@kadrion/editor-sdk',
    ]);
  });

  it('reaches the rendered node through no other route: the frame has an opaque origin', () => {
    // The overlay is not a matter of discipline. `allow-same-origin` is absent,
    // so the page could not touch the renderer's DOM even if it tried (D30.10).
    expect(RENDER_PAGE_SANDBOX).toBe('allow-scripts');
    expect(RENDER_PAGE_SANDBOX).not.toContain('allow-same-origin');
  });

  it('shows a drag affordance of its own over the stage', () => {
    const html = readText('apps', 'playground', 'index.html');
    expect(html).toContain('id="overlay"');
    expect(html).toContain('id="grip"');
    // The grip must take pointer events; the overlay must not swallow the page.
    expect(html).toMatch(/#overlay\s*\{[^}]*pointer-events:\s*none/);
    expect(html).toMatch(/#grip\s*\{[^}]*pointer-events:\s*auto/);
  });

  it('maps only the built packages in its import map', () => {
    const html = readText('apps', 'playground', 'index.html');
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}';
    const imports = (JSON.parse(map) as { imports: Record<string, string> }).imports;
    for (const [name, url] of Object.entries(imports)) {
      const dir = name.replace('@kadrion/', '');
      expect(packageDirs).toContain(dir);
      expect(url).toBe(`/pkg/${dir}/index.js`);
    }
  });

  it('is depended on by no package', () => {
    for (const dir of packageDirs) {
      const manifest = readText('packages', dir, 'package.json');
      expect(manifest).not.toContain('kadrion-playground');
      for (const file of listFiles('packages', dir, 'src')) {
        const source = readText(...file.split('/'));
        for (const specifier of specifiers(source)) {
          expect(specifier, file).not.toMatch(/apps\/|kadrion-playground/);
        }
      }
    }
  });
});

describe('the playground server (D25.9)', () => {
  const probe = [
    '/',
    '/app/main.js',
    '/app/showcases/keyframes.json',
    '/pkg/ai-sdk/index.js',
    '/pkg/editor-sdk/index.js',
    '/pkg/player/index.js',
    '/pkg/renderer-dom/runtime-build/kadrion-runtime.js',
    '/pkg/test-fixtures/compositions/reference.json',
    '/pkg/player/',
    '/pkg/player/../../../package.json',
    '/pkg/player/..',
    '/pkg/player/sub/../index.js',
    '/pkg/player/sub\\..\\..\\x.js',
    '/pkg/player/index.ts',
    '/pkg/producer/index.js',
    '/package.json',
    '/apps/playground/index.html',
  ];
  const script = [
    "const { resolveRequest } = await import('./apps/playground/scripts/serve.ts');",
    `const probe = ${JSON.stringify(probe)};`,
    "console.log(JSON.stringify(probe.map((path) => { const file = resolveRequest(path); return file === null ? null : file.slice(process.cwd().length).replaceAll('\\\\', '/'); })));",
  ].join('\n');
  const resolved = JSON.parse(
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', script],
      { cwd: repoRoot, encoding: 'utf8' },
    ),
  ) as (string | null)[];

  it('serves the page, its build, and the built packages it needs, and nothing else', () => {
    expect(Object.fromEntries(probe.map((path, index) => [path, resolved[index]]))).toEqual({
      '/': '/apps/playground/index.html',
      '/app/main.js': '/apps/playground/dist/main.js',
      // Built copies of the showcases, not their sources (D32.1).
      '/app/showcases/keyframes.json': '/apps/playground/dist/showcases/keyframes.json',
      '/pkg/ai-sdk/index.js': '/packages/ai-sdk/dist/index.js',
      '/pkg/editor-sdk/index.js': '/packages/editor-sdk/dist/index.js',
      '/pkg/player/index.js': '/packages/player/dist/index.js',
      '/pkg/renderer-dom/runtime-build/kadrion-runtime.js':
        '/packages/renderer-dom/dist/runtime-build/kadrion-runtime.js',
      '/pkg/test-fixtures/compositions/reference.json':
        '/packages/test-fixtures/dist/compositions/reference.json',
      '/pkg/player/': null,
      '/pkg/player/../../../package.json': null,
      '/pkg/player/..': null,
      // Inside the directory once normalised, but refused: no path segment may be '..'.
      '/pkg/player/sub/../index.js': null,
      '/pkg/player/sub\\..\\..\\x.js': null,
      '/pkg/player/index.ts': null,
      '/pkg/producer/index.js': null,
      '/package.json': null,
      '/apps/playground/index.html': null,
    });
  });
});
