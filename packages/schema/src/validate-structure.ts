/**
 * Interpreter for the JSON Schema subset of `json-schema.ts` (D17). It never
 * generates code, so it runs under a Content Security Policy without
 * `unsafe-eval`. `composition-schema.test.ts` compares its verdicts with Ajv.
 *
 * Errors are reported depth-first in schema order and unknown fields in sorted
 * order, so the result does not depend on the key order of the input.
 */
import { pointer, type ValidationError } from './errors.js';
import type {
  ArraySchema,
  JsonSchema,
  NumberSchema,
  ObjectSchema,
  StringSchema,
  UnionSchema,
} from './json-schema.js';

const ANNOTATIONS = ['$schema', 'title', 'description'];

const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  string: ['type', 'const', 'enum', 'pattern'],
  integer: ['type', 'minimum', 'maximum'],
  number: ['type', 'minimum', 'maximum'],
  array: ['type', 'items', 'minItems', 'maxItems'],
  object: ['type', 'properties', 'required', 'additionalProperties'],
  union: ['oneOf'],
};

type PlainObject = Readonly<Record<string, unknown>>;

/** Class instances, `Date`, `Map`, and the like are not JSON data. */
function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function typeNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'a non-finite number';
  if (typeof value === 'object') return isPlainObject(value) ? 'object' : 'a non-JSON object';
  return typeof value;
}

function constOf(schema: JsonSchema | undefined): string | undefined {
  return schema !== undefined && 'type' in schema && schema.type === 'string'
    ? schema.const
    : undefined;
}

/** The required property whose distinct `const` values tell the branches of a union apart. */
function discriminatorOf(union: UnionSchema): string {
  const [first] = union.oneOf;
  const name = Object.keys(first?.properties ?? {}).find((candidate) => {
    const tags = union.oneOf.map((branch) =>
      branch.required.includes(candidate) ? constOf(branch.properties[candidate]) : undefined,
    );
    return !tags.includes(undefined) && new Set(tags).size === tags.length;
  });
  if (name === undefined) throw new Error('Union has no discriminating const property.');
  return name;
}

const supported = new WeakSet();

/** Throws unless the schema stays within the supported subset; never silently ignores a keyword. */
export function assertSupportedSchema(schema: JsonSchema, location = '#'): void {
  if (supported.has(schema)) return;
  const kind = 'oneOf' in schema ? 'union' : schema.type;
  const allowed = [
    ...(Object.hasOwn(KEYWORDS, kind) ? (KEYWORDS[kind] ?? []) : []),
    ...ANNOTATIONS,
  ];
  const unsupported = Object.keys(schema).filter((keyword) => !allowed.includes(keyword));
  if (!Object.hasOwn(KEYWORDS, kind) || unsupported.length > 0) {
    throw new Error(`Unsupported JSON Schema at ${location}: ${[kind, ...unsupported].join(', ')}`);
  }
  if ('oneOf' in schema) {
    discriminatorOf(schema);
    schema.oneOf.forEach((branch, index) => {
      assertSupportedSchema(branch, `${location}/oneOf/${String(index)}`);
    });
  } else if (schema.type === 'array') {
    assertSupportedSchema(schema.items, `${location}/items`);
  } else if (schema.type === 'object') {
    const names = Object.keys(schema.properties);
    // Read as unknown on purpose: a schema that bypassed the type may carry any value here.
    const additionalProperties: unknown = schema.additionalProperties;
    if (additionalProperties !== false || schema.required.some((name) => !names.includes(name))) {
      throw new Error(`Object at ${location} must be closed and require only its own properties.`);
    }
    for (const name of names) {
      const property = schema.properties[name];
      if (property !== undefined) assertSupportedSchema(property, pointer(location, name));
    }
  }
  supported.add(schema);
}

function checkString(
  schema: StringSchema,
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof value !== 'string') {
    const message = `Expected string, got ${typeNameOf(value)}.`;
    errors.push({ code: 'invalid-type', path, message });
  } else if (schema.const !== undefined && value !== schema.const) {
    errors.push({ code: 'invalid-value', path, message: `Expected "${schema.const}".` });
  } else if (schema.enum !== undefined && !schema.enum.includes(value)) {
    const message = `Expected one of: ${schema.enum.join(', ')}.`;
    errors.push({ code: 'invalid-value', path, message });
  } else if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    errors.push({ code: 'invalid-value', path, message: `Expected to match ${schema.pattern}.` });
  }
}

function checkNumber(
  schema: NumberSchema,
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const message = `Expected ${schema.type}, got ${typeNameOf(value)}.`;
    errors.push({ code: 'invalid-type', path, message });
  } else if (schema.type === 'integer' && !Number.isInteger(value)) {
    errors.push({ code: 'invalid-type', path, message: 'Expected integer, got a fraction.' });
  } else if (value < schema.minimum || value > schema.maximum) {
    const message = `Expected ${String(schema.minimum)} to ${String(schema.maximum)}.`;
    errors.push({ code: 'out-of-range', path, message });
  }
}

function checkArray(
  schema: ArraySchema,
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value)) {
    const message = `Expected array, got ${typeNameOf(value)}.`;
    errors.push({ code: 'invalid-type', path, message });
    return;
  }
  const items: readonly unknown[] = value;
  const { minItems = 0, maxItems = Infinity } = schema;
  if (items.length < minItems || items.length > maxItems) {
    const message = `Expected ${String(minItems)} to ${String(maxItems)} items.`;
    errors.push({ code: 'invalid-length', path, message });
  }
  // An index loop also visits the holes of a sparse array, which are not JSON data.
  for (let index = 0; index < items.length; index += 1) {
    check(schema.items, items[index], pointer(path, index), errors);
  }
}

function checkObject(
  schema: ObjectSchema,
  value: PlainObject,
  path: string,
  errors: ValidationError[],
): void {
  for (const [name, property] of Object.entries(schema.properties)) {
    // Own properties only: "constructor" or "__proto__" must never resolve to Object.prototype.
    if (Object.hasOwn(value, name)) {
      check(property, value[name], pointer(path, name), errors);
    } else if (schema.required.includes(name)) {
      const message = `Missing required field "${name}".`;
      errors.push({ code: 'missing-field', path: pointer(path, name), message });
    }
  }
  for (const name of Object.keys(value).sort()) {
    if (!Object.hasOwn(schema.properties, name)) {
      const message = `Unknown field "${name}".`;
      errors.push({ code: 'unknown-field', path: pointer(path, name), message });
    }
  }
}

/** Validates the one branch that the discriminator selects, so one defect yields one error. */
function checkUnion(
  schema: UnionSchema,
  value: PlainObject,
  path: string,
  errors: ValidationError[],
): void {
  const tagName = discriminatorOf(schema);
  const tagPath = pointer(path, tagName);
  if (!Object.hasOwn(value, tagName)) {
    const message = `Missing required field "${tagName}".`;
    errors.push({ code: 'missing-field', path: tagPath, message });
    return;
  }
  const tagOf = (branch: ObjectSchema): string | undefined => constOf(branch.properties[tagName]);
  const branch = schema.oneOf.find((candidate) => tagOf(candidate) === value[tagName]);
  if (branch === undefined) {
    const message = `Expected one of: ${schema.oneOf.map(tagOf).join(', ')}.`;
    errors.push({ code: 'invalid-value', path: tagPath, message });
    return;
  }
  checkObject(branch, value, path, errors);
}

function check(schema: JsonSchema, value: unknown, path: string, errors: ValidationError[]): void {
  if ('oneOf' in schema || schema.type === 'object') {
    if (!isPlainObject(value)) {
      const message = `Expected object, got ${typeNameOf(value)}.`;
      errors.push({ code: 'invalid-type', path, message });
    } else if ('oneOf' in schema) {
      checkUnion(schema, value, path, errors);
    } else {
      checkObject(schema, value, path, errors);
    }
  } else if (schema.type === 'array') {
    checkArray(schema, value, path, errors);
  } else if (schema.type === 'string') {
    checkString(schema, value, path, errors);
  } else {
    checkNumber(schema, value, path, errors);
  }
}

/** Structural phase of validation: everything that the JSON Schema itself expresses. */
export function validateStructure(schema: JsonSchema, value: unknown): ValidationError[] {
  assertSupportedSchema(schema);
  const errors: ValidationError[] = [];
  check(schema, value, '', errors);
  return errors;
}
