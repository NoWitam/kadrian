export type RenderErrorCode =
  /** An image or font asset that a node uses has no URL (D22.5). */
  | 'asset-url-missing'
  /** A URL was passed for an ID that is not an asset of the document (D22.5). */
  | 'asset-url-unknown'
  /** The URLs are not a plain object of non-empty strings (D22.5). */
  | 'asset-url-invalid'
  /**
   * The root holds no tree that `mountComposition` built (D22.4), or a Custom
   * HTML element lost its sandboxed frame (D23.4).
   */
  | 'not-mounted'
  /** A Custom HTML element did not acknowledge the time before the host's timer expired (D23.4). */
  | 'custom-html-timeout'
  /** The frame of a Custom HTML element loaded another document than its shell (D23.9). */
  | 'custom-html-navigated'
  /** The host's request ID is not a non-negative safe integer (D23.3). */
  | 'invalid-request'
  /** An image of the frame could not be decoded (D25.3). */
  | 'asset-decode-failed'
  /** The document offers no way to wait for images or fonts, or the host lends no font constructor (D25.3, D27.1). */
  | 'readiness-unsupported'
  /** The bytes of a font asset are not a font the browser can load (D27.1). */
  | 'font-load-failed'
  /** The host's resolver has no bytes for an asset of the document, or failed (D14, D27.3). */
  | 'asset-missing'
  /** The bytes of an asset do not have its content hash (D14, D27.3). */
  | 'asset-hash-mismatch'
  /** The resolver returned something that is not bytes with a media type (D27.3). */
  | 'asset-invalid'
  /** A script for the render page would end or reinterpret its script element (D25.2). */
  | 'unsafe-script'
  /** The mounted tree has other scenes or nodes than the state, or another order (D22.4). */
  | 'state-mismatch'
  /**
   * The document or the state has a node type that the renderer does not know.
   * `validateComposition` and `evaluateComposition` never produce one, so the brand
   * was forged (D19).
   */
  | 'invalid-document';

/**
 * Thrown before the DOM is touched: a render either happens completely or not
 * at all. Check `code` instead of `instanceof`, which fails across realms.
 */
export class RenderError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode, message: string) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

/**
 * The `default` branch of a switch over the node types. A type that the schema
 * gains stops being `never` here, which fails compilation until the renderer
 * handles it; a forged document is reported at run time.
 */
export function unsupportedNode(node: never): never {
  const type = JSON.stringify((node as { readonly type?: unknown }).type);
  throw new RenderError(
    'invalid-document',
    `The renderer has no mapping for the node type ${type}.`,
  );
}
