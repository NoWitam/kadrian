/**
 * The entry point inside the page, and the entry of the runtime build artifact
 * (D21): `KadrionRuntime.load` (D27.1), `KadrionRuntime.mount`,
 * `KadrionRuntime.render`, `KadrionRuntime.synchronize` (D23.5), and
 * `KadrionRuntime.frame` (D25.3). A
 * document that reaches the page as JSON or through `postMessage` has no brand,
 * so every call takes it as `unknown` and
 * validates it (D19). Nothing is kept between calls except the DOM under
 * `root` and the font set that `load` registers. Both hosts consume this
 * contract through `load` and `frame` (D25, D28); `mount` stays for the tests of
 * D21.
 */
import { evaluateComposition } from '@kadrion/runtime';
import { validateComposition, type ValidationError } from '@kadrion/schema';

import { checkAssetUrls, type AssetUrls } from './assets.js';
import { pageAssets, registerFonts, type FontHost } from './load.js';
import { mountComposition } from './mount.js';
import { awaitMediaReady } from './ready.js';
import { renderState } from './render.js';
import { synchronizeCustomHtml, type CustomHtmlHost } from './synchronize.js';

export type PageResult =
  { readonly ok: true } | { readonly ok: false; readonly errors: readonly ValidationError[] };

/**
 * Validates `document` and mounts it into `root`. An invalid document is
 * expected input and yields its errors; a problem with the asset URLs throws a
 * `RenderError` before the DOM is touched (D22.5).
 */
export function mount(root: Element, document: unknown, assetUrls: unknown): PageResult {
  const result = validateComposition(document);
  if (!result.ok) return { ok: false, errors: result.errors };
  // `mountComposition` checks the shape of the URLs before it reads them.
  mountComposition(root, result.composition, assetUrls as AssetUrls);
  return { ok: true };
}

/**
 * The load step both hosts use (D27.1), in this order: validate `document`;
 * turn the asset bytes into `data:` URLs and check them against it (D22.5);
 * clear the font set; register every font a text node uses from its bytes,
 * through the constructor the host lends, and wait for the font set; then
 * mount. A problem with the assets or a font rejects with a `RenderError`, and
 * nothing is mounted; an invalid document yields its errors.
 */
export async function load(
  root: Element,
  document: unknown,
  assets: unknown,
  host: FontHost,
): Promise<PageResult> {
  const result = validateComposition(document);
  if (!result.ok) return { ok: false, errors: result.errors };
  const { urls, bytes } = pageAssets(assets);
  checkAssetUrls(result.composition, urls);
  await registerFonts(root, result.composition, bytes, host);
  mountComposition(root, result.composition, urls);
  return { ok: true };
}

/**
 * Validates `document`, evaluates it at `timeUs`, and renders the state into the
 * tree that `mount` built. The static properties come from that mount: a
 * document whose static properties changed must be mounted again (D22.4). A
 * time outside the composition throws an `EvaluationError` (D18, D19).
 */
export function render(root: Element, document: unknown, timeUs: number): PageResult {
  const result = validateComposition(document);
  if (!result.ok) return { ok: false, errors: result.errors };
  renderState(root, evaluateComposition(result.composition, timeUs));
  return { ok: true };
}

/**
 * Validates `document`, evaluates it at `timeUs`, and pushes that time to the
 * Custom HTML elements of the tree that `mount` built (D23.4). Call it after
 * `render` with the same arguments, and capture a frame only after the promise
 * resolved. The host lends the window and the timer; a missing acknowledgement
 * rejects with the `RenderError` code `custom-html-timeout`. Like `render`, a
 * time outside the composition throws an `EvaluationError`.
 */
export function synchronize(
  root: Element,
  document: unknown,
  timeUs: number,
  host: CustomHtmlHost,
): Promise<PageResult> {
  const result = validateComposition(document);
  if (!result.ok) return Promise.resolve({ ok: false, errors: result.errors });
  const state = evaluateComposition(result.composition, timeUs);
  return synchronizeCustomHtml(root, state, host).then(() => ({ ok: true }) as const);
}

/**
 * One complete frame (D25.3), in the one order both hosts use: validate,
 * evaluate, render, and then push the time to the Custom HTML elements while the
 * media of the frame become ready. Resolves with `{ ok: true }` only when the
 * elements acknowledged, every image is decoded, and the font set has settled; a
 * host reports or captures a frame only then. Every failure rejects, including
 * a time outside the composition.
 */
export function frame(
  root: Element,
  document: unknown,
  timeUs: number,
  host: CustomHtmlHost,
): Promise<PageResult> {
  return new Promise<PageResult>((resolve, reject) => {
    const result = validateComposition(document);
    if (!result.ok) {
      resolve({ ok: false, errors: result.errors });
      return;
    }
    const state = evaluateComposition(result.composition, timeUs);
    renderState(root, state);
    Promise.all([synchronizeCustomHtml(root, state, host), awaitMediaReady(root)]).then(() => {
      resolve({ ok: true });
    }, reject);
  });
}
