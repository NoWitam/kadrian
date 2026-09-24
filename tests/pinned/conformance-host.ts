/**
 * The conformance host of D33.2: the smallest page that embeds the public,
 * built `@kadrion/player` and nothing else. It is what parity measures — the
 * Player's own surface at 1080x1920 and device pixel ratio 1, with no
 * application around it. The playground's preview scale and drag overlay belong
 * to the application (D25.2) and are deliberately absent.
 *
 * The page receives the document as JSON text and the asset bytes from Node, so
 * it needs no import of `@kadrion/test-fixtures`; it returns the exact text it
 * loaded, which the test hashes the Producer's way (D33.3).
 */
import { readFileSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';

import {
  awaitPresented,
  captureFrame,
  canonicalJson,
  contextOptions,
  sha256,
  type LaunchedChromium,
} from '@kadrion/producer';
import { validateComposition } from '@kadrion/schema';
import type { BrowserContext, Frame, Page } from 'playwright-core';

import { HOST_PACKAGES } from '../parity/parity.js';

import { expectedTree, inSinglePrecision, repoRoot, shownTree } from './support.js';

const ORIGIN = 'http://localhost:4522';
/** The host's policy; the render page is its `srcdoc` and inherits it (D23.6). */
const POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** `@kadrion/player` and the packages its build imports; never an application or a fixture. */
export { HOST_PACKAGES };
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** The host's only module script. It imports `@kadrion/player` and nothing else. */
export const HOST_SCRIPT = `import { createPlayer } from '@kadrion/player';
let player;
let loadedText = null;
const bytesOf = (base64) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
window.conformance = {
  async start() {
    const [bytes, manifest] = await Promise.all([
      fetch('/runtime/kadrion-runtime.js').then((response) => response.arrayBuffer()),
      fetch('/runtime/kadrion-runtime.json').then((response) => response.json()),
    ]);
    player = await createPlayer(document.getElementById('stage'), {
      runtime: { bytes: new Uint8Array(bytes), contentHash: manifest.contentHash },
    });
  },
  load(text, assets) {
    loadedText = text;
    const table = new Map(assets.map((asset) => [asset.id, { bytes: bytesOf(asset.base64), mediaType: asset.mediaType }]));
    return player.load(JSON.parse(text), ({ id }) => table.get(id) ?? null);
  },
  loadedText: () => loadedText,
  seek: (timeUs) => player.seek(timeUs),
  state() {
    const state = player.getState();
    return { status: state.status, timeUs: state.timeUs, runtimeHash: state.runtimeHash, error: state.error && state.error.code };
  },
};
window.conformanceReady = true;`;

/** A deterministic reset and the one element the Player needs; no control, overlay, or scale. */
export const HOST_STYLE = 'html,body{margin:0;padding:0;overflow:hidden}';

export const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>${HOST_STYLE}</style>
<script type="importmap">${JSON.stringify({
  imports: Object.fromEntries(
    HOST_PACKAGES.map((name) => [`@kadrion/${name}`, `/pkg/${name}/index.js`]),
  ),
})}</script>
<script type="module">${HOST_SCRIPT}</script></head><body><div id="stage"></div></body></html>`;

interface HostWindow {
  readonly conformance: {
    start(): Promise<void>;
    load(text: string, assets: readonly HostAsset[]): Promise<void>;
    loadedText(): string | null;
    seek(timeUs: number): Promise<void>;
    state(): { status: string; timeUs: number | null; runtimeHash: string; error: string | null };
  };
}

interface HostAsset {
  readonly id: string;
  readonly mediaType: string;
  readonly base64: string;
}

/**
 * A file of the built packages with its repository-relative POSIX path, or
 * `null` for anything the host does not serve. The page itself has no path: it
 * lives in Git, in this file (D33.10).
 */
function served(pathname: string): { body: Buffer; type: string; path: string | null } | null {
  if (pathname === '/') {
    return { body: Buffer.from(HOST_PAGE), type: 'text/html; charset=utf-8', path: null };
  }
  const runtime = /^\/runtime\/(kadrion-runtime\.(?:js|json))$/.exec(pathname);
  const pkg = /^\/pkg\/([a-z-]+)\/(.+)$/.exec(pathname);
  let file: string | null = null;
  if (runtime?.[1] !== undefined) {
    // The files the Producer loads too (D28.2).
    file = join(repoRoot, 'packages', 'renderer-dom', 'dist', 'runtime-build', runtime[1]);
  } else if (
    pkg?.[1] !== undefined &&
    pkg[2] !== undefined &&
    (HOST_PACKAGES as readonly string[]).includes(pkg[1])
  ) {
    const base = join(repoRoot, 'packages', pkg[1], 'dist');
    const candidate = normalize(join(base, ...pkg[2].split('/')));
    if (candidate.startsWith(base + sep)) file = candidate;
  }
  const type = file === null ? undefined : TYPES[extname(file)];
  if (file === null || type === undefined) return null;
  return {
    body: readFileSync(file),
    type,
    path: relative(repoRoot, file).split(sep).join('/'),
  };
}

export interface ConformanceHost {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly renderFrame: Frame;
  /** Every path the host served, in order. */
  readonly servedPaths: string[];
  /**
   * The exact bytes of every dist file the host served, by repository path
   * (D33.10). Serving one path with two different contents is an error.
   */
  readonly servedFiles: Map<string, Uint8Array>;
  /** Every request the host refused. */
  readonly refused: string[];
  readonly width: number;
  readonly height: number;
  /** `sha256(canonicalJson(validated document))` of the text the page says it loaded (D33.3). */
  readonly compositionHash: string;
}

/**
 * Opens the host, starts the Player with the runtime build, and loads the
 * document text with the given assets. The composition hash comes from the text
 * the page returns, not from `documentText`.
 */
export async function openConformanceHost(
  chromium: LaunchedChromium,
  documentText: string,
  assets: readonly { id: string; mediaType: string; bytes: Uint8Array }[],
): Promise<ConformanceHost> {
  const size = validateComposition(JSON.parse(documentText));
  if (!size.ok) throw new Error('The document to load is not valid.');
  const { width, height } = size.composition;
  const context = await chromium.browser.newContext(contextOptions(width, height));
  const servedPaths: string[] = [];
  const servedFiles = new Map<string, Uint8Array>();
  const refused: string[] = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const file = url.origin === ORIGIN ? served(url.pathname) : null;
    if (file === null) {
      refused.push(route.request().url());
      return route.abort('blockedbyclient');
    }
    servedPaths.push(url.pathname);
    if (file.path !== null) {
      const earlier = servedFiles.get(file.path);
      if (earlier !== undefined && !Buffer.from(earlier).equals(file.body)) {
        refused.push(`${file.path} changed while it was being served`);
        return route.abort('failed');
      }
      servedFiles.set(file.path, new Uint8Array(file.body));
    }
    return route.fulfill({
      status: 200,
      body: file.body,
      headers: {
        'content-type': file.type,
        'content-security-policy': POLICY,
        'cache-control': 'no-store',
      },
    });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'conformanceReady' in window);
  await page.evaluate(() => (window as unknown as HostWindow).conformance.start());
  const renderFrame = page.mainFrame().childFrames()[0];
  if (renderFrame === undefined) throw new Error('The Player made no frame.');
  await page.evaluate(
    ([text, sent]) => (window as unknown as HostWindow).conformance.load(text, sent),
    [
      documentText,
      assets.map(({ id, mediaType, bytes }) => ({
        id,
        mediaType,
        base64: Buffer.from(bytes).toString('base64'),
      })),
    ] as const,
  );
  const echo = await page.evaluate(() =>
    (window as unknown as HostWindow).conformance.loadedText(),
  );
  if (echo === null) throw new Error('The host loaded no document.');
  const loaded = validateComposition(JSON.parse(echo));
  if (!loaded.ok) throw new Error('The host loaded an invalid document.');
  return {
    context,
    page,
    renderFrame,
    servedPaths,
    servedFiles,
    refused,
    width: loaded.composition.width,
    height: loaded.composition.height,
    compositionHash: sha256(canonicalJson(loaded.composition)),
  };
}

export interface PlayerState {
  readonly status: string;
  readonly timeUs: number | null;
  readonly runtimeHash: string;
  readonly error: string | null;
}

export async function playerState(host: ConformanceHost): Promise<PlayerState> {
  return host.page.evaluate(() => (window as unknown as HostWindow).conformance.state());
}

/**
 * Every condition of D33.2 that must hold before a capture, as a list of
 * violations (empty when the capture may happen). `tree` is the hand-derived
 * tree the render page must show, or `null` for a time that has none.
 */
export async function preflight(
  host: ConformanceHost,
  timeUs: number,
  tree: unknown,
): Promise<string[]> {
  const { width, height } = host;
  const problems: string[] = [];
  const state = await playerState(host);
  if (state.status !== 'ready' || state.timeUs !== timeUs || state.error !== null) {
    problems.push(`the Player is ${JSON.stringify(state)}, not ready at ${String(timeUs)}`);
  }
  problems.push(
    ...(await host.page.evaluate(
      ([w, h, sheet]) => {
        const found: string[] = [];
        if (devicePixelRatio !== 1) found.push(`host devicePixelRatio ${String(devicePixelRatio)}`);
        // The host's CSS is the reset and nothing else, in a style sheet or inline (D33.2).
        const sheets = [...document.querySelectorAll('style')].map((style) => style.textContent);
        if (
          document.styleSheets.length !== 1 ||
          JSON.stringify(sheets) !== JSON.stringify([sheet])
        ) {
          found.push(`the host's style sheets are ${JSON.stringify(sheets)}`);
        }
        for (const element of [
          document.documentElement,
          document.body,
          document.getElementById('stage'),
        ]) {
          if (element?.hasAttribute('style') === true)
            found.push(`${element.localName} has inline style`);
        }
        if (visualViewport !== null && visualViewport.scale !== 1) {
          found.push(`visual viewport scale ${String(visualViewport.scale)}`);
        }
        const frames = document.querySelectorAll('iframe');
        const frame = frames[0];
        if (frames.length !== 1 || frame === undefined) {
          found.push(`${String(frames.length)} frames in the host`);
          return found;
        }
        const rect = frame.getBoundingClientRect();
        if (rect.x !== 0 || rect.y !== 0 || rect.width !== w || rect.height !== h) {
          found.push(
            `the Player surface is ${JSON.stringify([rect.x, rect.y, rect.width, rect.height])}`,
          );
        }
        for (
          let element: Element | null = frame;
          element !== null;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          for (const [name, identity] of [
            ['transform', 'none'],
            ['scale', 'none'],
            ['rotate', 'none'],
            ['translate', 'none'],
            ['zoom', '1'],
            // Effects that change pixels without changing the size.
            ['filter', 'none'],
            ['backdrop-filter', 'none'],
            ['opacity', '1'],
            ['mix-blend-mode', 'normal'],
            ['clip-path', 'none'],
            ['mask-image', 'none'],
          ] as const) {
            const value = style.getPropertyValue(name);
            if (value !== identity) found.push(`${element.localName} has ${name}: ${value}`);
          }
        }
        const elements = [...document.body.querySelectorAll('*')].map((element) =>
          element.id === '' ? element.localName : `${element.localName}#${element.id}`,
        );
        if (JSON.stringify(elements) !== JSON.stringify(['div#stage', 'iframe'])) {
          found.push(`the host shows more than the Player: ${elements.join(', ')}`);
        }
        const selection = getSelection();
        if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed) {
          found.push('something is selected');
        }
        if (document.activeElement !== document.body) found.push('the focus is not on the body');
        return found;
      },
      [width, height, HOST_STYLE] as const,
    )),
  );
  problems.push(
    ...(await host.renderFrame.evaluate(
      ([w, h]) => {
        const found: string[] = [];
        if (devicePixelRatio !== 1)
          found.push(`render page devicePixelRatio ${String(devicePixelRatio)}`);
        const root = document.scrollingElement ?? document.documentElement;
        const sizes = {
          inner: [innerWidth, innerHeight],
          client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
          scroll: [root.scrollWidth, root.scrollHeight],
        };
        for (const [name, [sw, sh]] of Object.entries(sizes)) {
          if (sw !== w || sh !== h)
            found.push(`render page ${name} size ${String(sw)}x${String(sh)}`);
        }
        if (document.getElementById('kadrion-root') === null) found.push('no #kadrion-root');
        for (const image of [...document.images]) {
          if (!image.complete || image.naturalWidth === 0) found.push('an image is not decoded');
        }
        if (document.fonts.status !== 'loaded') found.push(`fonts are ${document.fonts.status}`);
        if (!document.fonts.check('16px "Kadrion Fixture"'))
          found.push('the fixture font is missing');
        return found;
      },
      [width, height] as const,
    )),
  );
  if (tree !== null) {
    const shown = await shownTree(host.renderFrame, tree);
    if (JSON.stringify(inSinglePrecision(shown)) !== JSON.stringify(inSinglePrecision(tree))) {
      problems.push(`the render page does not show the tree of ${String(timeUs)}`);
    }
  }
  return problems;
}

export interface CapturedFrame {
  readonly png: Uint8Array;
  /** The time the Player confirmed, after the preflight proved the DOM shows it. */
  readonly timeUs: number;
  readonly runtimeHash: string;
}

/**
 * The one capture path of the measurement (D33.7): seek through the public API,
 * wait until every frame of the page has presented (D28.5), prove the preflight,
 * and capture the Player's surface at scale 1. Premise and rows both use it.
 */
export async function seekAndCapture(
  host: ConformanceHost,
  timeUs: number,
  tree: unknown = expectedTree(timeUs),
): Promise<CapturedFrame> {
  await host.page.evaluate(
    (time) => (window as unknown as HostWindow).conformance.seek(time),
    timeUs,
  );
  await awaitPresented(host.page, 5_000);
  const problems = await preflight(host, timeUs, tree);
  if (problems.length > 0) {
    throw new Error(`The preflight of ${String(timeUs)} failed:\n${problems.join('\n')}`);
  }
  const state = await playerState(host);
  const png = await captureFrame(host.page, host.width, host.height);
  return { png, timeUs: state.timeUs ?? -1, runtimeHash: state.runtimeHash };
}

export async function closeConformanceHost(host: ConformanceHost): Promise<void> {
  await host.context.close();
}
