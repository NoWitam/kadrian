import type { ValidatedComposition } from './types.js';

export type ValidationErrorCode =
  /** The gate: `schemaVersion` is present but not supported by this build. */
  | 'unsupported-schema-version'
  | 'missing-field'
  | 'unknown-field'
  /** Wrong JSON type, a fractional value where an integer is required, or a value that is not JSON data. */
  | 'invalid-type'
  /** Right type, but not the expected constant, not an allowed value, or not matching the pattern. */
  | 'invalid-value'
  | 'out-of-range'
  /** Too few or too many array items. */
  | 'invalid-length'
  | 'duplicate-id'
  /** A reference inside the document points at no asset. Not a resolver failure. */
  | 'unresolved-asset-reference'
  | 'asset-type-mismatch'
  | 'keyframes-not-ascending'
  | 'duplicate-animation-target';

export interface ValidationError {
  readonly code: ValidationErrorCode;
  /** RFC 6901 JSON Pointer to the offending field; for a missing field, to where it belongs. */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly composition: ValidatedComposition }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/** Appends one reference token to a JSON Pointer. */
export function pointer(path: string, token: string | number): string {
  return `${path}/${String(token).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}
