/**
 * The seven rules of the history (D30.9), each as its own assertion, and the
 * seam PR-09 builds on: `dispatch` takes `unknown` and parses it, so the AI
 * tool contract cannot acquire a second path into the document.
 */
import { describe, expect, it } from 'vitest';
import { referenceComposition } from '@kadrion/test-fixtures';

import { createCommandBus, type Command } from '../src/index.js';

import { codeOf, errorOf, json, positionOf, reference } from './support.js';

const TITLE = 'node-title';
const START = { x: 90, y: 160 };

function move(x: number, y: number): Command {
  return { type: 'SetNodePosition', nodeId: TITLE, position: { x, y } };
}

describe('createCommandBus (D30.9)', () => {
  it('starts from the document it is given', () => {
    const bus = createCommandBus(referenceComposition);
    expect(json(bus.getDocument())).toBe(json(reference()));
    expect(bus.canUndo()).toBe(false);
    expect(bus.canRedo()).toBe(false);
  });

  it('refuses a document that is not a composition', () => {
    expect(codeOf(() => createCommandBus({ schemaVersion: '0.1' }))).toBe('invalid-document');
    expect(codeOf(() => createCommandBus(null))).toBe('invalid-document');
    expect(errorOf(() => createCommandBus({ schemaVersion: '0.9' })).details.join('\n')).toContain(
      'schemaVersion',
    );
  });

  it('rule 1: a dispatched command pushes its inverse on the undo stack', () => {
    const bus = createCommandBus(referenceComposition);
    const result = bus.dispatch(move(120, 200));
    expect(result.inverse).toEqual({ type: 'SetNodePosition', nodeId: TITLE, position: START });
    expect(bus.canUndo()).toBe(true);
    expect(positionOf(bus.getDocument(), TITLE)).toEqual({ x: 120, y: 200 });
  });

  it('rules 2 and 3: undo applies the inverse and its own inverse becomes the redo entry', () => {
    const original = json(reference());
    const bus = createCommandBus(referenceComposition);
    bus.dispatch(move(120, 200));
    const undone = bus.undo();
    expect(json(bus.getDocument())).toBe(original);
    expect(undone.inverse).toEqual({
      type: 'SetNodePosition',
      nodeId: TITLE,
      position: { x: 120, y: 200 },
    });
    expect(bus.canUndo()).toBe(false);
    expect(bus.canRedo()).toBe(true);
  });

  it('rule 4: redo goes forward again, and the pair can be repeated', () => {
    const original = json(reference());
    const bus = createCommandBus(referenceComposition);
    const edited = json(bus.dispatch(move(120, 200)).document);
    for (let round = 0; round < 3; round += 1) {
      bus.undo();
      expect(json(bus.getDocument())).toBe(original);
      bus.redo();
      expect(json(bus.getDocument())).toBe(edited);
    }
  });

  it('unwinds a stack of several commands in order', () => {
    const bus = createCommandBus(referenceComposition);
    const states = [json(bus.getDocument())];
    for (const [x, y] of [
      [100, 100],
      [110, 120],
      [130, 140],
    ]) {
      bus.dispatch(move(x ?? 0, y ?? 0));
      states.push(json(bus.getDocument()));
    }
    for (let at = states.length - 1; at > 0; at -= 1) {
      expect(json(bus.getDocument())).toBe(states[at]);
      bus.undo();
    }
    expect(json(bus.getDocument())).toBe(states[0]);
    expect(bus.canUndo()).toBe(false);
  });

  it('rule 5: a new command after an undo clears the redo stack', () => {
    const bus = createCommandBus(referenceComposition);
    bus.dispatch(move(120, 200));
    bus.undo();
    expect(bus.canRedo()).toBe(true);
    bus.dispatch(move(300, 400));
    expect(bus.canRedo()).toBe(false);
    expect(codeOf(() => bus.redo())).toBe('nothing-to-redo');
  });

  it('rule 6: a failed command changes neither stack nor the document', () => {
    const bus = createCommandBus(referenceComposition);
    bus.dispatch(move(120, 200));
    const document = json(bus.getDocument());
    for (const bad of [
      move(2_000_000, 0),
      { type: 'SetNodePosition', nodeId: 'node-missing', position: { x: 1, y: 2 } },
      { type: 'MoveNode', nodeId: TITLE, dx: 1, dy: 1 },
      { type: 'SetNodePosition', nodeId: TITLE, position: { x: Number.NaN, y: 0 } },
      'not a command',
    ]) {
      expect(codeOf(() => bus.dispatch(bad))).not.toBe('did not throw');
      expect(json(bus.getDocument())).toBe(document);
      expect(bus.canUndo()).toBe(true);
      expect(bus.canRedo()).toBe(false);
    }
    bus.undo();
    expect(json(bus.getDocument())).toBe(json(reference()));
  });

  it('rule 7: a command that changes no value writes no history entry', () => {
    const bus = createCommandBus(referenceComposition);
    const result = bus.dispatch(move(START.x, START.y));
    expect(result.inverse).toBeNull();
    expect(bus.canUndo()).toBe(false);
    expect(codeOf(() => bus.undo())).toBe('nothing-to-undo');
  });

  it('a no-op after an undo does not throw the redo branch away either', () => {
    const bus = createCommandBus(referenceComposition);
    bus.dispatch(move(120, 200));
    bus.undo();
    bus.dispatch(move(START.x, START.y));
    expect(bus.canRedo()).toBe(true);
    bus.redo();
    expect(positionOf(bus.getDocument(), TITLE)).toEqual({ x: 120, y: 200 });
  });

  it('reports an empty stack with a typed error', () => {
    const bus = createCommandBus(referenceComposition);
    expect(codeOf(() => bus.undo())).toBe('nothing-to-undo');
    expect(codeOf(() => bus.redo())).toBe('nothing-to-redo');
  });

  it('keeps the history out of reach of a caller that mutates its command afterwards', () => {
    const original = json(reference());
    const bus = createCommandBus(referenceComposition);
    const payload = { type: 'SetNodePosition', nodeId: TITLE, position: { x: 120, y: 200 } };
    bus.dispatch(payload);
    payload.position.x = 999;
    payload.nodeId = 'node-caption';
    bus.undo();
    expect(json(bus.getDocument())).toBe(original);
  });

  describe('a frozen facade (D30.13)', () => {
    // Test modules are ES modules, so these run in strict mode, where a write to
    // a frozen object throws instead of failing silently.
    type Loose = Record<string, unknown>;

    it('is frozen', () => {
      expect(Object.isFrozen(createCommandBus(referenceComposition))).toBe(true);
    });

    it('refuses a replaced dispatch with a TypeError and keeps the original', () => {
      const bus = createCommandBus(referenceComposition);
      const original = Object.getOwnPropertyDescriptor(bus, 'dispatch')?.value as unknown;
      expect(() => {
        (bus as unknown as Loose).dispatch = () => null;
      }).toThrow(TypeError);
      expect(Object.getOwnPropertyDescriptor(bus, 'dispatch')?.value).toBe(original);
    });

    it('refuses a new property with a TypeError', () => {
      const bus = createCommandBus(referenceComposition);
      expect(() => {
        (bus as unknown as Loose).applyDirectly = () => null;
      }).toThrow(TypeError);
      expect('applyDirectly' in bus).toBe(false);
    });

    it('refuses a deleted method with a TypeError', () => {
      const bus = createCommandBus(referenceComposition);
      expect(() => {
        delete (bus as unknown as Partial<Loose>).undo;
      }).toThrow(TypeError);
      expect(typeof bus.undo).toBe('function');
    });

    it('still changes the state its closure holds through dispatch, undo, and redo', () => {
      const bus = createCommandBus(referenceComposition);
      const first = bus.getDocument();
      bus.dispatch(move(120, 200));
      const moved = bus.getDocument();
      expect(moved).not.toBe(first);
      expect(positionOf(moved, TITLE)).toEqual({ x: 120, y: 200 });
      expect(bus.canUndo()).toBe(true);
      bus.undo();
      expect(positionOf(bus.getDocument(), TITLE)).toEqual(START);
      expect(bus.canRedo()).toBe(true);
      bus.redo();
      expect(positionOf(bus.getDocument(), TITLE)).toEqual({ x: 120, y: 200 });
    });
  });

  it('accepts the unparsed payload an AI tool would hand it (D30.9)', () => {
    const bus = createCommandBus(referenceComposition);
    const fromTool: unknown = JSON.parse(
      '{"type":"SetNodePosition","nodeId":"node-title","position":{"x":120.4,"y":199.5}}',
    );
    bus.dispatch(fromTool);
    expect(positionOf(bus.getDocument(), TITLE)).toEqual({ x: 120, y: 200 });
  });
});
