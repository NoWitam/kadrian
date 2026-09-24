/**
 * The bus must not keep a second copy of the schema's knowledge (D30.8). Which
 * node types carry a position is derived here from `compositionSchema` itself
 * and checked against what the bus actually accepts, so a node type the schema
 * gains later cannot silently stay `unsupported-node`.
 */
import { compositionSchema } from '@kadrion/schema';
import { describe, expect, it } from 'vitest';

import { applyCommand, type Command } from '../src/index.js';

import { codeOf, positionOf, reference } from './support.js';

/** Walks a JSON Schema by key, without claiming a type the schema does not have. */
function at(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function variantsOf(value: unknown): readonly unknown[] {
  const oneOf = at(value, 'oneOf');
  return Array.isArray(oneOf) ? oneOf : [];
}

const nodeVariants = variantsOf(
  at(compositionSchema, 'properties', 'scenes', 'items', 'properties', 'nodes', 'items'),
);
const groupVariant = nodeVariants.find(
  (variant) => at(variant, 'properties', 'type', 'const') === 'group',
);
const childVariants = variantsOf(at(groupVariant, 'properties', 'children', 'items'));

/** Node type → whether schema 0.1 gives that type a `position`. */
const positioned = new Map<string, boolean>(
  [...nodeVariants, ...childVariants].map((variant) => [
    String(at(variant, 'properties', 'type', 'const')),
    at(variant, 'properties', 'position') !== undefined,
  ]),
);

interface FixtureNode {
  readonly id: string;
  readonly type: string;
  readonly children?: readonly FixtureNode[];
}

/** One node of each type in the reference composition, which contains them all (§3.2). */
function nodesByType(): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (node: FixtureNode): void => {
    if (!found.has(node.type)) found.set(node.type, node.id);
    for (const child of node.children ?? []) visit(child);
  };
  for (const scene of (reference() as unknown as { scenes: { nodes: FixtureNode[] }[] }).scenes) {
    for (const node of scene.nodes) visit(node);
  }
  return found;
}

describe('the node types the bus accepts (D30.8)', () => {
  it('reads every node type of schema 0.1 out of the schema itself', () => {
    expect([...positioned.keys()].sort()).toEqual([
      'background',
      'custom-html',
      'group',
      'image',
      'text',
    ]);
    expect(positioned.get('background')).toBe(false);
    expect([...positioned.values()].filter(Boolean)).toHaveLength(4);
  });

  it('has no nested group, which is why searching two levels deep is enough (D16)', () => {
    // `findNode` and `replaceNode` look at a scene's nodes and at one level of
    // children. A group inside a group would make a node unreachable, and the
    // command would answer `unknown-node` for a node that exists.
    for (const variant of childVariants) {
      expect(at(variant, 'properties', 'children')).toBeUndefined();
      expect(at(variant, 'properties', 'type', 'const')).not.toBe('group');
    }
    expect(childVariants.length).toBeGreaterThan(0);
  });

  it('has one node of every type in the reference composition', () => {
    expect([...nodesByType().keys()].sort()).toEqual([...positioned.keys()].sort());
  });

  it.each([...positioned.keys()].sort())(
    'moves a node of type %s exactly when it has a position',
    (type) => {
      const nodeId = nodesByType().get(type) ?? '';
      const document = reference();
      const command: Command = { type: 'SetNodePosition', nodeId, position: { x: 7, y: 9 } };
      if (positioned.get(type) === true) {
        expect(positionOf(applyCommand(document, command).document, nodeId)).toEqual({
          x: 7,
          y: 9,
        });
      } else {
        expect(codeOf(() => applyCommand(document, command))).toBe('unsupported-node');
      }
    },
  );
});
