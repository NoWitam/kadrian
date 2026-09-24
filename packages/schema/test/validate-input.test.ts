/**
 * Input that a JSON parser can never produce still reaches the validator:
 * editor commands validate in-memory documents. None of it may pass, throw, or
 * reach `Object.prototype` (D17).
 */
import { runInNewContext } from 'node:vm';

import { referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { validateComposition } from '../src/index.js';
import { applyPatch } from './apply-patch.js';

const TITLE_OPACITY = '/scenes/0/nodes/2/opacity';

function errorsOf(document: unknown): { code: string; path: string }[] {
  const result = validateComposition(document);
  return result.ok ? [] : result.errors.map(({ code, path }) => ({ code, path }));
}

/** The reference composition with one value swapped in after the JSON copy was made. */
function withValue(path: string, value: unknown): unknown {
  const document = applyPatch(referenceComposition, []);
  const tokens = path.slice(1).split('/');
  const last = tokens.pop() ?? '';
  const parent = tokens.reduce<unknown>(
    (current, token) => (current as Record<string, unknown>)[token],
    document,
  );
  (parent as Record<string, unknown>)[last] = value;
  return document;
}

class Opacity {
  readonly value = 1;
}

describe('validateComposition with input that is not JSON data', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"schemaVersion":"0.1"}'],
    ['a number', 1],
    ['an array', [referenceComposition]],
    ['a function', () => referenceComposition],
    ['a Map', new Map(Object.entries({ schemaVersion: '0.1' }))],
  ])('rejects %s as the document', (_name, document) => {
    expect(errorsOf(document)).toEqual([{ code: 'invalid-type', path: '' }]);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['a bigint', 1n],
    ['a symbol', Symbol('opacity')],
    ['a Date', new Date(0)],
    ['a class instance', new Opacity()],
    ['a boxed number', Object(1) as unknown],
  ])('rejects %s where a number belongs', (_name, value) => {
    expect(errorsOf(withValue(TITLE_OPACITY, value))).toEqual([
      { code: 'invalid-type', path: TITLE_OPACITY },
    ]);
  });

  it('rejects the holes of a sparse array', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(errorsOf(withValue('/assets', sparse))).toContainEqual({
      code: 'invalid-type',
      path: '/assets/0',
    });
  });

  it('rejects a class instance where an object belongs', () => {
    expect(errorsOf(withValue('/scenes/0/nodes/2/position', new Opacity()))).toEqual([
      { code: 'invalid-type', path: '/scenes/0/nodes/2/position' },
    ]);
  });
});

describe('validateComposition and Object.prototype', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'reports an own "%s" key as an unknown field',
    (key) => {
      const document = applyPatch(referenceComposition, []);
      Object.defineProperty(document, key, { value: 1, enumerable: true, configurable: true });
      expect(errorsOf(document)).toEqual([{ code: 'unknown-field', path: `/${key}` }]);
    },
  );

  it('does not accept inherited fields in place of own ones', () => {
    const prototype = applyPatch(referenceComposition, []);
    expect(errorsOf(Object.create(prototype as object))).toEqual([
      { code: 'invalid-type', path: '' },
    ]);
  });
});

describe('validateComposition result', () => {
  it('returns the input itself, typed, and leaves it untouched', () => {
    const document = applyPatch(referenceComposition, []);
    const before = JSON.stringify(document);
    const result = validateComposition(document);
    expect(result.ok && result.composition === document).toBe(true);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('does not depend on the key order of the input', () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return (value as unknown[]).map(reversed);
      if (typeof value !== 'object' || value === null) return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, child]) => [key, reversed(child)]),
      );
    };
    const broken = applyPatch(referenceComposition, [
      { op: 'remove', path: '/assets/2' },
      { op: 'replace', path: '/clips/0/id', value: 'scene-main' },
      { op: 'replace', path: '/scenes/0/nodes/2/animations/0/keyframes/1/timeUs', value: 0 },
    ]);
    expect(errorsOf(broken)).toHaveLength(4);
    expect(errorsOf(reversed(broken))).toEqual(errorsOf(broken));
    expect(validateComposition(reversed(referenceComposition)).ok).toBe(true);
  });

  it('reports unknown fields in sorted order, whatever their order in the input', () => {
    const document = applyPatch(referenceComposition, []) as Record<string, unknown>;
    const expected = [
      { code: 'unknown-field', path: '/alpha' },
      { code: 'unknown-field', path: '/zebra' },
    ];
    expect(errorsOf({ zebra: 1, alpha: 2, ...document })).toEqual(expected);
    expect(errorsOf({ ...document, alpha: 2, zebra: 1 })).toEqual(expected);
  });

  it('escapes JSON Pointer tokens', () => {
    const document = applyPatch(referenceComposition, [{ op: 'add', path: '/a~1b~0c', value: 1 }]);
    expect(errorsOf(document)).toEqual([{ code: 'unknown-field', path: '/a~1b~0c' }]);
  });
});

// D24.3: the validator remembers schema objects, never documents. A document
// changed in place after a successful validation is judged afresh.
describe('no memory of documents (D24.3)', () => {
  it('rejects a document that was valid and then changed in place', () => {
    const document = applyPatch(referenceComposition, []) as Record<string, unknown>;
    expect(validateComposition(document).ok).toBe(true);
    document.fps = 0;
    expect(errorsOf(document)).toEqual([expect.objectContaining({ path: '/fps' })]);
    document.fps = 30;
    expect(validateComposition(document).ok).toBe(true);
  });
});

// D21: the validator accepts plain objects of its own realm only. A host hands a
// document over as JSON or through `postMessage`, whose structured clone is
// created by the receiving realm, so that limit is a contract, not a defect.
describe('documents from another realm (D21)', () => {
  const text = JSON.stringify(referenceComposition);
  const foreign: unknown = runInNewContext(`JSON.parse(${JSON.stringify(text)})`);

  it('premise: the foreign document is a plain object of another realm', () => {
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(JSON.stringify(foreign)).toBe(text);
  });

  it('rejects an object passed by reference from another realm', () => {
    const result = validateComposition(foreign);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual([
      expect.objectContaining({
        code: 'invalid-type',
        path: '',
        message: expect.stringContaining('a non-JSON object') as unknown,
      }),
    ]);
  });

  it('accepts its structured clone, which postMessage creates in the receiving realm', () => {
    const received = structuredClone(foreign);
    expect(Object.getPrototypeOf(received)).toBe(Object.prototype);
    expect(validateComposition(received).ok).toBe(true);
  });
});
