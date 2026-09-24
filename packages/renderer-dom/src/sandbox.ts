/**
 * The frame of an isolated Custom HTML element (D05, D23.1, D23.2). The
 * document's `html` goes into `srcdoc` only, behind a fixed shell whose Content
 * Security Policy precedes every byte of author content; it is never parsed in
 * the host document.
 */
import type { CustomHtmlNode } from '@kadrion/schema';

import { cssPixels } from './css.js';

/** The only sandbox token: scripts run, but the origin stays opaque (no `allow-same-origin`). */
export const SANDBOX_TOKENS = 'allow-scripts';

/** No network, no plugins, no base URL, no forms; inline script and style only (D23.2). */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** The name of the `meta` element that tells an element its instance ID (D23.3). */
export const INSTANCE_META = 'kadrion-instance';

/**
 * Put before the document's `html`. The author's own doctype then becomes an
 * ignored parse error, and the author's `meta` and `style` still land in `head`.
 * The instance ID is the node's ID, which the schema restricts to
 * `[A-Za-z0-9_-]`, so it needs no escaping. It is no secret: the window a
 * message comes from, not this ID, authenticates it (D23.3).
 */
export function sandboxShell(nodeId: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"><meta name="${INSTANCE_META}" content="${nodeId}"></head>`;
}

/**
 * Set on a frame whose document was replaced after the shell loaded: a
 * navigation, a reload, or an error page (D23.9). It is never removed.
 */
export const NAVIGATED_ATTRIBUTE = 'data-kadrion-navigated';

/** The attributes of a mounted frame, sorted; anything else means the tree was altered. */
export const FRAME_ATTRIBUTES = 'sandbox,srcdoc,style';

/**
 * The `iframe` of one Custom HTML node. `sandbox` is set before `srcdoc`, and
 * both before the frame is attached: sandbox flags take effect when the frame
 * navigates, so a frame that loaded first would run unsandboxed.
 *
 * The frame hosts exactly one document, the shell: the first `load` is the
 * shell's, and every later one marks the frame with `NAVIGATED_ATTRIBUTE`
 * (D23.9). The listener is registered before any synchronization can register
 * its own, so it runs first.
 */
export function sandboxFrame(document: Document, node: CustomHtmlNode): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', SANDBOX_TOKENS);
  frame.setAttribute('srcdoc', `${sandboxShell(node.id)}${node.html}`);
  const styles: Readonly<Record<string, string>> = {
    display: 'block',
    width: cssPixels(node.width),
    height: cssPixels(node.height),
    // Longhands, so that every CSS Object Model reads back the same declarations.
    'border-top-style': 'none',
    'border-right-style': 'none',
    'border-bottom-style': 'none',
    'border-left-style': 'none',
  };
  for (const [name, value] of Object.entries(styles)) frame.style.setProperty(name, value);
  const loads = { count: 0 };
  frame.addEventListener('load', () => {
    loads.count += 1;
    if (loads.count > 1) frame.setAttribute(NAVIGATED_ATTRIBUTE, '');
  });
  return frame;
}
