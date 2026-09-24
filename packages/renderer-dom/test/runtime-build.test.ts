/**
 * The runtime build artifact (D21): built deterministically, described by its
 * manifest, free of anything that ties it to this checkout, and working as the
 * page entry that Player and Producer will load.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { referenceComposition, referenceExpectedRender } from '@kadrion/test-fixtures';
import type { DOMWindow } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ARTIFACT_FILE,
  BUNDLE_OPTIONS,
  MANIFEST_FILE,
  OUTPUT_DIRECTORY,
  bundleRuntime,
  type RuntimeBuild,
} from '../scripts/build-runtime.js';
import type { CustomHtmlHost } from '../src/index.js';
import { withoutClocks } from './clocks.js';
import { elementDouble, hostDouble } from './elements.js';
import { createRoot, createWindow, describeRoot, referenceUrls } from './support.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const manifestOnDisk = JSON.parse(
  readFileSync(join(OUTPUT_DIRECTORY, MANIFEST_FILE), 'utf8'),
) as Record<string, unknown>;
const artifactOnDisk = readFileSync(join(OUTPUT_DIRECTORY, ARTIFACT_FILE));
const packageManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { devDependencies: Record<string, string> };
const rootManifest = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { devDependencies: Record<string, string> };

let first: RuntimeBuild;
let second: RuntimeBuild;

beforeAll(async () => {
  [first, second] = [await bundleRuntime(), await bundleRuntime()];
});

describe('runtime build artifact (D21)', () => {
  it('is byte-identical across two builds and to the artifact that `build` wrote', () => {
    expect(first.bytes.byteLength).toBeGreaterThan(10_000);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect(artifactOnDisk.equals(Buffer.from(first.bytes))).toBe(true);
    expect(second.manifest).toStrictEqual(first.manifest);
  });

  it('is described by its manifest, with the content hash in the format of D14', () => {
    const hash = createHash('sha256').update(artifactOnDisk).digest('hex');
    expect(manifestOnDisk).toStrictEqual({
      file: 'kadrion-runtime.js',
      format: 'iife',
      globalName: 'KadrionRuntime',
      byteLength: artifactOnDisk.byteLength,
      bundler: `esbuild@${packageManifest.devDependencies.esbuild ?? ''}`,
      compiler: `typescript@${rootManifest.devDependencies.typescript ?? ''}`,
      contentHash: `sha256:${hash}`,
    });
    expect(manifestOnDisk.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.manifest).toStrictEqual(manifestOnDisk);
  });

  // Asserted apart from the script, so that a changed option cannot pass unnoticed.
  it('is built with the options that D21 fixes', () => {
    expect(packageManifest.devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUNDLE_OPTIONS).toMatchObject({
      entryPoints: ['packages/renderer-dom/dist/page.js'],
      bundle: true,
      format: 'iife',
      globalName: 'KadrionRuntime',
      platform: 'browser',
      target: 'es2022',
      minify: false,
      sourcemap: false,
      legalComments: 'none',
      charset: 'utf8',
      write: false,
    });
    expect(BUNDLE_OPTIONS.absWorkingDir).toBe(repoRoot);
  });

  it('holds nothing that ties it to this checkout or to Node.js', () => {
    const text = artifactOnDisk.toString('utf8');
    const slashed = repoRoot.replaceAll('\\', '/');
    for (const needle of [repoRoot, slashed, repoRoot.replace(/[\\/]$/, '')]) {
      expect(text).not.toContain(needle);
    }
    expect(text).not.toMatch(/sourceMappingURL|\brequire\(|\bprocess\.|\bnode:[a-z]/);
    expect(text).not.toContain('\r');
    expect(text.startsWith('"use strict";\nvar KadrionRuntime = (() => {\n')).toBe(true);
    // Every bundled module is one of the three packages of the runtime build (D20).
    const modules = [...text.matchAll(/^ {2}\/\/ (\S+)$/gm)].map((match) => match[1] ?? '');
    expect(modules.length).toBeGreaterThan(5);
    for (const path of modules) {
      expect(path).toMatch(/^packages\/(renderer-dom|runtime|schema)\/dist\/[a-z-]+\.js$/);
    }
  });
});

interface PageApi {
  mount(root: Element, document: unknown, assetUrls: unknown): { ok: boolean };
  render(root: Element, document: unknown, timeUs: number): { ok: boolean };
  synchronize(
    root: Element,
    document: unknown,
    timeUs: number,
    host: CustomHtmlHost,
  ): Promise<{ ok: boolean }>;
}

/**
 * A value as the page receives it through `postMessage` or a CDP evaluation: a
 * plain copy made in the realm of the page, without a brand. (`validateComposition`
 * accepts plain objects of its own realm only.)
 */
function inPage(window: DOMWindow, value: unknown): unknown {
  return window.JSON.parse(JSON.stringify(value));
}

/**
 * A page that loads the artifact as a classic script, as Player and Producer
 * will. (An `eval` would not do: the artifact is strict code, and a strict
 * `eval` keeps its `var` to itself.)
 */
function loadArtifact(): { window: DOMWindow; api: PageApi; globals: string[] } {
  const window = createWindow('dangerously');
  const before = new Set(Object.keys(window));
  const script = window.document.createElement('script');
  script.textContent = artifactOnDisk.toString('utf8');
  window.document.head.append(script);
  const api = (window as unknown as { KadrionRuntime?: PageApi }).KadrionRuntime;
  if (api === undefined) throw new Error('The artifact defined no KadrionRuntime.');
  return { window, api, globals: Object.keys(window).filter((key) => !before.has(key)) };
}

describe('the artifact as the page entry (D21.4)', () => {
  it('defines one global, which exposes exactly load, mount, render, synchronize, and frame', () => {
    const { api, globals } = loadArtifact();
    expect(globals).toEqual(['KadrionRuntime']);
    expect(Object.keys(api).sort()).toEqual(['frame', 'load', 'mount', 'render', 'synchronize']);
  });

  it('renders the golden timestamps from an unvalidated document while every clock throws', () => {
    const { window, api } = loadArtifact();
    // Detached, so that no frame is attached while the clocks throw (see clock-independence.test.ts).
    const root = window.document.createElement('div');
    const document = inPage(window, referenceComposition);
    const urls = inPage(window, referenceUrls);
    const results: unknown[] = [];
    const trees = withoutClocks([window], () => {
      results.push(api.mount(root, document, urls));
      return referenceExpectedRender.golden.map(({ timeUs }) => {
        results.push(api.render(root, document, timeUs));
        return describeRoot(root);
      });
    });
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ ok: true })));
    expect(trees).toStrictEqual(referenceExpectedRender.golden.map(({ tree }) => [tree]));
  });

  it('answers an invalid document with its errors and leaves the DOM alone', () => {
    const { window, api } = loadArtifact();
    const root = createRoot(window);
    root.innerHTML = '<p>before</p>';
    const invalid = inPage(window, { ...(referenceComposition as object), fps: 0 });
    expect(api.mount(root, invalid, inPage(window, referenceUrls))).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: '/fps' })],
    });
    expect(api.render(root, invalid, 0)).toMatchObject({ ok: false });
    expect(root.innerHTML).toBe('<p>before</p>');
  });

  // D21: a host hands the document over as JSON or through postMessage.
  it('rejects a document that is an object of another realm', () => {
    const { window, api } = loadArtifact();
    const root = createRoot(window);
    const foreign: unknown = JSON.parse(JSON.stringify(referenceComposition));
    expect(api.mount(root, foreign, inPage(window, referenceUrls))).toMatchObject({ ok: false });
    expect(root.childNodes).toHaveLength(0);
  });

  it('synchronizes the Custom HTML element in the page realm, with a timer from the host (D23.5)', async () => {
    const { window, api } = loadArtifact();
    const root = createRoot(window);
    const document = inPage(window, referenceComposition);
    expect(api.mount(root, document, inPage(window, referenceUrls))).toEqual({ ok: true });
    const element = elementDouble(window, root, 'node-custom-html');
    const golden = referenceExpectedRender.golden;
    // The host passes the frame index as its request ID, as the fixture assumes.
    const hosts = golden.map(({ customHtml }) =>
      hostDouble(window, { requestId: customHtml[0]?.post.requestId ?? -1 }),
    );
    const host = hostDouble(window);
    // Built outside: jsdom reads the clock when it constructs an event.
    const answers = golden.map(({ customHtml }) =>
      element.event(inPage(window, customHtml[0]?.acknowledgement)),
    );
    const results = withoutClocks([window], () =>
      golden.map(({ timeUs }, index) => {
        api.render(root, document, timeUs);
        const pending = api.synchronize(root, document, timeUs, hosts[index]?.host ?? host.host);
        const answer = answers[index];
        if (answer !== undefined) element.dispatch(answer);
        return pending;
      }),
    );
    for (const result of results) await expect(result).resolves.toEqual({ ok: true });
    expect(element.posted.map(({ message }) => JSON.stringify(message))).toEqual(
      golden.map(({ customHtml }) => JSON.stringify(customHtml[0]?.post)),
    );
    for (const each of hosts) expect(each.listeners()).toBe(0);

    const timedOut = api.synchronize(root, document, 0, host.host);
    host.expire();
    await expect(timedOut).rejects.toMatchObject({
      name: 'RenderError',
      code: 'custom-html-timeout',
    });

    const invalid = inPage(window, { ...(referenceComposition as object), fps: 0 });
    await expect(api.synchronize(root, invalid, 0, host.host)).resolves.toMatchObject({
      ok: false,
    });
    expect(element.posted).toHaveLength(golden.length + 1);
  });

  it('reports a missing asset URL as a typed error before the first frame', () => {
    const { window, api } = loadArtifact();
    const root = createRoot(window);
    expect(() => api.mount(root, inPage(window, referenceComposition), inPage(window, {}))).toThrow(
      expect.objectContaining({ name: 'RenderError', code: 'asset-url-missing' }),
    );
    expect(root.childNodes).toHaveLength(0);
  });
});
