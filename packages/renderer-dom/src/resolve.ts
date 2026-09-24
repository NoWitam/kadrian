/**
 * The host-provided resolver of D14, and the one place of this package that
 * verifies a hash (D27.3, amending D22.5). It runs in the host, before anything
 * reaches the render page, and the page entry never calls it: both hosts
 * resolve through it, so the Player and the Producer cannot differ in which
 * assets they ask for or which bytes they accept. The host lends the digest
 * (Web Crypto in a browser, `node:crypto` in Node.js).
 */
import type { Asset, ValidatedComposition } from '@kadrion/schema';

import { RenderError } from './errors.js';
import { mediaTypeFits } from './media-type.js';

type AssetType = Asset['type'];

/** An asset of the document, as the resolver is asked for it (D14, D25.4). */
export interface AssetRequest {
  readonly id: string;
  readonly type: AssetType;
  readonly contentHash: string;
}

/** The bytes of one asset and their media type, as a resolver returns them. */
export interface ResolvedAsset {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** Bytes for an asset of the document, or `null` when the host has none. */
export type AssetResolver = (
  asset: AssetRequest,
) => ResolvedAsset | null | Promise<ResolvedAsset | null>;

/** `sha256:` and 64 lowercase hex digits of the bytes, in the format of D14. */
export type Sha256 = (bytes: Uint8Array) => Promise<string>;

/** A verified asset: its bytes are a private copy whose hash is its `contentHash`. */
export interface VerifiedAsset {
  readonly id: string;
  readonly type: AssetType;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
}

/** A `Uint8Array` of any realm: a resolver may run in another window than the host. */
function isBytes(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Resolves every asset of the document through the host's resolver and verifies
 * its hash: for each asset, in the document's order, the resolver is called once
 * with a frozen request. A missing asset, a failing resolver, something that is
 * not bytes with a media type, or a hash mismatch is a `RenderError` before any
 * later asset is asked for. Only declared assets are asked for.
 */
export async function resolveAssets(
  composition: ValidatedComposition,
  resolveAsset: AssetResolver,
  sha256: Sha256,
): Promise<VerifiedAsset[]> {
  const verified: VerifiedAsset[] = [];
  for (const { id, type, contentHash } of composition.assets) {
    let given: unknown;
    try {
      given = await resolveAsset(Object.freeze({ id, type, contentHash }));
    } catch (reason) {
      throw new RenderError(
        'asset-missing',
        `The resolver failed for "${id}": ${messageOf(reason)}`,
      );
    }
    if (given === null || given === undefined) {
      throw new RenderError('asset-missing', `The host has no bytes for "${id}".`);
    }
    const { bytes, mediaType } = given as Partial<ResolvedAsset>;
    if (!isBytes(bytes) || typeof mediaType !== 'string' || !mediaTypeFits(type, mediaType)) {
      throw new RenderError(
        'asset-invalid',
        `The asset "${id}" needs bytes and a media type of the form ${type}/….`,
      );
    }
    // A copy, hashed and returned as it is: what the caller does later changes nothing.
    const copy = Uint8Array.prototype.slice.call(bytes);
    const actual = await sha256(copy);
    if (actual !== contentHash) {
      throw new RenderError(
        'asset-hash-mismatch',
        `The bytes of "${id}" have ${actual}, not ${contentHash}.`,
      );
    }
    verified.push({ id, type, mediaType, contentHash, bytes: copy });
  }
  return verified;
}
