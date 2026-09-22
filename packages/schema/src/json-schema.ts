/**
 * The subset of JSON Schema (draft 2020-12) that schema 0.1 is written in, and
 * the type-level derivation of document types from it (D17).
 *
 * The subset is deliberately closed. Objects reject unknown fields and require
 * every property (D16), numbers are bounded (D15), and a union is a `oneOf`
 * over object branches. The first need for anything else triggers the exit
 * criterion of D17 instead of an extension here.
 */

/** Keywords that never affect validation. */
interface Annotations {
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
}

export interface StringSchema extends Annotations {
  readonly type: 'string';
  readonly const?: string;
  readonly enum?: readonly string[];
  readonly pattern?: string;
}

export interface NumberSchema extends Annotations {
  readonly type: 'integer' | 'number';
  readonly minimum: number;
  readonly maximum: number;
}

export interface ArraySchema extends Annotations {
  readonly type: 'array';
  readonly items: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface ObjectSchema extends Annotations {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/** Branches are told apart by distinct `const` values of one common property. */
export interface UnionSchema extends Annotations {
  readonly oneOf: readonly ObjectSchema[];
}

export type JsonSchema = StringSchema | NumberSchema | ArraySchema | ObjectSchema | UnionSchema;

export interface ClosedObject<P> {
  readonly type: 'object';
  readonly description: string;
  readonly additionalProperties: false;
  readonly required: readonly (keyof P & string)[];
  readonly properties: P;
}

/** Builds an object schema that rejects unknown fields and requires every property (D16). */
export function closedObject<const P extends Readonly<Record<string, JsonSchema>>>(
  description: string,
  properties: P,
): ClosedObject<P> {
  return {
    type: 'object',
    description,
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

/**
 * The document type that a schema describes. Every property is required because
 * `ObjectSchema` has no optional properties; `composition-schema.test.ts` checks
 * that `required` really lists all of them.
 */
export type Infer<S> = S extends { readonly const: infer C }
  ? C
  : S extends { readonly enum: readonly (infer E)[] }
    ? E
    : S extends { readonly oneOf: readonly (infer B)[] }
      ? Infer<B>
      : S extends { readonly type: 'string' }
        ? string
        : S extends { readonly type: 'integer' | 'number' }
          ? number
          : S extends { readonly type: 'array'; readonly items: infer I }
            ? readonly Infer<I>[]
            : S extends { readonly type: 'object'; readonly properties: infer P }
              ? { readonly [K in keyof P]: Infer<P[K]> }
              : never;
