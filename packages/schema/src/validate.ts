import { compositionSchema, SCHEMA_VERSION } from './composition-schema.js';
import type { ValidationResult } from './errors.js';
import type { Composition, ValidatedComposition } from './types.js';
import { validateSemantics } from './validate-semantics.js';
import { validateStructure } from './validate-structure.js';

/**
 * Validates parsed JSON against schema 0.1 (D17). Validation runs in three
 * phases and stops after the first phase that reports errors:
 *
 * 1. the `schemaVersion` gate, so that a document of another version yields one
 *    error instead of a flood of structural ones;
 * 2. the structure, exactly as `compositionSchema` describes it;
 * 3. the rules JSON Schema cannot express: unique IDs, asset references,
 *    ascending keyframes, and one animation per property.
 *
 * Never throws for any input, including values that are not JSON data. An
 * accepted document comes back as a `ValidatedComposition`, the only type that
 * `@kadrion/runtime` accepts, so every render starts from a validated document.
 */
export function validateComposition(input: unknown): ValidationResult {
  if (typeof input === 'object' && input !== null && Object.hasOwn(input, 'schemaVersion')) {
    const { schemaVersion } = input as { readonly schemaVersion: unknown };
    if (schemaVersion !== SCHEMA_VERSION) {
      const actual =
        typeof schemaVersion === 'string' ? `"${schemaVersion}"` : typeof schemaVersion;
      const message = `Unsupported schemaVersion ${actual}; this build supports "${SCHEMA_VERSION}".`;
      return {
        ok: false,
        errors: [{ code: 'unsupported-schema-version', path: '/schemaVersion', message }],
      };
    }
  }

  const structuralErrors = validateStructure(compositionSchema, input);
  if (structuralErrors.length > 0) return { ok: false, errors: structuralErrors };

  // The one trusted cast: the structural phase has just checked every field
  // that `Composition`, which is derived from the same schema, declares.
  const composition = input as Composition;
  const semanticErrors = validateSemantics(composition);
  if (semanticErrors.length > 0) return { ok: false, errors: semanticErrors };

  // All three phases have passed. The brand is attached here and nowhere else
  // (specification Q17); ESLint rejects this assertion in every other source file.
  return { ok: true, composition: composition as ValidatedComposition };
}
