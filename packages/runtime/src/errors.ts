export type EvaluationErrorCode =
  /** `timeUs` is a fraction, `NaN`, an infinity, or not a number at all. */
  | 'time-not-integer'
  /** `timeUs` is negative, or not before `durationUs`: the composition end is exclusive (D13). */
  | 'time-out-of-range'
  /**
   * The document has a member that the evaluation cannot handle: an animation
   * without keyframes, or an unknown node type, animation property, or
   * interpolation. `validateComposition` rejects all of them, so the brand of the
   * document was forged (D19). Nothing else about a document is checked again.
   */
  | 'invalid-document';

/**
 * Thrown when `evaluateComposition` is called outside its domain (D18). That is
 * a programming error of the host rather than expected input, so it is an
 * exception and not a result. Check `code` instead of `instanceof`, which fails
 * across realms.
 */
export class EvaluationError extends RangeError {
  readonly code: EvaluationErrorCode;

  constructor(code: EvaluationErrorCode, message: string) {
    super(message);
    this.name = 'EvaluationError';
    this.code = code;
  }
}

/**
 * The `default` branch of a switch over a closed union of the schema. A member
 * that the schema gains stops being `never` here, which fails compilation until
 * the switch handles it; a forged document is reported at run time instead of
 * being ignored silently.
 */
export function unsupported(member: never, discriminator: string): never {
  const value = (member as Readonly<Record<string, unknown>>)[discriminator];
  const message = `The document has an unsupported ${discriminator}, ${JSON.stringify(value)}.`;
  throw new EvaluationError('invalid-document', message);
}
