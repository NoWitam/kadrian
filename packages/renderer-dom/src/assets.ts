/**
 * The asset URLs a host passes to the renderer (D22.5). Until the resolver of
 * D14 exists, the host maps each asset ID to the URL of bytes it has already
 * verified; the renderer only checks that every URL it needs is there.
 */
import type { SceneNode, ValidatedComposition } from '@kadrion/schema';

import { RenderError, unsupportedNode, type RenderErrorCode } from './errors.js';

/** Asset ID to URL. Only own properties count, so IDs such as `constructor` are safe. */
export type AssetUrls = Readonly<Record<string, string>>;

interface Problem {
  readonly code: RenderErrorCode;
  readonly assetId: string;
}

/** The first code in this list that occurs names the error; the message lists every problem. */
const PRECEDENCE: readonly RenderErrorCode[] = [
  'asset-url-invalid',
  'asset-url-unknown',
  'asset-url-missing',
];

/** A plain object from any realm: its prototype is `null` or a prototype whose own prototype is `null`. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/** Image and font assets that visual nodes use; audio belongs to the clip, not to the DOM. */
export function usedAssetIds(composition: ValidatedComposition): Set<string> {
  const used = new Set<string>();
  const visit = (node: SceneNode): void => {
    switch (node.type) {
      case 'image':
        used.add(node.assetId);
        break;
      case 'text':
        used.add(node.fontAssetId);
        break;
      case 'group':
        node.children.forEach(visit);
        break;
      case 'background':
      case 'custom-html':
        break;
      default:
        unsupportedNode(node);
    }
  };
  for (const scene of composition.scenes) scene.nodes.forEach(visit);
  return used;
}

/**
 * Checks the URLs against the document and throws one `RenderError` that lists
 * every problem, sorted by asset ID, before anything is rendered. Returns a copy
 * without a prototype, read once: a getter or a later change of the host's
 * object cannot reach the tree (D22.5).
 */
export function checkAssetUrls(composition: ValidatedComposition, assetUrls: unknown): AssetUrls {
  if (!isPlainObject(assetUrls)) {
    throw new RenderError('asset-url-invalid', 'Asset URLs must be a plain object.');
  }
  const known = new Set(composition.assets.map((asset) => asset.id));
  const problems: Problem[] = [];
  const urls = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const key of Reflect.ownKeys(assetUrls)) {
    const assetId = String(key);
    if (typeof key === 'string') seen.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(assetUrls, key);
    // Own, enumerable data properties only: no getter, no hidden or symbol key.
    const url: unknown = descriptor?.enumerable === true ? descriptor.value : undefined;
    if (typeof key !== 'string' || typeof url !== 'string' || url === '') {
      problems.push({ code: 'asset-url-invalid', assetId });
    } else {
      urls[assetId] = url;
    }
    if (!known.has(assetId)) problems.push({ code: 'asset-url-unknown', assetId });
  }
  for (const assetId of usedAssetIds(composition)) {
    if (!seen.has(assetId)) problems.push({ code: 'asset-url-missing', assetId });
  }
  if (problems.length > 0) {
    problems.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
    const code = PRECEDENCE.find((item) => problems.some((problem) => problem.code === item));
    const list = problems.map((problem) => `${problem.code} ${JSON.stringify(problem.assetId)}`);
    throw new RenderError(code ?? 'asset-url-invalid', `Asset URLs: ${list.join(', ')}.`);
  }
  return urls;
}
