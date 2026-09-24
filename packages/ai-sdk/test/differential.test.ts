/**
 * The tool's verdict on its arguments agrees with its own `inputSchema`
 * (D31.9). `editor-sdk` proves that its schema and `parseCommand` agree; this
 * proves the same for the whole tool, the adapter of D31.3 included, so a
 * model that obeys the schema is never refused for its arguments, and one that
 * does not is always refused with `invalid-argument`.
 *
 * Each row runs on a fresh bus. A refusal of the arguments is `invalid-argument`
 * (or `unknown-command`); any other outcome — success, `unknown-node`,
 * `invalid-result` — means the arguments were accepted and the bus judged the
 * edit. The corpus is built from the schema's properties, plus the rows only
 * the adapter can get wrong: an own `type`, and values that are not objects.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createCommandBus, type ArgumentSchema } from '@kadrion/editor-sdk';
import { referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { executeSetNodePosition, setNodePositionTool } from '../src/index.js';

import { codeOf, json } from './support.js';

const schema = setNodePositionTool.inputSchema;
const accepts = new Ajv2020({ strict: true, strictNumbers: true }).compile(schema);

const BASE = { nodeId: 'node-title', position: { x: 190, y: 360 } };
const POOL: readonly unknown[] = [
  '',
  'node-title',
  '12',
  0,
  -0,
  7.5,
  true,
  null,
  [],
  {},
  { x: 1, y: 2 },
];

type Path = readonly string[];

function slotsOf(node: ArgumentSchema, path: Path = []): Path[] {
  if (node.type !== 'object') return [path];
  return [
    path,
    ...Object.entries(node.properties).flatMap(([name, child]) => slotsOf(child, [...path, name])),
  ];
}

function withValue(path: Path, value: unknown, remove = false): unknown {
  if (path.length === 0) return value;
  const copy = structuredClone(BASE) as Record<string, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  const key = path[path.length - 1] ?? '';
  if (remove) Reflect.deleteProperty(parent, key);
  else parent[key] = value;
  return copy;
}

interface Row {
  readonly label: string;
  readonly args: unknown;
}

function rows(): Row[] {
  const slots = slotsOf(schema);
  return [
    { label: 'the base arguments', args: structuredClone(BASE) },
    ...slots.flatMap((path) =>
      POOL.map((value) => ({
        label: `${path.join('.') || '(root)'} = ${JSON.stringify(value)}`,
        args: withValue(path, value),
      })),
    ),
    ...slots
      .filter((path) => path.length > 0)
      .map((path) => ({ label: `${path.join('.')} missing`, args: withValue(path, null, true) })),
    // The rows the adapter decides: the discriminator is the tool's to add (D31.3).
    ...['"SetNodePosition"', '"Other"', 'null', '7'].map((type) => ({
      label: `an own type ${type}`,
      args: JSON.parse(
        `{"type":${type},"nodeId":"node-title","position":{"x":1,"y":2}}`,
      ) as unknown,
    })),
    {
      label: 'an own __proto__',
      args: JSON.parse(
        '{"__proto__":{"type":"Other"},"nodeId":"node-title","position":{"x":1,"y":2}}',
      ) as unknown,
    },
    { label: 'an extra field', args: { ...structuredClone(BASE), extra: 1 } },
    { label: 'an unknown node', args: withValue(['nodeId'], 'node-missing') },
    { label: 'a coordinate the document cannot hold', args: withValue(['position', 'x'], 1e9) },
  ];
}

/** Whether the tool accepted the arguments, whatever the bus then made of the edit. */
function toolAccepts(args: unknown): boolean {
  const code = codeOf(() => executeSetNodePosition(createCommandBus(referenceComposition), args));
  if (code.startsWith('threw')) throw new Error(`The tool threw a non-EditorError: ${code}`);
  return code !== 'invalid-argument' && code !== 'unknown-command';
}

describe('the tool agrees with its own inputSchema (D31.9)', () => {
  it('builds a corpus with both verdicts and the adapter rows', () => {
    const corpus = rows();
    expect(corpus.filter(({ args }) => accepts(args)).length).toBeGreaterThan(5);
    expect(corpus.filter(({ args }) => !accepts(args)).length).toBeGreaterThan(30);
    expect(corpus.filter(({ label }) => label.startsWith('an own type'))).toHaveLength(4);
  });

  it('accepts exactly the arguments the schema accepts', () => {
    const disagreements = rows()
      .filter(({ args }) => accepts(args) !== toolAccepts(args))
      .map(({ label, args }) => `${label} ${json(args)}: schema ${String(accepts(args))}`);
    expect(disagreements).toEqual([]);
  });
});
