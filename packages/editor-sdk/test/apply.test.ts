/**
 * `applyCommand` against the reference composition (D30.4–D30.7). The fixture
 * is deep-frozen, so any attempt to edit the input in place throws instead of
 * passing unnoticed. The comparisons use the raw `JSON.stringify` that P3 and
 * P4 speak of, not a canonical form: the order of the keys is part of what the
 * host stores (D02).
 */
import { referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { applyCommand, type Command } from '../src/index.js';

import { codeOf, errorOf, json, nodeOf, positionOf, reference, validated } from './support.js';

/** `node-title`: a top-level text node at 90, 160 with an opacity animation only. */
const TITLE = 'node-title';
/** `node-caption`: a text node inside `node-group`, at 0, 720. */
const CAPTION = 'node-caption';

function move(nodeId: string, x: number, y: number): Command {
  return { type: 'SetNodePosition', nodeId, position: { x, y } };
}

describe('applyCommand (D30.4)', () => {
  it('sets the absolute position of a top-level node', () => {
    const document = reference();
    const result = applyCommand(document, move(TITLE, 120, 200));
    expect(positionOf(result.document, TITLE)).toEqual({ x: 120, y: 200 });
  });

  it('returns an inverse carrying the previous position, as a typed command (D30.5)', () => {
    const result = applyCommand(reference(), move(TITLE, 120, 200));
    expect(result.inverse).toEqual({
      type: 'SetNodePosition',
      nodeId: TITLE,
      position: { x: 90, y: 160 },
    });
  });

  it('leaves the input document exactly as it was (D30.7)', () => {
    const document = reference();
    const before = json(document);
    applyCommand(document, move(TITLE, 120, 200));
    expect(json(document)).toBe(before);
    expect(positionOf(document, TITLE)).toEqual({ x: 90, y: 160 });
  });

  it('rebuilds only the path to the node and shares every untouched subtree', () => {
    const document = reference();
    const { document: edited } = applyCommand(document, move(TITLE, 120, 200));
    expect(edited).not.toBe(document);
    expect(edited.assets).toBe(document.assets);
    expect(edited.clips).toBe(document.clips);
    expect(edited.scenes[0]?.nodes[0]).toBe(document.scenes[0]?.nodes[0]);
    expect(edited.scenes[0]?.nodes[1]).toBe(document.scenes[0]?.nodes[1]);
    expect(nodeOf(edited, 'node-custom-html')).toBe(nodeOf(document, 'node-custom-html'));
    // Only the node itself is a new object, and its animations are the same ones.
    const title = nodeOf(edited, TITLE);
    expect(title).not.toBe(nodeOf(document, TITLE));
    expect(title.animations).toBe(nodeOf(document, TITLE).animations);
  });

  it('keeps every other byte of the document, including the order of the keys', () => {
    const document = reference();
    const { document: edited } = applyCommand(document, move(TITLE, 120, 200));
    expect(json(edited)).toBe(
      json(document).replace('"position":{"x":90,"y":160}', '"position":{"x":120,"y":200}'),
    );
  });

  it('keeps the key order of a document that spells position as y before x (D02, D30.7)', () => {
    // Taskio stores JSON text, and `{"y":…,"x":…}` validates just as well. An
    // implementation that builds a fresh `{ x, y }` passes every other test here
    // and still changes bytes forward without changing them back.
    const draft = structuredClone(referenceComposition) as {
      scenes: { nodes: { id: string; position?: unknown }[] }[];
    };
    const title = draft.scenes[0]?.nodes.find((node) => node.id === TITLE);
    if (title === undefined) throw new Error('The fixture has no title node.');
    title.position = { y: 160, x: 90 };
    const document = validated(draft);
    expect(json(document)).toContain('"position":{"y":160,"x":90}');

    const forward = applyCommand(document, move(TITLE, 120, 200));
    expect(json(forward.document)).toContain('"position":{"y":200,"x":120}');
    if (forward.inverse === null) throw new Error('The command reported no change.');
    const back = applyCommand(forward.document, forward.inverse);
    expect(json(back.document)).toBe(json(draft));
  });

  it('never sees duplicate IDs, because the schema refuses such a document first', () => {
    // Searching for a node and replacing it walk the tree in different orders,
    // which could only matter if two nodes shared an ID. `applyCommand` takes a
    // `ValidatedComposition`, and this is what makes that type enough.
    const draft = structuredClone(referenceComposition) as {
      scenes: { nodes: { id: string }[] }[];
    };
    const nodes = draft.scenes[0]?.nodes;
    if (nodes?.[0] === undefined) throw new Error('The fixture has no nodes.');
    nodes[0].id = TITLE;
    expect(() => validated(draft)).toThrow(/does not validate/);
  });

  it('undoes to a byte-identical document (P3)', () => {
    const document = reference();
    const forward = applyCommand(document, move(TITLE, 120, 200));
    if (forward.inverse === null) throw new Error('The command reported no change.');
    const back = applyCommand(forward.document, forward.inverse);
    expect(json(back.document)).toBe(json(document));
  });

  it('moves a node inside a group and leaves its siblings alone', () => {
    const document = reference();
    const { document: edited, inverse } = applyCommand(document, move(CAPTION, 10, 700));
    expect(positionOf(edited, CAPTION)).toEqual({ x: 10, y: 700 });
    expect(inverse).toEqual({
      type: 'SetNodePosition',
      nodeId: CAPTION,
      position: { x: 0, y: 720 },
    });
    expect(nodeOf(edited, 'node-image')).toBe(nodeOf(document, 'node-image'));
    expect(json(document)).toBe(json(reference()));
  });

  it('is idempotent: the second application changes nothing (D30.1)', () => {
    const once = applyCommand(reference(), move(TITLE, 120, 200));
    const twice = applyCommand(once.document, move(TITLE, 120, 200));
    expect(twice.document).toBe(once.document);
    expect(twice.inverse).toBeNull();
  });

  it('writes no history entry when the value does not change (D30.9)', () => {
    const document = reference();
    const result = applyCommand(document, move(TITLE, 90, 160));
    expect(result.document).toBe(document);
    expect(result.inverse).toBeNull();
  });

  it('treats -0 as 0, so it is a no-op and not a history entry', () => {
    const document = reference();
    // `node-image` sits at 0, 0 inside the group.
    const result = applyCommand(document, move('node-image', -0, -0));
    expect(result.document).toBe(document);
    expect(result.inverse).toBeNull();
  });

  it('parses a typed literal too, so a fractional coordinate is rounded (D30.3)', () => {
    const document = reference();
    const literal = applyCommand(document, move(TITLE, 119.6, 200.4));
    const parsed = applyCommand(document, move(TITLE, 120, 200));
    expect(json(literal.document)).toBe(json(parsed.document));
    expect(literal.inverse).toEqual(parsed.inverse);
  });

  it.each([
    ['an unknown node', move('node-missing', 1, 2), 'unknown-node'],
    ['a node without a position', move('node-background', 1, 2), 'unsupported-node'],
    ['a scene, which is not a node', move('scene-main', 1, 2), 'unknown-node'],
    ['an asset, which is not a node', move('asset-image', 1, 2), 'unknown-node'],
    ['an animation, which is not a node', move('anim-title-opacity', 1, 2), 'unknown-node'],
  ])('rejects %s with %s', (_, command, code) => {
    expect(codeOf(() => applyCommand(reference(), command))).toBe(code);
  });

  it('refuses a result the schema rejects, and leaves the document untouched (D30.6)', () => {
    const document = reference();
    const before = json(document);
    const error = errorOf(() => applyCommand(document, move(TITLE, 2_000_000, 0)));
    expect(error.code).toBe('invalid-result');
    expect(error.details.join('\n')).toContain('/scenes/0/nodes/2/position/x');
    expect(json(document)).toBe(before);
  });

  it('reports the errors of the schema rather than restating its rules', () => {
    const error = errorOf(() => applyCommand(reference(), move(TITLE, -1_000_001, 0)));
    expect(error.code).toBe('invalid-result');
    expect(error.details).not.toEqual([]);
  });

  it('accepts a position outside the canvas, because the schema does (no clamping)', () => {
    const { document } = applyCommand(reference(), move(TITLE, -500, 5000));
    expect(positionOf(document, TITLE)).toEqual({ x: -500, y: 5000 });
  });
});
