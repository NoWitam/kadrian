/**
 * The Player against its real render page (D25), in jsdom through `harness.ts`.
 * What only a real browser shows — sandbox, policy, decoding, fonts, pixels — is
 * P1's automated browser test in pinned Chromium (PR-06).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RENDER_PAGE_POLICY } from '@kadrion/renderer-dom';
import {
  generateReferenceAssets,
  referenceComposition,
  referenceExpectedRender,
  type ExpectedElement,
  type ExpectedText,
} from '@kadrion/test-fixtures';
import type { DOMWindow } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPlayer,
  type Player,
  type PlayerAsset,
  type PlayerAssetRequest,
  type PlayerAssetResolver,
  type PlayerScheduler,
} from '../src/index.js';
import { PAGE_AGENT_SCRIPT } from '../src/agent.js';
import { createHarness, sleep, type Harness } from './harness.js';

const buildDirectory = new URL('../../renderer-dom/dist/runtime-build/', import.meta.url);
const artifact = new Uint8Array(
  readFileSync(fileURLToPath(new URL('kadrion-runtime.js', buildDirectory))),
);
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('kadrion-runtime.json', buildDirectory)), 'utf8'),
) as { contentHash: string };
const runtime = { bytes: artifact, contentHash: manifest.contentHash };

const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const bytesOf: Readonly<Record<string, PlayerAsset>> = {
  'asset-image': { bytes: image, mediaType: 'image/png' },
  'asset-font': { bytes: new Uint8Array([0, 1, 0, 0]), mediaType: 'font/ttf' },
  'asset-audio': { bytes: new Uint8Array([82, 73, 70, 70]), mediaType: 'audio/wav' },
};

async function hashOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return `sha256:${Buffer.from(digest).toString('hex')}`;
}

/**
 * The reference composition pinned to the test bytes (D14). Its own hashes are
 * those of the generated fixture assets (D27.5), which one test below uses.
 */
async function pinnedTo(
  document: unknown,
  bytes: Readonly<Record<string, PlayerAsset>>,
): Promise<unknown> {
  const copy = structuredClone(document) as { assets: { id: string; contentHash: string }[] };
  for (const asset of copy.assets) {
    const given = bytes[asset.id];
    if (given !== undefined) asset.contentHash = await hashOf(given.bytes);
  }
  return copy;
}

const pinned = await pinnedTo(referenceComposition, bytesOf);

/** A resolver over a map, recording what it was asked for. */
function resolverOf(
  map: Readonly<Record<string, PlayerAsset | undefined>>,
  asked: PlayerAssetRequest[] = [],
): PlayerAssetResolver {
  return (request) => {
    asked.push(request);
    return map[request.id] ?? null;
  };
}

const resolve = resolverOf(bytesOf);
const imageUrl = `data:image/png;base64,${Buffer.from(image).toString('base64')}`;
const goldenTimes = referenceExpectedRender.golden.map(({ timeUs }) => timeUs);

let players: Player[] = [];
afterEach(() => {
  for (const player of players) player.destroy();
  players = [];
});

async function started(
  harness: Harness,
  options: Partial<Parameters<typeof createPlayer>[1]> = {},
) {
  const player = await createPlayer(harness.container, { runtime, ...options });
  players.push(player);
  return player;
}

function pageFrame(harness: Harness): HTMLIFrameElement {
  const frame = harness.container.querySelector('iframe');
  if (frame === null) throw new Error('The Player made no frame.');
  return frame;
}

function pageView(harness: Harness): DOMWindow {
  return pageFrame(harness).contentWindow as unknown as DOMWindow;
}

/** The DOM below the render page's root, in the shape of the expected trees. */
function describe_(node: Node, view: DOMWindow): ExpectedElement | ExpectedText {
  if (node.nodeType === view.Node.TEXT_NODE) return { text: node.textContent ?? '' };
  const element = node as HTMLElement;
  return {
    tag: element.localName,
    attributes: Object.fromEntries(
      [...element.attributes]
        .filter(({ name }) => name !== 'style')
        .map(({ name, value }) => [name, value]),
    ),
    style: Object.fromEntries(
      Array.from({ length: element.style.length }, (_, index) => {
        const name = element.style.item(index);
        return [name, element.style.getPropertyValue(name)];
      }),
    ),
    children: [...element.childNodes].map((child) => describe_(child, view)),
  };
}

function shownTree(harness: Harness) {
  const view = pageView(harness);
  const root = view.document.getElementById('kadrion-root');
  if (root === null) throw new Error('The render page has no root.');
  return [...root.childNodes].map((child) => describe_(child, view));
}

/** The hand-derived tree, with the image URL that the page builds from the bytes. */
function expectedTree(timeUs: number) {
  const tree = referenceExpectedRender.golden.find((golden) => golden.timeUs === timeUs)?.tree;
  const text = JSON.stringify(tree).replace('https://assets.invalid/asset-image', imageUrl);
  return [JSON.parse(text) as ExpectedElement];
}

function barWidth(harness: Harness): string {
  const element = pageView(harness).document.querySelector('iframe');
  const view = element?.contentWindow as unknown as DOMWindow | null | undefined;
  return view?.document.getElementById('bar')?.style.width ?? 'no element';
}

describe('the render page the Player creates (D25.2, D25.5)', () => {
  it('is the renderer page with the verified runtime and the agent, in a sandboxed frame', async () => {
    const harness = createHarness();
    const player = await started(harness);
    const frame = pageFrame(harness);
    expect(frame.getAttributeNames()).toEqual(['sandbox', 'srcdoc', 'style']);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${RENDER_PAGE_POLICY}">`,
    );
    expect(srcdoc.split('<script>')).toHaveLength(3);
    expect(srcdoc.split(new TextDecoder().decode(artifact))).toHaveLength(2);
    expect(srcdoc).not.toMatch(/\ssrc=|\shref=/);
    expect(player.getState()).toEqual({
      status: 'empty',
      timeUs: null,
      runtimeHash: manifest.contentHash,
      error: null,
    });
  });

  it.each([
    ['another hash', { contentHash: `sha256:${'0'.repeat(64)}` }, 'runtime-hash-mismatch'],
    ['a malformed hash', { contentHash: 'sha256:abc' }, 'runtime-hash-mismatch'],
  ])('refuses a runtime build with %s, before any frame exists', async (_, change, code) => {
    const harness = createHarness();
    await expect(
      createPlayer(harness.container, { runtime: { ...runtime, ...change } }),
    ).rejects.toMatchObject({
      name: 'PlayerError',
      code,
    });
    expect(harness.container.childNodes).toHaveLength(0);
  });

  it.each([
    ['bytes that are not UTF-8', new Uint8Array([0xff, 0xfe, 0x00])],
    [
      'a runtime that would end its script element',
      new TextEncoder().encode('var a = "</script>";'),
    ],
  ])('refuses %s even with a matching hash', async (_, bytes) => {
    const harness = createHarness();
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    await expect(
      createPlayer(harness.container, { runtime: { bytes, contentHash: `sha256:${digest}` } }),
    ).rejects.toMatchObject({ code: 'runtime-unsafe' });
    expect(harness.container.childNodes).toHaveLength(0);
  });

  it('fails typed when the page never starts', async () => {
    const harness = createHarness({ loadFrames: false });
    await expect(
      createPlayer(harness.container, { runtime, requestTimeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: 'page-timeout',
    });
    expect(harness.container.childNodes).toHaveLength(0);
  });
});

describe('load and seek (P1, D25.3, D25.6)', () => {
  it('loads, shows frame 0, and reports ready only then', async () => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(pinned, resolve);
    expect(player.getState()).toMatchObject({ status: 'ready', timeUs: 0, error: null });
    expect(shownTree(harness)).toStrictEqual(expectedTree(0));
    expect(barWidth(harness)).toBe('0%');
    expect(pageFrame(harness).style.width).toBe('1080px');
    expect(pageFrame(harness).style.height).toBe('1920px');
  });

  it.each(goldenTimes)('shows the hand-derived frame at %i', async (timeUs) => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(pinned, resolve);
    await player.seek(timeUs);
    expect(player.getState()).toMatchObject({ status: 'ready', timeUs });
    expect(shownTree(harness)).toStrictEqual(expectedTree(timeUs));
    expect(barWidth(harness)).toBe(`${String(timeUs / 100_000)}%`);
  });

  it('shows the same frame whatever was shown before: fresh, after playing, after seeking back', async () => {
    const fresh = new Map<number, unknown>();
    for (const timeUs of goldenTimes) {
      const harness = createHarness();
      const player = await started(harness);
      await player.load(pinned, resolve);
      await player.seek(timeUs);
      fresh.set(timeUs, [shownTree(harness), barWidth(harness)]);
    }
    const harness = createHarness();
    const clock = manualScheduler();
    const player = await started(harness, { scheduler: clock.scheduler });
    await player.load(pinned, resolve);
    player.play();
    for (let step = 0; step < 5; step += 1) {
      clock.advance(40);
      await harness.settle();
    }
    player.pause();
    await harness.settle();
    for (const timeUs of [...goldenTimes].reverse()) {
      await player.seek(timeUs);
      expect([shownTree(harness), barWidth(harness)], String(timeUs)).toStrictEqual(
        fresh.get(timeUs),
      );
    }
  });

  it('lets a newer seek supersede a waiting one, and settles in order', async () => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(pinned, resolve);
    const order: string[] = [];
    const track = (name: string, promise: Promise<void>) =>
      promise.then(
        () => order.push(`${name} ready`),
        (error: unknown) => order.push(`${name} ${(error as { code: string }).code}`),
      );
    const all = [
      track('a', player.seek(2_500_000)),
      track('b', player.seek(5_000_000)),
      track('c', player.seek(7_500_000)),
    ];
    expect(player.getState().status).toBe('seeking');
    await Promise.all(all);
    expect(order).toEqual(['b superseded', 'a ready', 'c ready']);
    expect(player.getState()).toMatchObject({ status: 'ready', timeUs: 7_500_000 });
    expect(shownTree(harness)).toStrictEqual(expectedTree(7_500_000));
  });

  it.each([-1, 10_000_000, 0.5, Number.NaN])(
    'rejects the time %d before anything is sent',
    async (timeUs) => {
      const harness = createHarness();
      const player = await started(harness);
      await player.load(pinned, resolve);
      const before = harness.log.length;
      await expect(player.seek(timeUs)).rejects.toMatchObject({ code: 'time-out-of-range' });
      expect(harness.log).toHaveLength(before);
      expect(player.getState().status).toBe('ready');
    },
  );

  it('rejects a seek before a document was loaded', async () => {
    const harness = createHarness();
    const player = await started(harness);
    await expect(player.seek(0)).rejects.toMatchObject({ code: 'not-loaded' });
  });
});

describe('assets through the resolver of D14', () => {
  it('asks for every asset of the document once, in order, with its hash', async () => {
    const harness = createHarness();
    const player = await started(harness);
    const asked: PlayerAssetRequest[] = [];
    await player.load(pinned, resolverOf(bytesOf, asked));
    const declared = (pinned as { assets: { id: string; type: string; contentHash: string }[] })
      .assets;
    expect(asked).toEqual(declared);
    expect(asked.every((request) => Object.isFrozen(request))).toBe(true);
  });

  // The fixture's hashes are those of its generated bytes since PR-06 (D27.5):
  // exactly those bytes verify, and the test bytes of this file do not.
  it('verifies the fixture hashes with the generated bytes only', async () => {
    const harness = createHarness();
    const player = await started(harness);
    await expect(player.load(referenceComposition, resolve)).rejects.toMatchObject({
      code: 'asset-hash-mismatch',
    });
    const generated = Object.fromEntries(
      generateReferenceAssets().map(({ id, mediaType, bytes }) => [id, { mediaType, bytes }]),
    );
    await player.load(referenceComposition, resolverOf(generated));
    expect(player.getState()).toMatchObject({ status: 'ready', timeUs: 0 });
  });

  it('sends the page exactly the verified bytes, whatever the caller does later', async () => {
    const harness = createHarness();
    const player = await started(harness);
    const font = new Uint8Array([0, 1, 0, 0]);
    const handOver: PlayerAssetResolver = (request) => {
      if (request.id !== 'asset-font') return bytesOf[request.id] ?? null;
      // The caller changes the bytes right after handing them over.
      setTimeout(() => {
        font[0] = 9;
      }, 0);
      return { bytes: font, mediaType: 'font/ttf' };
    };
    const loading = player.load(pinned, handOver);
    await loading;
    const load = harness.log.find(
      (delivery) => (delivery.data as { type?: string }).type === 'kadrion-player:load',
    );
    const sent = (load?.data as { assets: { id: string; bytes: ArrayBuffer }[] }).assets;
    const fontBytes = sent.find((asset) => asset.id === 'asset-font')?.bytes;
    expect([...new Uint8Array(fontBytes ?? new ArrayBuffer(0))]).toEqual([0, 1, 0, 0]);
    expect(sent.map((asset) => asset.id)).toEqual(['asset-image', 'asset-audio', 'asset-font']);
  });
});

describe('fonts from the verified bytes (D27.1, D27.2)', () => {
  it('registers the font a text node uses, with its family and its verified bytes, once', async () => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(pinned, resolve);
    const faces = harness.fontsOf(pageView(harness) as unknown as Window);
    expect(faces.map(({ family }) => family)).toEqual(['kadrion-font-asset-font']);
    expect([...new Uint8Array(faces[0]?.bytes ?? new ArrayBuffer(0))]).toEqual([0, 1, 0, 0]);
    // A second load clears the set first, so the page never holds a face of an older document.
    await player.load(pinned, resolve);
    expect(harness.fontsOf(pageView(harness) as unknown as Window)).toHaveLength(1);
  });

  it('leaves the bytes to the artifact: the agent has no URL or base64 code of its own', () => {
    for (const fragment of ['btoa', 'base64', 'data:', 'fromCharCode', 'mount(']) {
      expect(PAGE_AGENT_SCRIPT).not.toContain(fragment);
    }
    expect(PAGE_AGENT_SCRIPT).toContain('.load(');
    expect(PAGE_AGENT_SCRIPT).toContain('createFont');
  });
});

describe('typed errors before the first frame, never ready (P1, D25.7)', () => {
  const tampered = {
    ...bytesOf,
    'asset-font': { bytes: new Uint8Array([7]), mediaType: 'font/ttf' },
  };
  const failing: PlayerAssetResolver = (request) => {
    if (request.id === 'asset-audio') throw new Error('storage is down');
    return bytesOf[request.id] ?? null;
  };

  it.each([
    [
      'a missing asset',
      pinned,
      resolverOf({ ...bytesOf, 'asset-image': undefined }),
      'asset-missing',
    ],
    ['a resolver that fails', pinned, failing, 'asset-missing'],
    ['bytes with another hash', pinned, resolverOf(tampered), 'asset-hash-mismatch'],
    [
      'an asset without a media type',
      pinned,
      resolverOf({
        ...bytesOf,
        'asset-font': { bytes: new Uint8Array([0, 1, 0, 0]), mediaType: 'font' },
      }),
      'asset-invalid',
    ],
    ['an invalid document', { ...(pinned as object), fps: 0 }, resolve, 'invalid-document'],
  ])('reports %s', async (_, document, given, code) => {
    const harness = createHarness();
    const player = await started(harness);
    await expect(player.load(document, given)).rejects.toMatchObject({ name: 'PlayerError', code });
    expect(player.getState()).toMatchObject({ status: 'error', timeUs: null, error: { code } });
    expect(shownTree(harness)).toEqual([]);
  });

  // D25.4: the Player refuses these itself; the page never sees them.
  it.each([
    ['a missing asset', pinned, resolverOf({ ...bytesOf, 'asset-image': undefined })],
    ['bytes with another hash', pinned, resolverOf(tampered)],
    ['an invalid document', { ...(pinned as object), fps: 0 }, resolve],
  ])('sends nothing to the page for %s', async (_, document, given) => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(document, given).catch(() => undefined);
    await harness.settle();
    const toPage = harness.log.filter(
      (delivery) => delivery.target === (pageView(harness) as unknown as Window),
    );
    expect(toPage).toEqual([]);
  });

  it('lists the validation errors of an invalid document', async () => {
    const harness = createHarness();
    const player = await started(harness);
    const error: unknown = await player
      .load({ ...(pinned as object), fps: 0 }, resolve)
      .catch((reason: unknown) => reason);
    expect((error as { details: string[] }).details.join('\n')).toContain('/fps');
  });

  it('reports a font that does not load before anything is mounted (D27.1)', async () => {
    const harness = createHarness({ font: 'reject' });
    const player = await started(harness);
    await expect(player.load(pinned, resolve)).rejects.toMatchObject({
      code: 'font-load-failed',
    });
    expect(player.getState()).toMatchObject({ status: 'error', timeUs: null });
    expect(shownTree(harness)).toEqual([]);
    expect(harness.fontsOf(pageView(harness) as unknown as Window)).toEqual([]);
  });

  it('reports an image that cannot be decoded', async () => {
    const harness = createHarness({ decode: 'reject' });
    const player = await started(harness);
    await expect(player.load(pinned, resolve)).rejects.toMatchObject({
      code: 'asset-decode-failed',
    });
    expect(player.getState().status).toBe('error');
  });

  it('reports a Custom HTML element that never answers, and is never ready', async () => {
    const silent = structuredClone(pinned) as {
      scenes: { nodes: { id: string; html?: string }[] }[];
    };
    const node = silent.scenes[0]?.nodes.find((candidate) => candidate.id === 'node-custom-html');
    if (node !== undefined) node.html = '<p>silent</p>';
    const harness = createHarness();
    const player = await started(harness, { ackTimeoutMs: 20 });
    await expect(player.load(silent, resolve)).rejects.toMatchObject({
      code: 'custom-html-timeout',
    });
    expect(player.getState()).toMatchObject({ status: 'error', timeUs: null });
    // The frame was rendered, but it is not reported: preview may be stale, never ready.
    expect(shownTree(harness)).not.toEqual([]);
  });
});

describe('one request at a time (D25.4, D25.6)', () => {
  it('lets a load wait for the seek in flight, and settles both', async () => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(pinned, resolve);
    const seek = player.seek(5_000_000);
    const load = player.load(pinned, resolve);
    await expect(seek).resolves.toBeUndefined();
    await expect(load).resolves.toBeUndefined();
    expect(player.getState()).toMatchObject({ status: 'ready', timeUs: 0, error: null });
    expect(shownTree(harness)).toStrictEqual(expectedTree(0));
  });

  it('lets a load supersede a waiting seek while playing', async () => {
    const harness = createHarness();
    const clock = manualScheduler();
    const player = await started(harness, { scheduler: clock.scheduler });
    await player.load(pinned, resolve);
    player.play();
    clock.advance(100);
    const waiting = player.seek(7_500_000);
    const inFlight = player.seek(2_500_000);
    const load = player.load(pinned, resolve);
    const outcomes = await Promise.allSettled([waiting, inFlight, load]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'rejected',
      'rejected',
      'fulfilled',
    ]);
    expect(clock.frames()).toBe(0);
    expect(player.getState()).toMatchObject({ status: 'ready', timeUs: 0 });
  });

  it('ignores the late result of a request that timed out', async () => {
    const silent = structuredClone(pinned) as {
      scenes: { nodes: { id: string; html?: string }[] }[];
    };
    const node = silent.scenes[0]?.nodes.find((candidate) => candidate.id === 'node-custom-html');
    if (node !== undefined) node.html = '<p>silent</p>';
    const harness = createHarness();
    const player = await started(harness, { ackTimeoutMs: 150, requestTimeoutMs: 50 });
    await expect(player.load(silent, resolve)).rejects.toMatchObject({ code: 'page-timeout' });
    await sleep(250);
    await harness.settle();
    // The page's own answer (custom-html-timeout) came late and changed nothing.
    expect(harness.log.some((delivery) => (delivery.data as { ok?: boolean }).ok === false)).toBe(
      true,
    );
    expect(player.getState()).toMatchObject({ status: 'error', error: { code: 'page-timeout' } });
  });
});

describe('messages from anyone but the page or the Player (D25.4)', () => {
  it('ignores a ready message from anyone but its own page', async () => {
    const harness = createHarness({ loadFrames: false });
    const stranger = harness.window.document.createElement('iframe');
    harness.window.document.body.append(stranger);
    const starting = createPlayer(harness.container, { runtime, requestTimeoutMs: 80 });
    await sleep(20);
    const ready = { type: 'kadrion-player:ready', version: 1 };
    await harness.deliver(harness.window as unknown as Window, ready, stranger.contentWindow);
    await harness.deliver(harness.window as unknown as Window, ready, harness.window);
    await expect(starting).rejects.toMatchObject({ code: 'page-timeout' });
  });

  it('ignores a forged result for the pending request', async () => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(pinned, resolve);
    const stranger = harness.window.document.createElement('iframe');
    harness.window.document.body.append(stranger);
    const pending = player.seek(5_000_000);
    const lastRequest = harness.log
      .filter((delivery) => delivery.target === (pageView(harness) as unknown as Window))
      .at(-1);
    const requestId = (lastRequest?.data as { requestId: number }).requestId;
    const failure = { code: 'custom-html-timeout', message: 'forged', details: [] };
    const forged = {
      type: 'kadrion-player:result',
      version: 1,
      requestId,
      ok: false,
      error: failure,
    };
    await harness.deliver(harness.window as unknown as Window, forged, stranger.contentWindow);
    await harness.deliver(harness.window as unknown as Window, forged, harness.window);
    await pending;
    expect(player.getState()).toMatchObject({ status: 'ready', timeUs: 5_000_000, error: null });
  });

  it.each([
    ['an extra key', { frame: 297 }],
    ['another version', { version: 2 }],
    ['a fractional time', { timeUs: 0.5 }],
  ])('lets the page ignore a request from its parent with %s', async (_, change) => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(pinned, resolve);
    const view = pageView(harness) as unknown as Window;
    const seek = { type: 'kadrion-player:seek', version: 1, requestId: 98, timeUs: 9_900_000 };
    await harness.deliver(view, { ...seek, ...change }, harness.parentOf(view));
    await harness.settle();
    await sleep(10);
    expect(shownTree(harness)).toStrictEqual(expectedTree(0));
    // The same request without the change is served, so only the change was refused.
    await harness.deliver(view, seek, harness.parentOf(view));
    await harness.settle();
    await sleep(20);
    await harness.settle();
    expect(shownTree(harness)).toStrictEqual(expectedTree(9_900_000));
  });

  it('lets the page ignore a request whose source is not its parent', async () => {
    const harness = createHarness();
    const player = await started(harness);
    await player.load(pinned, resolve);
    const view = pageView(harness) as unknown as Window;
    const element = pageView(harness).document.querySelector('iframe')?.contentWindow;
    const seek = { type: 'kadrion-player:seek', version: 1, requestId: 99, timeUs: 9_900_000 };
    await harness.deliver(view, seek, element);
    await harness.deliver(view, seek, harness.window);
    await harness.settle();
    await sleep(10);
    expect(shownTree(harness)).toStrictEqual(expectedTree(0));
    expect(
      harness.log.some(
        (delivery) =>
          (delivery.data as { requestId?: number }).requestId === 99 && delivery.target !== view,
      ),
    ).toBe(false);
  });
});

function manualScheduler() {
  let now = 0;
  let callbacks = new Map<number, () => void>();
  let next = 1;
  const scheduler: PlayerScheduler = {
    now: () => now,
    requestFrame: (callback) => {
      callbacks.set(next, callback);
      return next++;
    },
    cancelFrame: (handle) => {
      callbacks.delete(handle);
    },
  };
  return {
    scheduler,
    frames: () => callbacks.size,
    advance(milliseconds: number) {
      now += milliseconds;
      const due = callbacks;
      callbacks = new Map();
      for (const callback of due.values()) callback();
    },
  };
}

describe('play and pause with the preview clock (D25.6)', () => {
  it('plays on the frame grid, skips ticks while a seek is in flight, and stops at the last frame', async () => {
    const harness = createHarness();
    const clock = manualScheduler();
    const player = await started(harness, { scheduler: clock.scheduler });
    await player.load(pinned, resolve);
    const seeks = () =>
      harness.log
        .filter((delivery) => (delivery.data as { type?: string }).type === 'kadrion-player:seek')
        .map((delivery) => (delivery.data as { timeUs: number }).timeUs);
    const before = seeks().length;
    player.play();
    expect(player.getState().status).toBe('playing');
    clock.advance(100);
    // 100 ms at 30 fps is frame 3, which starts at 100 000 µs (D13).
    clock.advance(1);
    await harness.settle();
    await sleep(5);
    expect(seeks().slice(before)).toEqual([100_000]);
    expect(player.getState()).toMatchObject({ status: 'playing', timeUs: 100_000 });
    clock.advance(20_000);
    await harness.settle();
    await sleep(5);
    await harness.settle();
    expect(seeks().at(-1)).toBe(9_966_666);
    expect(clock.frames()).toBe(0);
    expect(player.getState()).toMatchObject({ status: 'ready', timeUs: 9_966_666 });
  });

  it('stops when paused', async () => {
    const harness = createHarness();
    const clock = manualScheduler();
    const player = await started(harness, { scheduler: clock.scheduler });
    await player.load(pinned, resolve);
    player.play();
    player.pause();
    expect(clock.frames()).toBe(0);
    expect(player.getState().status).toBe('ready');
  });
});

describe('destroy', () => {
  it('rejects what is pending and removes the page', async () => {
    const harness = createHarness();
    const player = await createPlayer(harness.container, { runtime });
    await player.load(pinned, resolve);
    const pending = player.seek(5_000_000);
    player.destroy();
    await expect(pending).rejects.toMatchObject({ code: 'destroyed' });
    expect(harness.container.childNodes).toHaveLength(0);
  });
});
