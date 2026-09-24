/**
 * P1 in Chromium (D25, D28.5): the built Player in a page, served by the test
 * without a server, loads the reference composition and seeks to the five
 * golden timestamps. The same launch, context, barrier, and capture as the
 * Producer's are used. The Player must show the same pixels for a golden
 * timestamp whatever it showed before. Parity with the Producer is measured by
 * `parity.pinned.test.ts` in the conformance host of D33.
 * Informative outside the pinned environment: P1 is proven only there.
 */
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

import {
  awaitPresented,
  captureFrame,
  contextOptions,
  launchChromium,
  renderFrames,
  type LaunchedChromium,
  type RenderResult,
} from '@kadrion/producer';
import { goldenTimestamps, referenceComposition } from '@kadrion/test-fixtures';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ISOLATION_PROBE } from './probes.js';
import {
  customHtmlNode,
  expectedTree,
  fontsUsed,
  frameSession,
  HEIGHT,
  inSinglePrecision,
  referenceResolver,
  repoRoot,
  pixelReport,
  samePixels,
  shownTree,
  variant,
  WIDTH,
} from './support.js';

const ORIGIN = 'http://localhost:4521';
/** The application page's policy; the render page is its `srcdoc` and inherits it (D23.6). */
const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const PACKAGES = ['player', 'renderer-dom', 'runtime', 'schema', 'test-fixtures'];
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden}</style>
<script type="importmap">${JSON.stringify({
  imports: Object.fromEntries(
    PACKAGES.map((name) => [`@kadrion/${name}`, `/pkg/${name}/index.js`]),
  ),
})}</script>
<script type="module">
import { createPlayer } from '@kadrion/player';
import { generateReferenceAssets, referenceComposition } from '@kadrion/test-fixtures';
const assets = Object.fromEntries(generateReferenceAssets().map((asset) => [asset.id, asset]));
let player;
window.p1 = {
  async start() {
    const [bytes, manifest] = await Promise.all([
      fetch('/runtime/kadrion-runtime.js').then((response) => response.arrayBuffer()),
      fetch('/runtime/kadrion-runtime.json').then((response) => response.json()),
    ]);
    player = await createPlayer(document.getElementById('stage'), {
      runtime: { bytes: new Uint8Array(bytes), contentHash: manifest.contentHash },
    });
    return manifest.contentHash;
  },
  load(json) {
    return player.load(json === undefined ? referenceComposition : JSON.parse(json), ({ id }) => assets[id] ?? null);
  },
  seek: (timeUs) => player.seek(timeUs),
  play: () => player.play(),
  pause: () => player.pause(),
  state() {
    const state = player.getState();
    return { status: state.status, timeUs: state.timeUs, runtimeHash: state.runtimeHash, error: state.error && state.error.code };
  },
};
window.p1ready = true;
</script></head><body><div id="stage"></div></body></html>`;

interface P1Window {
  readonly p1: {
    start(): Promise<string>;
    load(json?: string): Promise<void>;
    seek(timeUs: number): Promise<void>;
    play(): void;
    pause(): void;
    state(): { status: string; timeUs: number | null; runtimeHash: string; error: string | null };
  };
}

/** A file of the built packages, or `null` for anything the harness does not serve. */
function served(pathname: string): { body: Buffer; type: string } | null {
  if (pathname === '/') return { body: Buffer.from(HARNESS), type: 'text/html; charset=utf-8' };
  const runtime = /^\/runtime\/(kadrion-runtime\.(?:js|json))$/.exec(pathname);
  const pkg = /^\/pkg\/([a-z-]+)\/(.+)$/.exec(pathname);
  let file: string | null = null;
  if (runtime?.[1] !== undefined) {
    file = join(repoRoot, 'packages', 'renderer-dom', 'dist', 'runtime-build', runtime[1]);
  } else if (pkg?.[1] !== undefined && pkg[2] !== undefined && PACKAGES.includes(pkg[1])) {
    const base = join(repoRoot, 'packages', pkg[1], 'dist');
    const candidate = normalize(join(base, ...pkg[2].split('/')));
    if (candidate.startsWith(base + sep)) file = candidate;
  }
  const type = file === null ? undefined : TYPES[extname(file)];
  if (file === null || type === undefined) return null;
  return { body: readFileSync(file), type };
}

interface PlayerPage {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly renderFrame: Frame;
  readonly runtimeHash: string;
  readonly unexpected: string[];
  readonly fromRenderPage: string[];
}

let chromium: LaunchedChromium;
let producer: RenderResult;
const times = goldenTimestamps.map(({ timeUs }) => timeUs);

async function openPlayer(json?: string): Promise<PlayerPage> {
  const context = await chromium.browser.newContext(contextOptions(WIDTH, HEIGHT));
  const unexpected: string[] = [];
  const fromRenderPage: string[] = [];
  let renderFrame: Frame | null = null;
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let frame: Frame | null;
    try {
      frame = request.frame();
    } catch {
      frame = null;
    }
    if (renderFrame !== null && frame !== null && frame !== frame.page().mainFrame()) {
      fromRenderPage.push(request.url());
    }
    const file = url.origin === ORIGIN ? served(url.pathname) : null;
    if (file === null) {
      unexpected.push(request.url());
      return route.abort('blockedbyclient');
    }
    return route.fulfill({
      status: 200,
      body: file.body,
      headers: {
        'content-type': file.type,
        'content-security-policy': PAGE_POLICY,
        'cache-control': 'no-store',
      },
    });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'p1ready' in window);
  const runtimeHash = await page.evaluate(() => (window as unknown as P1Window).p1.start());
  const found = page.mainFrame().childFrames()[0];
  if (found === undefined) throw new Error('The Player made no frame.');
  renderFrame = found;
  await page.evaluate((text) => (window as unknown as P1Window).p1.load(text), json);
  return {
    context,
    page,
    renderFrame: found,
    runtimeHash,
    unexpected,
    fromRenderPage,
  };
}

/** Seeks, waits until every frame of the page has presented, and captures (D28.5). */
async function seekAndCapture(player: PlayerPage, timeUs: number): Promise<Uint8Array> {
  await player.page.evaluate((time) => (window as unknown as P1Window).p1.seek(time), timeUs);
  const state = await player.page.evaluate(() => (window as unknown as P1Window).p1.state());
  expect(state).toMatchObject({ status: 'ready', timeUs, error: null });
  await awaitPresented(player.page, 5_000);
  return captureFrame(player.page, WIDTH, HEIGHT);
}

async function closePlayer(player: PlayerPage): Promise<void> {
  await player.context.close();
}

const fresh = new Map<number, Uint8Array>();
/**
 * Each golden timestamp as the very first frame of its own page: the Player's
 * `load` always shows frame 0 first, so no Player capture is free of history.
 * These Producer renders are, which is what makes the comparison below
 * discriminate a renderer that keeps something from an earlier frame.
 */
const firstFrames = new Map<number, Uint8Array>();

beforeAll(async () => {
  chromium = await launchChromium();
  producer = await renderFrames({
    document: referenceComposition,
    resolveAsset: referenceResolver,
    timesUs: times,
    chromium,
  });
  for (const timeUs of times) {
    const only = await renderFrames({
      document: referenceComposition,
      resolveAsset: referenceResolver,
      timesUs: [timeUs],
      chromium,
    });
    firstFrames.set(timeUs, only.frames[0]?.png ?? new Uint8Array(0));
  }
  for (const timeUs of times) {
    const player = await openPlayer();
    try {
      fresh.set(timeUs, await seekAndCapture(player, timeUs));
    } finally {
      await closePlayer(player);
    }
  }
});

afterAll(async () => {
  await chromium.browser.close();
});

describe('P1: the Player in Chromium (D25)', () => {
  it('runs the byte-identical runtime build that the Producer runs (§5 P2, D25.5)', async () => {
    const player = await openPlayer();
    try {
      const state = await player.page.evaluate(() => (window as unknown as P1Window).p1.state());
      expect(state.runtimeHash).toBe(player.runtimeHash);
      expect(state.runtimeHash).toBe(producer.manifest.runtime.contentHash);
    } finally {
      await closePlayer(player);
    }
  });

  it('embeds the render page unscaled at the top-left corner, at device pixel ratio 1', async () => {
    const player = await openPlayer();
    try {
      const box = await player.page.evaluate(() => {
        const frame = document.querySelector('iframe');
        const rect = frame?.getBoundingClientRect();
        const style = frame === null ? null : getComputedStyle(frame);
        return {
          rect: rect && [rect.x, rect.y, rect.width, rect.height],
          border: style?.borderTopWidth,
          sandbox: frame?.getAttribute('sandbox'),
        };
      });
      expect(box).toEqual({ rect: [0, 0, WIDTH, HEIGHT], border: '0px', sandbox: 'allow-scripts' });
      const view = await player.renderFrame.evaluate(() => ({
        dpr: devicePixelRatio,
        origin: self.origin,
      }));
      expect(view).toEqual({ dpr: 1, origin: 'null' });
    } finally {
      await closePlayer(player);
    }
  });

  it('shows the same pixels for a golden timestamp whatever it showed before', async () => {
    const player = await openPlayer();
    try {
      await player.page.evaluate(() => {
        (window as unknown as P1Window).p1.play();
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await player.page.evaluate(() => {
        (window as unknown as P1Window).p1.pause();
      });
      for (const timeUs of times) {
        // After playing (and the previous seeks), then after a seek from the far side.
        const afterPlay = await seekAndCapture(player, timeUs);
        await seekAndCapture(player, timeUs === 9_900_000 ? 0 : 9_900_000);
        const afterSeekBack = await seekAndCapture(player, timeUs);
        const first = firstFrames.get(timeUs) ?? new Uint8Array(0);
        const loaded = fresh.get(timeUs) ?? new Uint8Array(0);
        expect(
          samePixels(first, loaded),
          pixelReport(`${String(timeUs)} after a fresh load`, first, loaded),
        ).toBe(true);
        expect(
          samePixels(first, afterPlay),
          pixelReport(`${String(timeUs)} after play`, first, afterPlay),
        ).toBe(true);
        expect(
          samePixels(first, afterSeekBack),
          pixelReport(`${String(timeUs)} after a seek back`, first, afterSeekBack),
        ).toBe(true);
      }
    } finally {
      await closePlayer(player);
    }
  });

  it('holds the hand-derived tree, draws text with the fixture font only, and loads nothing else', async () => {
    const player = await openPlayer();
    try {
      for (const timeUs of times) {
        await seekAndCapture(player, timeUs);
        const shown = await shownTree(player.renderFrame, expectedTree(timeUs));
        expect(inSinglePrecision(shown), String(timeUs)).toEqual(
          inSinglePrecision(expectedTree(timeUs)),
        );
      }
      expect(await fontsUsed(await frameSession(player.page, player.renderFrame))).toEqual({
        'node-title': [{ familyName: 'Kadrion Fixture', isCustomFont: true, glyphCount: 7 }],
        'node-caption': [{ familyName: 'Kadrion Fixture', isCustomFont: true, glyphCount: 23 }],
      });
      expect(player.unexpected).toEqual([]);
      expect(player.fromRenderPage).toEqual([]);
    } finally {
      await closePlayer(player);
    }
  });

  it('isolates a Custom HTML element as the Producer does (§7.6)', async () => {
    const probed = variant((draft) => {
      customHtmlNode(draft).html = ISOLATION_PROBE;
    });
    const player = await openPlayer(JSON.stringify(probed.document));
    try {
      const element = player.renderFrame.childFrames()[0];
      if (element === undefined) throw new Error('No element frame.');
      await element.waitForFunction(
        () => document.documentElement.hasAttribute('data-probe'),
        undefined,
        {
          timeout: 10_000,
        },
      );
      const probe = JSON.parse(
        await element.evaluate(() => document.documentElement.getAttribute('data-probe') ?? '{}'),
      ) as Record<string, string>;
      expect(probe.origin).toBe('null');
      for (const name of [
        'parent.document',
        'top.document',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'document.cookie',
        'fetch',
        'XMLHttpRequest',
        'WebSocket',
        'image',
        'font',
        'Worker',
        'window.open',
        'top.location=',
      ]) {
        expect(probe[name], name).toMatch(/^blocked:/);
      }
      expect(await player.page.evaluate(() => location.href)).toBe(`${ORIGIN}/`);
    } finally {
      await closePlayer(player);
    }
  });
});
