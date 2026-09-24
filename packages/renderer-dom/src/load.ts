/**
 * The load step of the runtime build (D27.1): the asset bytes a host passes
 * become `data:` URLs, and every font a text node uses is registered as a face
 * from its bytes before the tree is mounted. The `FontFace` constructor is lent
 * by the host, as the timer is (D20.2): this package may not name it (D22.8).
 * Nothing is kept between calls; the font set is cleared first, so that it
 * depends on the loaded document only.
 */
import type { ValidatedComposition } from '@kadrion/schema';

import { usedAssetIds } from './assets.js';
import { fontFamily } from './css.js';
import { RenderError } from './errors.js';
import { MEDIA_TYPE } from './media-type.js';

/** The part of a font face that the load step uses. */
export interface LoadableFont {
  load(): Promise<unknown>;
}

/** What the host lends for a load: the `FontFace` constructor of the page's realm. */
export interface FontHost {
  readonly createFont?: (family: string, bytes: ArrayBuffer) => LoadableFont;
}

/** One asset as a host passes it into the page (D25.4). */
export interface PageAsset {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: ArrayBuffer;
}

interface FontSet {
  clear(): void;
  add(font: LoadableFont): unknown;
  readonly ready: Promise<unknown>;
}

const ASSET_KEYS = 'bytes,id,mediaType';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RFC 4648 base64, written out so that no platform function is involved. */
export function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    const left = bytes.length - index;
    parts.push(
      (BASE64[(triple >> 18) & 63] ?? '') +
        (BASE64[(triple >> 12) & 63] ?? '') +
        (left > 1 ? (BASE64[(triple >> 6) & 63] ?? '') : '=') +
        (left > 2 ? (BASE64[triple & 63] ?? '') : '='),
    );
  }
  return parts.join('');
}

/** An `ArrayBuffer` of any realm: a structured clone belongs to the page, a test's may not. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function invalid(message: string): RenderError {
  return new RenderError('asset-url-invalid', message);
}

/**
 * Checks the shape of the assets — an array of `{ id, mediaType, bytes }` with
 * exactly these keys, each ID once — and returns their `data:` URLs and bytes.
 */
export function pageAssets(assets: unknown): {
  readonly urls: Readonly<Record<string, string>>;
  readonly bytes: ReadonlyMap<string, ArrayBuffer>;
} {
  if (!Array.isArray(assets)) throw invalid('The assets must be an array.');
  const urls = Object.create(null) as Record<string, string>;
  const bytes = new Map<string, ArrayBuffer>();
  for (const asset of assets as unknown[]) {
    if (typeof asset !== 'object' || asset === null || Array.isArray(asset)) {
      throw invalid('An asset is not { id, mediaType, bytes }.');
    }
    const keys = Reflect.ownKeys(asset).map((key) => (typeof key === 'string' ? key : '#symbol'));
    const { id, mediaType, bytes: data } = asset as Partial<Record<string, unknown>>;
    if (
      keys.sort().join(',') !== ASSET_KEYS ||
      typeof id !== 'string' ||
      typeof mediaType !== 'string' ||
      !MEDIA_TYPE.test(mediaType) ||
      !isArrayBuffer(data)
    ) {
      throw invalid('An asset is not { id, mediaType, bytes }.');
    }
    if (bytes.has(id)) throw invalid(`The asset "${id}" is passed twice.`);
    bytes.set(id, data);
    urls[id] = `data:${mediaType};base64,${base64(new Uint8Array(data))}`;
  }
  return { urls, bytes };
}

/**
 * Registers a face for every font asset that a text node uses, in the order of
 * the document's assets: build it from a copy of its bytes, wait for `load()`,
 * add it to the font set, and finally wait for `document.fonts.ready`
 * (D27.1). The set is cleared first. A missing font set or constructor is
 * `readiness-unsupported`; bytes the browser cannot use are `font-load-failed`.
 */
export async function registerFonts(
  root: Element,
  composition: ValidatedComposition,
  bytes: ReadonlyMap<string, ArrayBuffer>,
  host: FontHost,
): Promise<void> {
  const fonts = (root.ownerDocument as unknown as { readonly fonts?: FontSet }).fonts;
  if (fonts === undefined) {
    throw new RenderError('readiness-unsupported', 'The document has no font set.');
  }
  const used = usedAssetIds(composition);
  const fontIds = composition.assets
    .filter((asset) => asset.type === 'font' && used.has(asset.id))
    .map((asset) => asset.id);
  const { createFont } = host;
  if (fontIds.length > 0 && typeof createFont !== 'function') {
    throw new RenderError('readiness-unsupported', 'The host lends no font constructor.');
  }
  fonts.clear();
  for (const id of fontIds) {
    const data = bytes.get(id);
    if (data === undefined || createFont === undefined) {
      // Unreachable: the URLs were checked against the document first.
      throw new RenderError('asset-url-missing', `The font "${id}" has no bytes.`);
    }
    let face: LoadableFont;
    try {
      face = createFont(fontFamily(id), data.slice(0));
      await face.load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new RenderError('font-load-failed', `The font "${id}" could not be loaded: ${message}`);
    }
    fonts.add(face);
  }
  await fonts.ready;
}
