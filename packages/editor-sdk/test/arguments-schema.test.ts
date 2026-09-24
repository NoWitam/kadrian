/**
 * The JSON Schema of the arguments of `SetNodePosition` and the parser it must
 * agree with (D31.2, D31.9). The schema is written by hand next to
 * `parseCommand`, so nothing but this test keeps the two from drifting: one
 * corpus goes to Ajv, an independent validator, and — with the discriminator
 * added — to `parseCommand`, and both must give the same verdict on every row.
 *
 * The corpus is built from the schema's own properties, not from a list
 * written out again: every property missing, every property replaced by each
 * value of a pool of JSON values, an extra field at every object level. The
 * rows whose normalised coordinates matter are written by hand, with the
 * result stated rather than recomputed.
 *
 * The domain is JSON, the values `JSON.parse` returns, which is what a tool
 * call delivers. Arguments with an own `type` are outside it here: adding the
 * discriminator is the AI tool's job and is tested in `@kadrion/ai-sdk`.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_TYPES,
  EditorError,
  parseCommand,
  setNodePositionArgumentsSchema,
  type ArgumentSchema,
} from '../src/index.js';

const schema = setNodePositionArgumentsSchema;
const ajv = new Ajv2020({ strict: true, strictNumbers: true, allErrors: false });
const accepts = ajv.compile(schema);

/** The valid arguments every generated row is a variant of. */
const BASE = { nodeId: 'node-title', position: { x: 190, y: 360 } };

/** One value of every JSON type, including the edges of the string and number types. */
const POOL: readonly unknown[] = [
  '',
  'node-title',
  '12',
  0,
  -0,
  1.5,
  -2.5,
  1e300,
  true,
  false,
  null,
  [],
  [1, 2],
  {},
  { x: 1, y: 2 },
];

type Path = readonly string[];

/** Every place in the arguments the schema describes, found by walking it. */
function slotsOf(node: ArgumentSchema, path: Path = []): Path[] {
  if (node.type !== 'object') return [path];
  return [
    path,
    ...Object.entries(node.properties).flatMap(([name, child]) => slotsOf(child, [...path, name])),
  ];
}

/** Every object the schema describes, with its property names. */
function objectsOf(node: ArgumentSchema, path: Path = []): { path: Path; names: string[] }[] {
  if (node.type !== 'object') return [];
  return [
    { path, names: Object.keys(node.properties) },
    ...Object.entries(node.properties).flatMap(([name, child]) =>
      objectsOf(child, [...path, name]),
    ),
  ];
}

/** A deep copy of `BASE` with `edit` applied to the object at `path`. */
function variant(
  path: Path,
  edit: (parent: Record<string, unknown>, key: string) => void,
): unknown {
  const copy = structuredClone(BASE) as Record<string, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  edit(parent, path[path.length - 1] ?? '');
  return copy;
}

interface Row {
  readonly label: string;
  readonly args: unknown;
}

/** The generated corpus: missing, replaced, and extra fields at every level of the schema. */
function generatedRows(): Row[] {
  const rows: Row[] = [{ label: 'the base arguments', args: structuredClone(BASE) }];
  for (const path of slotsOf(schema)) {
    for (const value of POOL) {
      const label = `${path.join('.') || '(root)'} = ${JSON.stringify(value)}${Object.is(value, -0) ? ' (-0)' : ''}`;
      rows.push({
        label,
        args:
          path.length === 0
            ? value
            : variant(path, (parent, key) => {
                parent[key] = value;
              }),
      });
    }
  }
  for (const { path, names } of objectsOf(schema)) {
    for (const name of names) {
      rows.push({
        label: `${[...path, name].join('.')} missing`,
        args: variant([...path, name], (parent, key) => {
          Reflect.deleteProperty(parent, key);
        }),
      });
    }
    rows.push({
      label: `an extra field in ${path.join('.') || '(root)'}`,
      args:
        path.length === 0
          ? { ...structuredClone(BASE), extra: 1 }
          : variant(path, (parent, key) => {
              parent[key] = { ...(parent[key] as object), extra: 1 };
            }),
    });
  }
  return rows;
}

/** Rows whose normalised position is stated by hand (D30.3), as JSON text. */
const NORMALISED: readonly { json: string; position: { x: number; y: number } }[] = [
  { json: '{"nodeId":"node-title","position":{"x":190,"y":360}}', position: { x: 190, y: 360 } },
  { json: '{"position":{"y":360,"x":190},"nodeId":"node-title"}', position: { x: 190, y: 360 } },
  { json: '{"nodeId":"node-title","position":{"x":12.5,"y":2.5}}', position: { x: 13, y: 3 } },
  { json: '{"nodeId":"node-title","position":{"x":-2.5,"y":-1.5}}', position: { x: -2, y: -1 } },
  { json: '{"nodeId":"node-title","position":{"x":-0,"y":-0.4}}', position: { x: 0, y: 0 } },
  { json: '{"nodeId":"node-title","position":{"x":1e-7,"y":190.0}}', position: { x: 0, y: 190 } },
  {
    json: '{"nodeId":"node-title","position":{"x":0.49999999999999994,"y":192.85714285714286}}',
    position: { x: 0, y: 193 },
  },
  // Accepted by both: the bounds are the document's, refused later as invalid-result (D31.2).
  {
    json: '{"nodeId":"node-title","position":{"x":1e21,"y":-5000000}}',
    position: { x: 1e21, y: -5e6 },
  },
  { json: '{"nodeId":"węzeł","position":{"x":1,"y":2}}', position: { x: 1, y: 2 } },
  { json: '{"nodeId":" ","position":{"x":1,"y":2}}', position: { x: 1, y: 2 } },
];

/** Rows both must refuse that the generator does not produce, as JSON text. */
const REFUSED: readonly string[] = [
  '{"__proto__":{"x":1},"nodeId":"node-title","position":{"x":1,"y":2}}',
  '{"nodeId":"node-title","position":{"__proto__":{"z":1},"x":1,"y":2}}',
  '{"nodeId":"node-title","position":{"x":"1","y":2}}',
  '{"nodeId":7,"position":{"x":1,"y":2}}',
  '"{\\"nodeId\\":\\"node-title\\",\\"position\\":{\\"x\\":1,\\"y\\":2}}"',
];

/** The verdict of `parseCommand` on the arguments with the discriminator added. */
function parsed(args: unknown): { ok: true; x: number; y: number } | { ok: false; code: string } {
  const command =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? { type: 'SetNodePosition', ...args }
      : args;
  try {
    const { position } = parseCommand(command);
    return { ok: true, x: position.x, y: position.y };
  } catch (reason) {
    if (reason instanceof EditorError) return { ok: false, code: reason.code };
    throw reason;
  }
}

function disagreements(rows: readonly Row[]): string[] {
  return rows
    .filter(({ args }) => accepts(args) !== parsed(args).ok)
    .map(
      ({ label, args }) =>
        `${label}: Ajv ${String(accepts(args))}, parseCommand ${JSON.stringify(parsed(args))}`,
    );
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('the argument schema of SetNodePosition (D31.2)', () => {
  it('is a valid draft 2020-12 schema that Ajv compiles under strict mode', () => {
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(accepts(BASE)).toBe(true);
  });

  it('is deep-frozen, so no caller can edit the schema every tool shares', () => {
    expect(isDeepFrozen(schema)).toBe(true);
    expect(() => {
      (schema.properties.position.required as string[]).push('z');
    }).toThrow(TypeError);
  });

  it('closes every object and requires every property it names', () => {
    for (const { path, names } of objectsOf(schema)) {
      let node: ArgumentSchema = schema;
      for (const key of path) {
        if (node.type !== 'object') throw new Error(`Not an object at ${path.join('.')}.`);
        const child: ArgumentSchema | undefined = node.properties[key];
        if (child === undefined) throw new Error(`No property ${key}.`);
        node = child;
      }
      if (node.type !== 'object') throw new Error('Not an object.');
      expect(node.additionalProperties, path.join('.')).toBe(false);
      expect([...node.required].sort(), path.join('.')).toEqual([...names].sort());
    }
  });

  it('comes with a frozen list of command types, which no caller can extend (D31.8)', () => {
    expect(Object.isFrozen(COMMAND_TYPES)).toBe(true);
    expect(() => {
      (COMMAND_TYPES as string[]).push('Foo');
    }).toThrow(TypeError);
  });

  it('describes the arguments, not the command: there is no type field', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(['nodeId', 'position']);
    expect(accepts({ type: 'SetNodePosition', ...BASE })).toBe(false);
  });

  it('states the rounding rule, which a model cannot read from parseCommand', () => {
    const { x, y } = schema.properties.position.properties;
    for (const coordinate of [x, y]) {
      expect(coordinate.type).toBe('number');
      expect(coordinate.description).toContain('halves towards +Infinity');
      expect(coordinate.description).toContain('-0 becomes 0');
    }
  });
});

describe('the argument schema and parseCommand agree (D31.9)', () => {
  it('builds a corpus that reaches every property and both verdicts', () => {
    // The premise: a corpus that only held accepted, or only refused, rows
    // would agree with any schema.
    const rows = generatedRows();
    expect(slotsOf(schema).map((path) => path.join('.'))).toEqual([
      '',
      'nodeId',
      'position',
      'position.x',
      'position.y',
    ]);
    expect(rows.filter(({ args }) => accepts(args)).length).toBeGreaterThan(5);
    expect(rows.filter(({ args }) => !accepts(args)).length).toBeGreaterThan(40);
  });

  it('gives the same verdict on every generated row', () => {
    expect(disagreements(generatedRows())).toEqual([]);
  });

  it('gives the same verdict on the hand-written rows', () => {
    const rows = [
      ...NORMALISED.map(({ json }) => ({ label: json, args: JSON.parse(json) as unknown })),
      ...REFUSED.map((json) => ({ label: json, args: JSON.parse(json) as unknown })),
    ];
    expect(disagreements(rows)).toEqual([]);
    for (const json of REFUSED) expect(accepts(JSON.parse(json)), json).toBe(false);
  });

  it('normalises every accepted hand-written row as stated', () => {
    for (const { json, position } of NORMALISED) {
      const verdict = parsed(JSON.parse(json));
      if (!verdict.ok) throw new Error(`${json} was refused: ${verdict.code}`);
      expect(Object.is(verdict.x, position.x) && Object.is(verdict.y, position.y), json).toBe(true);
    }
  });

  it('refuses the numbers JSON cannot carry on both sides', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const args = { nodeId: 'node-title', position: { x: value, y: 0 } };
      expect(accepts(args), String(value)).toBe(false);
      expect(parsed(args), String(value)).toEqual({ ok: false, code: 'invalid-argument' });
    }
  });
});
