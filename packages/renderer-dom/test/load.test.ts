/**
 * The load step of the runtime build (D27.1), in jsdom with a stand-in font set
 * and a stand-in font constructor that record every call in one log, so that
 * the order of the steps is visible. That real faces load from real bytes, and
 * that text is drawn with them, is measured in Chromium (`tests/pinned`).
 */
import { describe, expect, it } from 'vitest';

import { base64 } from '../src/index.js';
import { load } from '../src/page.js';
import { createRoot, createWindow, derived, describeRoot, reference } from './support.js';

interface Log {
  readonly calls: string[];
  readonly faces: { family: string; bytes: number[] }[];
}

/** A font set and a constructor that write into `log`; `failing` names families whose load rejects. */
function fontsFor(root: Element, log: Log, failing: readonly string[] = []) {
  Object.defineProperty(root.ownerDocument, 'fonts', {
    configurable: true,
    value: {
      clear: () => log.calls.push('clear'),
      add: (face: { family: string }) => log.calls.push(`add ${face.family}`),
      get ready() {
        log.calls.push('ready');
        return Promise.resolve();
      },
    },
  });
  return {
    createFont: (family: string, bytes: ArrayBuffer) => {
      log.calls.push(`create ${family}`);
      log.faces.push({ family, bytes: [...new Uint8Array(bytes)] });
      return {
        family,
        load: () => {
          log.calls.push(`load ${family}`);
          return failing.includes(family)
            ? Promise.reject(new Error('OTS parsing error'))
            : Promise.resolve();
        },
      };
    },
  };
}

const bytes = {
  'asset-image': [137, 80, 78, 71, 1, 2, 3],
  'asset-audio': [82, 73, 70, 70],
  'asset-font': [0, 1, 0, 0, 9],
};

/** The assets as a host posts them: `{ id, mediaType, bytes }` with an `ArrayBuffer`. */
function assets(overrides: Record<string, unknown> = {}): unknown[] {
  return [
    {
      id: 'asset-image',
      mediaType: 'image/png',
      bytes: Uint8Array.from(bytes['asset-image']).buffer,
    },
    {
      id: 'asset-audio',
      mediaType: 'audio/wav',
      bytes: Uint8Array.from(bytes['asset-audio']).buffer,
    },
    { id: 'asset-font', mediaType: 'font/ttf', bytes: Uint8Array.from(bytes['asset-font']).buffer },
  ].map((asset) => ({ ...asset, ...(overrides[asset.id] as object | undefined) }));
}

function setUp(failing: readonly string[] = []) {
  const window = createWindow();
  const root = createRoot(window);
  const log: Log = { calls: [], faces: [] };
  const host = fontsFor(root, log, failing);
  // Records when the tree is mounted, relative to the font calls.
  new window.MutationObserver(() => log.calls.push('mounted')).observe(root, { childList: true });
  return { window, root, log, host };
}

const document = JSON.parse(JSON.stringify(reference)) as unknown;

describe('KadrionRuntime.load (D27.1)', () => {
  it('clears the font set, loads and adds the face, waits for the set, and only then mounts', async () => {
    const { root, log, host } = setUp();
    await expect(load(root, document, assets(), host)).resolves.toEqual({ ok: true });
    await Promise.resolve();
    expect(log.calls).toEqual([
      'clear',
      'create kadrion-font-asset-font',
      'load kadrion-font-asset-font',
      'add kadrion-font-asset-font',
      'ready',
      'mounted',
    ]);
    expect(log.faces).toEqual([{ family: 'kadrion-font-asset-font', bytes: bytes['asset-font'] }]);
  });

  it('mounts with data: URLs of the exact bytes, in RFC 4648 base64', async () => {
    const { root, host } = setUp();
    await load(root, document, assets(), host);
    const image = root.querySelector('img');
    const expected = Buffer.from(bytes['asset-image']).toString('base64');
    expect(image?.getAttribute('src')).toBe(`data:image/png;base64,${expected}`);
    expect(describeRoot(root)).toHaveLength(1);
  });

  it('writes base64 like Node.js for every length remainder and every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    for (const length of [0, 1, 2, 3, 4, 5, 255, 256]) {
      const slice = all.subarray(0, length);
      expect(base64(slice), String(length)).toBe(Buffer.from(slice).toString('base64'));
    }
  });

  it('registers only fonts that a text node uses, and none without text', async () => {
    const withoutText = derived((draft) => {
      const scene = draft.scenes[0];
      if (scene === undefined) throw new Error('no scene');
      scene.nodes = scene.nodes.filter((node) => node.type !== 'text');
      const group = scene.nodes.find((node) => node.type === 'group');
      if (group?.type === 'group') group.children = group.children.filter((c) => c.type !== 'text');
    });
    const { root, log } = setUp();
    // No constructor is needed when there is nothing to draw with it.
    await expect(
      load(root, JSON.parse(JSON.stringify(withoutText)), assets(), {}),
    ).resolves.toEqual({ ok: true });
    expect(log.calls.filter((call) => call !== 'mounted')).toEqual(['clear', 'ready']);
  });

  it('yields the errors of an invalid document and touches nothing', async () => {
    const { root, log, host } = setUp();
    const result = await load(root, { ...(document as object), fps: 0 }, assets(), host);
    expect(result.ok).toBe(false);
    expect(log.calls).toEqual([]);
  });

  it.each([
    ['not an array', {}, 'asset-url-invalid'],
    ['an extra key', assets({ 'asset-font': { extra: 1 } }), 'asset-url-invalid'],
    [
      'bytes that are not an ArrayBuffer',
      assets({ 'asset-font': { bytes: [0, 1] } }),
      'asset-url-invalid',
    ],
    [
      'a malformed media type',
      assets({ 'asset-image': { mediaType: 'png' } }),
      'asset-url-invalid',
    ],
    ['an ID twice', [...assets(), assets()[0]], 'asset-url-invalid'],
    [
      'a missing font',
      assets().filter((asset) => (asset as { id: string }).id !== 'asset-font'),
      'asset-url-missing',
    ],
    [
      'an unknown ID',
      [...assets(), { id: 'asset-other', mediaType: 'image/png', bytes: new ArrayBuffer(1) }],
      'asset-url-unknown',
    ],
  ])('refuses %s before any font call or mount', async (_, given, code) => {
    const { root, log, host } = setUp();
    await expect(load(root, document, given, host)).rejects.toMatchObject({ code });
    expect(log.calls).toEqual([]);
  });

  it('fails with font-load-failed when the face does not load, and mounts nothing', async () => {
    const { root, log, host } = setUp(['kadrion-font-asset-font']);
    await expect(load(root, document, assets(), host)).rejects.toMatchObject({
      code: 'font-load-failed',
    });
    await Promise.resolve();
    expect(log.calls).toEqual([
      'clear',
      'create kadrion-font-asset-font',
      'load kadrion-font-asset-font',
    ]);
    expect(root.childNodes).toHaveLength(0);
  });

  it('fails with font-load-failed when the constructor throws', async () => {
    const { root } = setUp();
    const host = {
      createFont: () => {
        throw new SyntaxError('bad descriptor');
      },
    };
    await expect(load(root, document, assets(), host)).rejects.toMatchObject({
      code: 'font-load-failed',
    });
  });

  it('is readiness-unsupported without a font constructor or a font set', async () => {
    const { root } = setUp();
    await expect(load(root, document, assets(), {})).rejects.toMatchObject({
      code: 'readiness-unsupported',
    });
    const bare = createRoot(createWindow());
    await expect(
      load(bare, document, assets(), { createFont: () => ({ load: () => Promise.resolve() }) }),
    ).rejects.toMatchObject({ code: 'readiness-unsupported' });
    expect(bare.childNodes).toHaveLength(0);
  });

  it('gives every face a copy of its bytes', async () => {
    const { root, log, host } = setUp();
    const given = assets();
    await load(root, document, given, host);
    const font = given[2] as { bytes: ArrayBuffer };
    new Uint8Array(font.bytes).fill(7);
    expect(log.faces[0]?.bytes).toEqual(bytes['asset-font']);
  });
});
