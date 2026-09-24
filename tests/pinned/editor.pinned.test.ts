/**
 * P3 in Chromium (D30.10): a real pointer drags `node-title` on the canvas, one
 * `SetNodePosition` reaches the bus of `@kadrion/editor-sdk`, and the Player
 * re-renders from the document the bus returns.
 *
 * This is where the two things jsdom cannot prove are measured. First the
 * conversion factor: jsdom performs no layout, so the unit test stubs the
 * surface's box and would pass just as happily on a wrong scale; here the
 * browser lays the overlay out and a drag of a known number of client pixels
 * must move the document by that number divided by the preview scale. Second
 * the pixels: the frame after the command must really differ from the frame
 * before it, and undo must bring the first frame back.
 *
 * It earned its place on the first run: the gesture listened on the grip and
 * took a pointer capture, which works in jsdom and not in Chromium, where the
 * sandboxed render frame runs out of process (D26) and swallowed every move
 * after the first. The page below loads the playground's own built `app.js`
 * and `drag.js`, so what runs here is the module that ships, not a copy of it.
 *
 * Frames are compared with frames of the same run, so the test is meaningful
 * outside the pinned environment too; only the golden frames of D26.2 are not.
 */
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

import {
  awaitPresented,
  captureFrame,
  contextOptions,
  launchChromium,
  type LaunchedChromium,
} from '@kadrion/producer';
import { referenceComposition } from '@kadrion/test-fixtures';
import type { BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HEIGHT,
  pixelReport,
  repoRoot,
  samePixels,
  variant,
  WIDTH,
  type Draft,
} from './support.js';

const ORIGIN = 'http://localhost:4522';
const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const PACKAGES = ['editor-sdk', 'player', 'renderer-dom', 'runtime', 'schema', 'test-fixtures'];
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const NODE_ID = 'node-title';
const START = { x: 90, y: 160 };
/** The title's opacity animation reaches 1 here, so the text is at its most visible. */
const AT = 7_500_000;
const GRIP = 140;

/**
 * The playground's arrangement — the stage and an overlay of the same canvas
 * box under the same scale, and one grip — driven by the playground's own
 * `wireEditor`. The only thing this page adds is a counting wrapper around the
 * Player, so that the test can wait for the re-render the editor asks for.
 */
function harness(scale: number): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;padding:0;overflow:hidden}
#viewport{position:relative;width:${String(WIDTH * scale)}px;height:${String(HEIGHT * scale)}px;overflow:hidden}
#stage,#overlay{transform:scale(${String(scale)});transform-origin:0 0}
#overlay{position:absolute;inset:0;pointer-events:none}
#grip{position:absolute;box-sizing:border-box;pointer-events:auto;touch-action:none}
</style>
<script type="importmap">${JSON.stringify({
    imports: Object.fromEntries(
      PACKAGES.map((name) => [`@kadrion/${name}`, `/pkg/${name}/index.js`]),
    ),
  })}</script>
<script type="module">
import { busFor, sizeCanvas, wireEditor } from '/app/app.js';
import { createPlayer } from '@kadrion/player';
import { generateReferenceAssets, referenceComposition } from '@kadrion/test-fixtures';

const assets = Object.fromEntries(generateReferenceAssets().map((asset) => [asset.id, asset]));
const resolve = ({ id }) => assets[id] ?? null;
let player;
let bus;
let editor;
window.e = {
  errors: [],
  renders: 0,
  async start() {
    const [bytes, manifest] = await Promise.all([
      fetch('/runtime/kadrion-runtime.js').then((response) => response.arrayBuffer()),
      fetch('/runtime/kadrion-runtime.json').then((response) => response.json()),
    ]);
    bus = busFor(referenceComposition);
    const elements = {
      stage: document.getElementById('stage'),
      overlay: document.getElementById('overlay'),
      grip: document.getElementById('grip'),
    };
    // Before the Player, exactly as main.ts does it.
    sizeCanvas(elements, bus.getDocument());
    player = await createPlayer(elements.stage, {
      runtime: { bytes: new Uint8Array(bytes), contentHash: manifest.contentHash },
    });
    const counted = {
      // Counted when the load has FINISHED: a render that is still building its
      // frames is not one the test may capture.
      load: async (composition, resolveAsset) => {
        await player.load(composition, resolveAsset);
        window.e.renders += 1;
      },
      seek: (timeUs) => player.seek(timeUs),
      getState: () => player.getState(),
    };
    editor = wireEditor({
      bus,
      player: counted,
      elements,
      resolve,
      nodeId: ${JSON.stringify(NODE_ID)},
      gripSize: ${String(GRIP)},
      onError: (reason) => { window.e.errors.push(reason.code ?? String(reason)); },
    });
    await editor.show();
    window.e.renders = 0;
    return manifest.contentHash;
  },
  position: () => editor.position(),
  document: () => JSON.stringify(bus.getDocument()),
  seek: (timeUs) => player.seek(timeUs),
  state: () => ({ status: player.getState().status, timeUs: player.getState().timeUs }),
  undo: () => editor.undo(),
};
window.eready = true;
</script></head><body>
<div id="viewport"><div id="stage"></div><div id="overlay"><div id="grip"></div></div></div>
</body></html>`;
}

interface EditorWindow {
  readonly e: {
    readonly errors: string[];
    readonly renders: number;
    start(): Promise<string>;
    position(): { x: number; y: number };
    document(): string;
    seek(timeUs: number): Promise<void>;
    state(): { status: string; timeUs: number | null };
    undo(): Promise<void>;
  };
}

/** A file of the built packages, the playground's build, or the runtime artifact. */
function served(pathname: string, page: string): { body: Buffer; type: string } | null {
  if (pathname === '/') return { body: Buffer.from(page), type: 'text/html; charset=utf-8' };
  const runtime = /^\/runtime\/(kadrion-runtime\.(?:js|json))$/.exec(pathname);
  const app = /^\/app\/([a-z-]+\.js)$/.exec(pathname);
  const pkg = /^\/pkg\/([a-z-]+)\/(.+)$/.exec(pathname);
  let file: string | null = null;
  if (runtime?.[1] !== undefined) {
    file = join(repoRoot, 'packages', 'renderer-dom', 'dist', 'runtime-build', runtime[1]);
  } else if (app?.[1] !== undefined) {
    file = join(repoRoot, 'apps', 'playground', 'dist', app[1]);
  } else if (pkg?.[1] !== undefined && pkg[2] !== undefined && PACKAGES.includes(pkg[1])) {
    const base = join(repoRoot, 'packages', pkg[1], 'dist');
    const candidate = normalize(join(base, ...pkg[2].split('/')));
    if (candidate.startsWith(base + sep)) file = candidate;
  }
  const type = file === null ? undefined : TYPES[extname(file)];
  if (file === null || type === undefined) return null;
  return { body: readFileSync(file), type };
}

interface EditorPage {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly unexpected: string[];
}

let chromium: LaunchedChromium | undefined;

async function openEditor(scale: number): Promise<EditorPage> {
  if (chromium === undefined) throw new Error('Chromium did not launch.');
  const context = await chromium.browser.newContext(contextOptions(WIDTH, HEIGHT));
  const unexpected: string[] = [];
  const document = harness(scale);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const file = url.origin === ORIGIN ? served(url.pathname, document) : null;
    if (file === null) {
      unexpected.push(route.request().url());
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
  await page.waitForFunction(() => 'eready' in window);
  await page.evaluate(() => (window as unknown as EditorWindow).e.start());
  return { context, page, unexpected };
}

/**
 * Drags the grip by a client-pixel delta and waits for the re-render. The
 * pointer leaves the grip on the first move and passes over the render frame,
 * which is exactly the path that used to lose the gesture.
 */
async function dragGrip(page: Page, dx: number, dy: number): Promise<void> {
  const box = await page.locator('#grip').boundingBox();
  if (box === null) throw new Error('The grip has no box.');
  const fromX = box.x + box.width / 2;
  const fromY = box.y + box.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + dx / 2, fromY + dy / 2);
  await page.mouse.move(fromX + dx, fromY + dy, { steps: 4 });
  await page.mouse.up();
}

/**
 * The page's frames once the editor has loaded: this one, the render page, and
 * the Custom HTML element inside it (§3.2). `awaitPresented` compares the
 * frames its CDP sessions reached with `page.frames()`, and Playwright's frame
 * tree lags the page after a `load`, so the wait is explicit here rather than a
 * race that fails once in a while.
 */
const FRAMES = 3;

async function settledFrames(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 100 && page.frames().length !== FRAMES; attempt += 1) {
    await page.waitForTimeout(50);
  }
  expect(page.frames()).toHaveLength(FRAMES);
}

async function seekAndCapture(page: Page, timeUs: number): Promise<Uint8Array> {
  await page.evaluate((time) => (window as unknown as EditorWindow).e.seek(time), timeUs);
  expect(await page.evaluate(() => (window as unknown as EditorWindow).e.state())).toMatchObject({
    status: 'ready',
    timeUs,
  });
  await settledFrames(page);
  await awaitPresented(page, 5_000);
  return captureFrame(page, WIDTH, HEIGHT);
}

beforeAll(async () => {
  chromium = await launchChromium();
}, 120_000);

afterAll(async () => {
  await chromium?.browser.close();
});

describe('the canvas drag in Chromium (P3, D30.10)', () => {
  it.each([
    [1, 120, 200],
    [0.35, 35, 70],
  ])(
    'at a preview scale of %s, a drag of %s by %s client pixels moves the document by that over the scale',
    async (scale, dx, dy) => {
      const editor = await openEditor(scale);
      try {
        await dragGrip(editor.page, dx, dy);
        await editor.page.waitForFunction(
          () => (window as unknown as EditorWindow).e.renders === 1,
        );
        expect(
          await editor.page.evaluate(() => (window as unknown as EditorWindow).e.errors),
        ).toEqual([]);
        // The factor jsdom cannot measure: the browser laid the overlay out.
        expect(
          await editor.page.evaluate(() => (window as unknown as EditorWindow).e.position()),
        ).toEqual({ x: START.x + Math.round(dx / scale), y: START.y + Math.round(dy / scale) });
        expect(editor.unexpected).toEqual([]);
      } finally {
        await editor.context.close();
      }
    },
    120_000,
  );

  it('produces the document a direct JSON edit produces, byte for byte (P4 in waiting)', async () => {
    const editor = await openEditor(1);
    try {
      await dragGrip(editor.page, 120, 200);
      await editor.page.waitForFunction(() => (window as unknown as EditorWindow).e.renders === 1);
      const after = await editor.page.evaluate(() =>
        (window as unknown as EditorWindow).e.document(),
      );
      const expected = variant((draft: Draft) => {
        const title = draft.scenes[0]?.nodes.find((node) => node.id === NODE_ID);
        if (title === undefined) throw new Error('The fixture has no title node.');
        title['position'] = { x: START.x + 120, y: START.y + 200 };
      });
      expect(after).toBe(JSON.stringify(expected.document));
      // The starting document is untouched: the bus never edits in place (D30.7).
      expect(after).not.toBe(JSON.stringify(referenceComposition));
    } finally {
      await editor.context.close();
    }
  }, 120_000);

  it('changes the frame, and undo brings the first frame back', async () => {
    const editor = await openEditor(1);
    try {
      const before = await seekAndCapture(editor.page, AT);
      await dragGrip(editor.page, 120, 200);
      await editor.page.waitForFunction(() => (window as unknown as EditorWindow).e.renders === 1);
      const after = await seekAndCapture(editor.page, AT);
      expect(samePixels(before, after), pixelReport('after the command', before, after)).toBe(
        false,
      );

      await editor.page.evaluate(() => (window as unknown as EditorWindow).e.undo());
      const undone = await seekAndCapture(editor.page, AT);
      expect(samePixels(before, undone), pixelReport('after undo', before, undone)).toBe(true);
    } finally {
      await editor.context.close();
    }
  }, 120_000);
});
