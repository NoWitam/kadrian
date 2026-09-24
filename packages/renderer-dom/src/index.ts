/**
 * @kadrion/renderer-dom — DOM/SVG rendering of evaluated state and the Custom HTML mount.
 *
 * `mountComposition` builds the tree of a validated document once, with every
 * Custom HTML element in a sandboxed frame; `renderState` writes the state that
 * `@kadrion/runtime` evaluated for one instant into it (D20, D22);
 * `synchronizeCustomHtml` pushes that instant to the Custom HTML elements and
 * waits for their acknowledgements with a timer lent by the host (D23);
 * `awaitMediaReady` waits until the frame's images are decoded and its fonts
 * have settled; `resolveAssets` asks the host for the bytes of every asset and
 * verifies their hashes before anything reaches the page (D27.3). None of them
 * reads a clock or keeps anything between calls: the host supplies the state,
 * the timer, the digest, and the font constructor, and the DOM is the only
 * memory. The
 * page entry of the runtime build artifact is `page.ts` (D21), and
 * `renderPageDocument` is the render page that both hosts load around it (D25).
 */
export type { AssetUrls } from './assets.js';
export { fontFamily } from './css.js';
export { RenderError } from './errors.js';
export type { RenderErrorCode } from './errors.js';
export { mountComposition } from './mount.js';
export { base64 } from './load.js';
export type { FontHost, LoadableFont, PageAsset } from './load.js';
export { awaitMediaReady } from './ready.js';
export { renderState } from './render.js';
export {
  RENDER_PAGE_FRAME_STYLE,
  RENDER_PAGE_POLICY,
  RENDER_PAGE_SANDBOX,
  RENDER_ROOT_ID,
  renderPageDocument,
} from './render-page.js';
export { MEDIA_TYPE, mediaTypeFits } from './media-type.js';
export { resolveAssets } from './resolve.js';
export type {
  AssetRequest,
  AssetResolver,
  ResolvedAsset,
  Sha256,
  VerifiedAsset,
} from './resolve.js';
export { synchronizeCustomHtml } from './synchronize.js';
export type { CustomHtmlHost, MessageListener, MessageTarget } from './synchronize.js';
