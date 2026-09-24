export type PlayerErrorCode =
  /** The runtime build's bytes do not have the expected content hash (D25.5). */
  | 'runtime-hash-mismatch'
  /** The runtime build is not UTF-8, or would not stay one script element (D25.2, D25.5). */
  | 'runtime-unsafe'
  /** The render page did not answer within the Player's request timeout (D25.4). */
  | 'page-timeout'
  /** The document is not a valid composition (D19). */
  | 'invalid-document'
  /** The resolver has no bytes for an asset of the document (D14). */
  | 'asset-missing'
  /** An asset's bytes do not have its content hash (D14). */
  | 'asset-hash-mismatch'
  /** The resolver returned something that is not bytes with a media type (D25.4). */
  | 'asset-invalid'
  /** The page found no URL for an image or font asset (D22.5); the resolver prevents it. */
  | 'asset-url-missing'
  /** Bytes were passed for an ID that is not an asset of the document (D22.5, D25.4). */
  | 'asset-url-unknown'
  /** Asset bytes or their media type are not usable (D22.5, D25.4). */
  | 'asset-url-invalid'
  /** An image could not be decoded (D25.3). */
  | 'asset-decode-failed'
  /** The page cannot wait for images or fonts (D25.3). */
  | 'readiness-unsupported'
  /** The bytes of a font asset are not a font the browser can load (D27.1). */
  | 'font-load-failed'
  /** A Custom HTML element did not acknowledge the time (D23.4). */
  | 'custom-html-timeout'
  /** A Custom HTML element loaded another document than its shell; the render ends (D23.9). */
  | 'custom-html-navigated'
  /** The time is not an integer in `[0, durationUs)` (D13, D25.6). */
  | 'time-out-of-range'
  /** A seek was requested before a document was loaded. */
  | 'not-loaded'
  /** A newer seek replaced this one before it was sent (D25.6). */
  | 'superseded'
  /** The Player was destroyed while the request was pending. */
  | 'destroyed'
  /** Anything else the page reported. */
  | 'page-error';

/**
 * A typed failure of the Player (D25.7). Check `code` instead of `instanceof`,
 * which fails across realms. `details` lists validation errors as `path: message`.
 */
export class PlayerError extends Error {
  readonly code: PlayerErrorCode;
  readonly details: readonly string[];

  constructor(code: PlayerErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'PlayerError';
    this.code = code;
    this.details = details;
  }
}

const PAGE_CODES: readonly PlayerErrorCode[] = [
  'asset-missing',
  'asset-hash-mismatch',
  'asset-invalid',
  'invalid-document',
  'asset-url-missing',
  'asset-url-unknown',
  'asset-url-invalid',
  'asset-decode-failed',
  'readiness-unsupported',
  'font-load-failed',
  'custom-html-timeout',
  'custom-html-navigated',
  'time-out-of-range',
  'not-loaded',
];

/** A code the page reported, as one of the Player's; anything unknown is `page-error`. */
export function playerCode(code: string): PlayerErrorCode {
  return PAGE_CODES.find((known) => known === code) ?? 'page-error';
}
