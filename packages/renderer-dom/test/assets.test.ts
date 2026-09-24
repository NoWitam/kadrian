/**
 * Asset URLs (D22.5): every image and font a node uses needs a URL, unknown IDs
 * are errors, and every problem is thrown as one `RenderError` before the DOM is
 * touched. "Missing required assets are errors, not silent fallbacks" (AGENTS.md).
 */
import { describe, expect, it } from 'vitest';

import { mountComposition, type AssetUrls } from '../src/index.js';
import { createRoot, derived, draftNode, reference, referenceUrls } from './support.js';

/** Mounts into a root that already holds content, and proves the content survives a failure. */
function mountFails(
  document: Parameters<typeof mountComposition>[1],
  urls: unknown,
  code: string,
  message: string,
): void {
  const root = createRoot();
  root.innerHTML = '<p>before</p>';
  expect(() => {
    mountComposition(root, document, urls as AssetUrls);
  }).toThrow(expect.objectContaining({ name: 'RenderError', code, message }));
  expect(root.innerHTML).toBe('<p>before</p>');
}

describe('asset URLs (D22.5)', () => {
  it('accepts the URLs of the used image and font, and an extra one for the audio asset', () => {
    const root = createRoot();
    mountComposition(root, reference, { ...referenceUrls, 'asset-audio': 'blob:audio' });
    expect(root.querySelector('img')?.getAttribute('src')).toBe(referenceUrls['asset-image']);
  });

  it.each([
    [
      'a missing image',
      { 'asset-font': 'https://assets.invalid/asset-font' },
      'asset-url-missing',
      'Asset URLs: asset-url-missing "asset-image".',
    ],
    [
      'a missing font',
      { 'asset-image': 'https://assets.invalid/asset-image' },
      'asset-url-missing',
      'Asset URLs: asset-url-missing "asset-font".',
    ],
    [
      'no URL at all',
      {},
      'asset-url-missing',
      'Asset URLs: asset-url-missing "asset-font", asset-url-missing "asset-image".',
    ],
    [
      'an unknown ID',
      { ...referenceUrls, 'asset-other': 'blob:x' },
      'asset-url-unknown',
      'Asset URLs: asset-url-unknown "asset-other".',
    ],
    [
      'an empty URL',
      { ...referenceUrls, 'asset-image': '' },
      'asset-url-invalid',
      'Asset URLs: asset-url-invalid "asset-image".',
    ],
    [
      'a URL that is not a string',
      { ...referenceUrls, 'asset-font': 7 },
      'asset-url-invalid',
      'Asset URLs: asset-url-invalid "asset-font".',
    ],
    [
      'several problems, sorted by asset ID, named by the gravest',
      { zeta: 'blob:z', 'asset-image': '' },
      'asset-url-invalid',
      'Asset URLs: asset-url-missing "asset-font", asset-url-invalid "asset-image", asset-url-unknown "zeta".',
    ],
  ])('rejects %s before the DOM is touched', (_, urls, code, message) => {
    mountFails(reference, urls, code, message);
  });

  it('names an unknown ID before a missing one when both occur', () => {
    mountFails(
      reference,
      { 'asset-image': referenceUrls['asset-image'], 'asset-other': 'blob:x' },
      'asset-url-unknown',
      'Asset URLs: asset-url-missing "asset-font", asset-url-unknown "asset-other".',
    );
  });

  it.each([
    [
      'a hidden property',
      (urls: Record<string, unknown>) =>
        Object.defineProperty(urls, 'asset-image', { value: 'blob:hidden', enumerable: false }),
      'asset-url-invalid "asset-image"',
    ],
    [
      'a getter',
      (urls: Record<string, unknown>) =>
        Object.defineProperty(urls, 'asset-image', {
          get: () => 'blob:getter',
          enumerable: true,
        }),
      'asset-url-invalid "asset-image"',
    ],
    [
      'a symbol key',
      (urls: Record<string | symbol, unknown>) =>
        Object.defineProperty(urls, Symbol('asset'), { value: 'blob:x', enumerable: true }),
      'asset-url-invalid "Symbol(asset)", asset-url-unknown "Symbol(asset)"',
    ],
  ])('rejects %s among the URLs', (_, add, problems) => {
    const urls: Record<string, unknown> = { 'asset-font': referenceUrls['asset-font'] };
    if (!problems.includes('"asset-image"')) urls['asset-image'] = referenceUrls['asset-image'];
    add(urls);
    const root = createRoot();
    expect(() => {
      mountComposition(root, reference, urls as AssetUrls);
    }).toThrow(expect.objectContaining({ code: 'asset-url-invalid' }));
    expect(() => {
      mountComposition(root, reference, urls as AssetUrls);
    }).toThrow(problems);
    expect(root.childNodes).toHaveLength(0);
  });

  it('reads every URL once, before the tree is built', () => {
    const urls = { ...referenceUrls };
    let reads = 0;
    const counted = Object.defineProperty({ ...urls }, 'asset-image', {
      value: urls['asset-image'],
      enumerable: true,
    });
    const proxy = new Proxy(counted, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'asset-image') reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) {
        if (key === 'asset-image') reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const root = createRoot();
    mountComposition(root, reference, proxy);
    expect(reads).toBe(1);
    expect(root.querySelector('img')?.getAttribute('src')).toBe(urls['asset-image']);
  });

  it.each([
    ['null', null],
    ['an array', ['https://assets.invalid/asset-image']],
    ['a map', new Map(Object.entries(referenceUrls))],
    ['a string', 'https://assets.invalid/asset-image'],
    [
      'an instance of a class',
      new (class Urls {
        readonly 'asset-image' = 'https://assets.invalid/asset-image';
      })(),
    ],
  ])('rejects %s instead of a plain object', (_, urls) => {
    mountFails(reference, urls, 'asset-url-invalid', 'Asset URLs must be a plain object.');
  });

  it('accepts a plain object from another realm and one without a prototype', () => {
    const foreign: unknown = createRoot().ownerDocument.defaultView?.eval(
      `(${JSON.stringify(referenceUrls)})`,
    );
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    mountComposition(createRoot(), reference, foreign as AssetUrls);
    mountComposition(
      createRoot(),
      reference,
      Object.assign(Object.create(null), referenceUrls) as AssetUrls,
    );
  });

  // The schema allows these IDs; a lookup through the prototype chain would find
  // `Object.prototype.constructor` and friends instead of a missing entry.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'looks up only own entries, also for the asset ID %s',
    (id) => {
      const document = derived((draft) => {
        const image = draft.assets.find((asset) => asset.id === 'asset-image');
        if (image === undefined) throw new Error('The fixture has an image asset.');
        image.id = id;
        const node = draftNode(draft, 'node-image');
        if (node.type !== 'image') throw new Error('node-image is an image.');
        node.assetId = id;
      });
      const font = { 'asset-font': referenceUrls['asset-font'] };
      mountFails(document, font, 'asset-url-missing', `Asset URLs: asset-url-missing "${id}".`);

      // JSON.parse creates `__proto__` as an own property, unlike an object literal.
      const urls = JSON.parse(JSON.stringify({ ...font, [id]: 'blob:image' })) as AssetUrls;
      const root = createRoot();
      mountComposition(root, document, urls);
      expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:image');
    },
  );
});
