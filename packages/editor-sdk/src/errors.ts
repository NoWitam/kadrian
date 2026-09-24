export type EditorErrorCode =
  /** The document the bus was created from is not a valid composition (D17). */
  | 'invalid-document'
  /** No command of that `type` exists (D30.8). */
  | 'unknown-command'
  /** The payload is not a well-formed command of its type (D30.3). */
  | 'invalid-argument'
  /** No node of the document carries that ID (D16). */
  | 'unknown-node'
  /** The node has no position; a background node is the only one in schema 0.1 (D30.8). */
  | 'unsupported-node'
  /** The edited document does not validate; `details` carry the validation errors (D30.6). */
  | 'invalid-result'
  | 'nothing-to-undo'
  | 'nothing-to-redo';

/**
 * A typed failure of the command bus (D30.8). Check `code` instead of
 * `instanceof`, which fails across realms; `details` lists validation errors as
 * `path: message`, in the idiom of `PlayerError`.
 */
export class EditorError extends Error {
  readonly code: EditorErrorCode;
  readonly details: readonly string[];

  constructor(code: EditorErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'EditorError';
    this.code = code;
    this.details = details;
  }
}
