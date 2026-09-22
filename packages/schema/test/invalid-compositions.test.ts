import { invalidCompositionCases, referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { validateComposition, type ValidationErrorCode } from '../src/index.js';
import { applyPatch } from './apply-patch.js';

const ERROR_CODES = [
  'unsupported-schema-version',
  'missing-field',
  'unknown-field',
  'invalid-type',
  'invalid-value',
  'out-of-range',
  'invalid-length',
  'duplicate-id',
  'unresolved-asset-reference',
  'asset-type-mismatch',
  'keyframes-not-ascending',
  'duplicate-animation-target',
] as const;

describe('negative fixtures', () => {
  it('have unique names', () => {
    const names = invalidCompositionCases.map((fixture) => fixture.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('cover every error code, and the list of codes is complete', () => {
    expectTypeOf<(typeof ERROR_CODES)[number]>().toEqualTypeOf<ValidationErrorCode>();
    const covered = new Set(
      invalidCompositionCases.flatMap((fixture) => fixture.expectedErrors.map(({ code }) => code)),
    );
    expect([...covered].sort()).toEqual([...ERROR_CODES].sort());
  });
});

describe.each(invalidCompositionCases)('negative fixture $name', (fixture) => {
  const document = applyPatch(referenceComposition, fixture.patch);

  it('differs from the reference composition', () => {
    expect(document).not.toEqual(referenceComposition);
  });

  it('yields exactly the expected typed errors', () => {
    const result = validateComposition(document);
    const errors = result.ok ? [] : result.errors;
    // Exact equality, not containment: one defect must yield its errors and nothing else.
    expect(errors.map(({ code, path }) => ({ code, path }))).toEqual(fixture.expectedErrors);
    expect(errors.every(({ message }) => message.length > 0)).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe('applyPatch', () => {
  it('refuses a patch that no longer matches the document', () => {
    const document = { list: [1], field: 1 };
    expect(() => applyPatch(document, [{ op: 'replace', path: '/missing', value: 1 }])).toThrow();
    expect(() => applyPatch(document, [{ op: 'remove', path: '/missing' }])).toThrow();
    expect(() => applyPatch(document, [{ op: 'remove', path: '/list/1' }])).toThrow();
    expect(() => applyPatch(document, [{ op: 'add', path: '/field', value: 2 }])).toThrow();
    expect(() => applyPatch(document, [{ op: 'add', path: '/missing/field', value: 2 }])).toThrow();
  });

  it('never changes its input', () => {
    const document = { list: [1] };
    expect(applyPatch(document, [{ op: 'add', path: '/list/-', value: 2 }])).toEqual({
      list: [1, 2],
    });
    expect(document).toEqual({ list: [1] });
  });
});
