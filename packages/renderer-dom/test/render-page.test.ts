/**
 * The render page both hosts load, and when a frame counts as ready (D25.2,
 * D25.3). jsdom decodes no image and has no font set, so readiness is tested
 * with doubles for both; what a real browser does is measured by PR-06.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { referenceComposition, referenceExpectedRender } from '@kadrion/test-fixtures';
import type { DOMWindow } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { RENDER_PAGE_POLICY, RENDER_ROOT_ID, renderPageDocument } from '../src/index.js';
import { frame, mount } from '../src/page.js';
import { elementDouble, hostDouble, settledState } from './elements.js';
import { createRoot, createWindow, describeRoot, referenceUrls } from './support.js';

/** Written out independently of render-page.ts (D25.2). */
const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

describe('the render page (D25.2)', () => {
  it('is exactly the policy, the root, and the given scripts in order', () => {
    expect(RENDER_PAGE_POLICY).toBe(POLICY);
    expect(renderPageDocument(['var a = 1;', 'var b = 2;'])).toBe(
      [
        '<!doctype html><html><head><meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
        '<style>html,body{margin:0;padding:0;overflow:hidden}</style>',
        '</head><body><div id="kadrion-root"></div>',
        '<script>var a = 1;</script><script>var b = 2;</script>',
        '</body></html>',
      ].join(''),
    );
    expect(RENDER_ROOT_ID).toBe('kadrion-root');
  });

  it.each(['</script>', '</SCRIPT >', '<script>', '<ScRiPt', '<!--', 'a</script'])(
    'refuses a script that contains %s',
    (sequence) => {
      expect(() => renderPageDocument(['ok', `var s = "${sequence}";`])).toThrow(
        expect.objectContaining({ name: 'RenderError', code: 'unsafe-script' }),
      );
    },
  );

  it('accepts the runtime build artifact as it is', () => {
    const artifact = readFileSync(
      fileURLToPath(new URL('../dist/runtime-build/kadrion-runtime.js', import.meta.url)),
      'utf8',
    );
    expect(renderPageDocument([artifact])).toContain(artifact);
  });
});

/** Stands in for the browser's decoding and font loading, which jsdom lacks. */
function readinessDoubles(
  window: DOMWindow,
  options: { readonly decode?: 'resolve' | 'reject' | 'missing'; readonly fonts?: boolean } = {},
) {
  const decodes: HTMLImageElement[] = [];
  const pending: (() => void)[] = [];
  if (options.decode !== 'missing') {
    Object.defineProperty(window.HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value(this: HTMLImageElement) {
        decodes.push(this);
        if (options.decode === 'reject') return Promise.reject(new Error('EncodingError'));
        return new Promise<void>((resolve) => pending.push(resolve));
      },
    });
  }
  let releaseFonts = (): void => undefined;
  if (options.fonts !== false) {
    const ready = new Promise<void>((resolve) => {
      releaseFonts = resolve;
    });
    Object.defineProperty(window.document, 'fonts', { configurable: true, value: { ready } });
  }
  return {
    decodes,
    releaseImages: () => {
      for (const resolve of pending) resolve();
    },
    releaseFonts: () => {
      releaseFonts();
    },
  };
}

// The module under test runs in the realm of Node.js, so documents are plain objects of that realm (D21).
function mountedPage(window: DOMWindow) {
  const root = createRoot(window);
  const document = JSON.parse(JSON.stringify(referenceComposition)) as unknown;
  mount(root, document, JSON.parse(JSON.stringify(referenceUrls)));
  return { root, document };
}

describe('a frame and its readiness (D25.3)', () => {
  it('renders first, and is ready only when the element answered, images decoded, and fonts settled', async () => {
    const window = createWindow();
    const doubles = readinessDoubles(window);
    const { root, document } = mountedPage(window);
    const element = elementDouble(window, root, 'node-custom-html');
    const golden = referenceExpectedRender.golden[2];
    const exchange = golden?.customHtml[0];
    const host = hostDouble(window, { requestId: exchange?.post.requestId ?? -1 });
    const result = frame(root, document, golden?.timeUs ?? -1, host.host);
    // Rendered at once, before anything is ready.
    expect(describeRoot(root)).toStrictEqual([golden?.tree]);
    expect(doubles.decodes).toHaveLength(1);
    element.answer(structuredClone(exchange?.acknowledgement));
    expect(await settledState(result)).toBe('pending');
    doubles.releaseImages();
    expect(await settledState(result)).toBe('pending');
    doubles.releaseFonts();
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('is not ready while the element has not answered, even with media ready', async () => {
    const window = createWindow();
    const doubles = readinessDoubles(window);
    const { root, document } = mountedPage(window);
    elementDouble(window, root, 'node-custom-html');
    const host = hostDouble(window);
    const result = frame(root, document, 0, host.host);
    doubles.releaseImages();
    doubles.releaseFonts();
    expect(await settledState(result)).toBe('pending');
    host.expire();
    await expect(result).rejects.toMatchObject({ code: 'custom-html-timeout' });
  });

  it.each([
    ['an image that cannot be decoded', { decode: 'reject' } as const, 'asset-decode-failed'],
    ['a document that cannot decode', { decode: 'missing' } as const, 'readiness-unsupported'],
    ['a document without a font set', { fonts: false } as const, 'readiness-unsupported'],
  ])('fails typed for %s', async (_, options, code) => {
    const window = createWindow();
    readinessDoubles(window, options);
    const { root, document } = mountedPage(window);
    elementDouble(window, root, 'node-custom-html');
    const result = frame(root, document, 0, hostDouble(window).host);
    await expect(result).rejects.toMatchObject({ name: 'RenderError', code });
  });

  it('rejects a time outside the composition instead of throwing', async () => {
    const window = createWindow();
    readinessDoubles(window);
    const { root, document } = mountedPage(window);
    const result = frame(root, document, 10_000_000, hostDouble(window).host);
    await expect(result).rejects.toMatchObject({ code: 'time-out-of-range' });
  });

  it('answers an invalid document with its errors', async () => {
    const window = createWindow();
    readinessDoubles(window);
    const { root } = mountedPage(window);
    const invalid = JSON.parse(
      JSON.stringify({ ...(referenceComposition as object), fps: 0 }),
    ) as unknown;
    await expect(frame(root, invalid, 0, hostDouble(window).host)).resolves.toMatchObject({
      ok: false,
    });
  });
});
