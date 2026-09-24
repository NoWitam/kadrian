/**
 * The tool contract of `set_node_position` (D31) and the unit form of P4: a
 * tool call with the parameters of a drag produces the document the drag
 * produces, byte for byte, through the same bus and into the same history.
 * The repository-level evidence, which drives the playground's own gesture,
 * is `tests/app/ai-equivalence.test.ts`.
 */
import {
  createCommandBus,
  setNodePositionArgumentsSchema,
  type CommandBus,
  type CommandResult,
} from '@kadrion/editor-sdk';
import { referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import * as aiSdk from '../src/index.js';
import { executeSetNodePosition, setNodePositionTool } from '../src/index.js';

import {
  codeOf,
  deepFreeze,
  isDeepFrozen,
  json,
  START,
  stateOf,
  TITLE,
  toolArgs,
  uiMove,
  yBeforeX,
} from './support.js';

/**
 * The one capability the tool is given, and nothing else: a frozen object with
 * `dispatch` alone. Reaching for another method of the host bus is a TypeError,
 * and so is replacing `dispatch` on it (D31.5).
 */
function dispatchOnly(bus: CommandBus): Pick<CommandBus, 'dispatch'> {
  return Object.freeze({ dispatch: (command: unknown) => bus.dispatch(command) });
}

/** A bus that records every payload handed to `dispatch` and forwards it. */
function recording(bus: CommandBus): { bus: CommandBus; payloads: unknown[] } {
  const payloads: unknown[] = [];
  return {
    payloads,
    bus: {
      ...bus,
      dispatch(command) {
        payloads.push(command);
        return bus.dispatch(command);
      },
    },
  };
}

describe('the definition of set_node_position (D31.1, D31.2)', () => {
  it('is named, described, and carries the argument schema of editor-sdk itself', () => {
    expect(setNodePositionTool.name).toBe('set_node_position');
    expect(setNodePositionTool.description).toContain('absolute base position');
    // The very object, not a copy: nothing here can drift from the command.
    expect(setNodePositionTool.inputSchema).toBe(setNodePositionArgumentsSchema);
  });

  it('is deep-frozen, so a host cannot change what every other host sends', () => {
    expect(isDeepFrozen(setNodePositionTool)).toBe(true);
    expect(() => {
      (setNodePositionTool as { name: string }).name = 'execute_command';
    }).toThrow(TypeError);
  });

  it('exports exactly the tool and its function: no registry, no undo tool, no raw command', () => {
    expect(Object.keys(aiSdk).sort()).toEqual(['executeSetNodePosition', 'setNodePositionTool']);
  });
});

describe('executeSetNodePosition on the host bus (D31.3, D31.4)', () => {
  it('dispatches exactly once, with the discriminator added and nothing else changed', () => {
    const { bus, payloads } = recording(createCommandBus(referenceComposition));
    executeSetNodePosition(bus, toolArgs(12.5, -0));
    // The adapter neither rounds nor normalises: that is the parser's alone (D30.3).
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      type: 'SetNodePosition',
      nodeId: TITLE,
      position: { x: 12.5, y: -0 },
    });
    expect(Object.is((payloads[0] as { position: { y: number } }).position.y, -0)).toBe(true);
  });

  it('returns the result of dispatch as it is: the bus document and the inverse', () => {
    const bus = createCommandBus(referenceComposition);
    const result = executeSetNodePosition(bus, toolArgs(190, 360));
    expect(result.document).toBe(bus.getDocument());
    expect(result.inverse).toEqual(uiMove(START.x, START.y));
  });

  it('needs dispatch alone: a bus whose other methods throw is enough (D31.5)', () => {
    const real = createCommandBus(referenceComposition);
    const refuse = (): never => {
      throw new Error('The tool reached past dispatch.');
    };
    const onlyDispatch: CommandBus = Object.freeze({
      dispatch: (command: unknown) => real.dispatch(command),
      getDocument: refuse,
      canUndo: refuse,
      canRedo: refuse,
      undo: refuse,
      redo: refuse,
    });
    const result = executeSetNodePosition(onlyDispatch, toolArgs(190, 360));
    expect(result.document).toBe(real.getDocument());
    expect(executeSetNodePosition(dispatchOnly(real), toolArgs(120, 200)).document).toBe(
      real.getDocument(),
    );
  });

  it('reports a no-op as the bus does: the same document and no inverse', () => {
    const bus = createCommandBus(referenceComposition);
    const before = bus.getDocument();
    const result = executeSetNodePosition(bus, toolArgs(START.x, START.y));
    expect(result).toEqual({ document: before, inverse: null });
    expect(result.document).toBe(before);
    expect(bus.canUndo()).toBe(false);
  });
});

describe('the tool call and the UI command give one document (P4)', () => {
  it.each([
    ['whole pixels', 190, 360],
    ['fractions the parser rounds', 192.85714285714286, 160.5],
    ['negative halves and negative zero', -2.5, -0],
  ])('produces byte-identical JSON for %s', (_, x, y) => {
    const ui = createCommandBus(referenceComposition).dispatch(uiMove(x, y));
    const ai = executeSetNodePosition(createCommandBus(referenceComposition), toolArgs(x, y));
    expect(json(ai.document)).toBe(json(ui.document));
    expect(ai.inverse).toEqual(ui.inverse);
  });

  it('keeps the key order of a document that spells position as y before x', () => {
    // A tool that rebuilt a fresh `{ x, y }` would pass every test above.
    const ui = createCommandBus(yBeforeX()).dispatch(uiMove(190, 360));
    const ai = executeSetNodePosition(createCommandBus(yBeforeX()), toolArgs(190, 360));
    expect(json(ui.document)).toContain('"position":{"y":360,"x":190}');
    expect(json(ai.document)).toBe(json(ui.document));
  });

  it('is independent of the key order of the arguments', () => {
    const ui = createCommandBus(referenceComposition).dispatch(uiMove(190, 360));
    const ai = executeSetNodePosition(
      createCommandBus(referenceComposition),
      JSON.parse('{"position":{"y":360,"x":190},"nodeId":"node-title"}'),
    );
    expect(json(ai.document)).toBe(json(ui.document));
  });
});

describe('UI and AI share one history (D31.4)', () => {
  it('undoes an AI edit made after a UI edit, and then the UI edit', () => {
    const bus = createCommandBus(referenceComposition);
    const original = json(bus.getDocument());
    const afterUi = json(bus.dispatch(uiMove(120, 200)).document);
    const afterAi = json(executeSetNodePosition(bus, toolArgs(190, 360)).document);
    expect(json(bus.undo().document)).toBe(afterUi);
    expect(json(bus.undo().document)).toBe(original);
    expect(json(bus.redo().document)).toBe(afterUi);
    expect(json(bus.redo().document)).toBe(afterAi);
    expect(bus.canRedo()).toBe(false);
  });

  it('undoes directly after an AI edit to the original bytes, and redo repeats it', () => {
    for (const document of [referenceComposition, yBeforeX()]) {
      const bus = createCommandBus(document);
      const original = json(bus.getDocument());
      const edited = json(executeSetNodePosition(bus, toolArgs(190, 360)).document);
      expect(bus.canUndo()).toBe(true);
      expect(json(bus.undo().document)).toBe(original);
      expect(json(bus.redo().document)).toBe(edited);
    }
  });

  it('applies again after an undo: the tool remembers nothing between calls', () => {
    const bus = createCommandBus(referenceComposition);
    const first = json(executeSetNodePosition(bus, toolArgs(190, 360)).document);
    bus.undo();
    const again = executeSetNodePosition(bus, toolArgs(190, 360));
    expect(again.inverse).not.toBeNull();
    expect(json(again.document)).toBe(first);
  });

  it('edits the document of whichever bus it is given', () => {
    const plain = createCommandBus(referenceComposition);
    const swapped = createCommandBus(yBeforeX());
    const one = executeSetNodePosition(plain, toolArgs(190, 360));
    const two = executeSetNodePosition(swapped, toolArgs(190, 360));
    expect(one.document).toBe(plain.getDocument());
    expect(two.document).toBe(swapped.getDocument());
    expect(json(one.document)).not.toBe(json(two.document));
  });
});

describe('refused arguments (P4, D31.3, D31.6)', () => {
  /** A bus with a non-empty undo and redo stack, so a change to either would show. */
  function busWithHistory(): CommandBus {
    const bus = createCommandBus(referenceComposition);
    bus.dispatch(uiMove(100, 100));
    bus.dispatch(uiMove(120, 200));
    bus.undo();
    return bus;
  }

  it.each<[string, unknown, string]>([
    ['no object at all', null, 'invalid-argument'],
    ['an array', [TITLE, { x: 1, y: 2 }], 'invalid-argument'],
    ['a JSON string instead of its value', json(toolArgs(1, 2)), 'invalid-argument'],
    [
      'the discriminator of this very command',
      { type: 'SetNodePosition', ...(toolArgs(1, 2) as object) },
      'invalid-argument',
    ],
    ['another command type', { type: 'Other', ...(toolArgs(1, 2) as object) }, 'invalid-argument'],
    ['an extra field', { ...(toolArgs(1, 2) as object), extra: true }, 'invalid-argument'],
    [
      'an extra field in position',
      { nodeId: TITLE, position: { x: 1, y: 2, z: 3 } },
      'invalid-argument',
    ],
    ['a missing position', { nodeId: TITLE }, 'invalid-argument'],
    ['position null', { nodeId: TITLE, position: null }, 'invalid-argument'],
    ['a coordinate as text', { nodeId: TITLE, position: { x: '12', y: 2 } }, 'invalid-argument'],
    [
      'a coordinate as a boolean',
      { nodeId: TITLE, position: { x: true, y: 2 } },
      'invalid-argument',
    ],
    ['an empty node ID', toolArgs(1, 2, ''), 'invalid-argument'],
    ['NaN', toolArgs(Number.NaN, 2), 'invalid-argument'],
    // Accepted arguments that the bus refuses later keep the bus's own code.
    ['an unknown node', toolArgs(1, 2, 'node-missing'), 'unknown-node'],
    ['a node without a position', toolArgs(1, 2, 'node-background'), 'unsupported-node'],
    ['a position the document cannot hold', toolArgs(1e9, 2), 'invalid-result'],
  ])('refuses %s with its typed code, leaving the document and both stacks', (_, args, code) => {
    const bus = busWithHistory();
    const before = stateOf(bus);
    expect(before).toMatchObject({ undo: true, redo: true });
    // On the dispatch alone, so a tool that reached for another method after a
    // refusal, or wrapped dispatch, would throw a TypeError instead of the code.
    expect(codeOf(() => executeSetNodePosition(dispatchOnly(bus), args))).toBe(code);
    const after = stateOf(bus);
    expect(after.document).toBe(before.document);
    expect(after).toEqual(before);
  });

  it('passes the validation errors of a refused result on, not rewrapped', () => {
    const bus = createCommandBus(referenceComposition);
    try {
      executeSetNodePosition(bus, toolArgs(1e9, 2));
      throw new Error('The call did not throw.');
    } catch (reason) {
      expect(reason).toMatchObject({ name: 'EditorError', code: 'invalid-result' });
      expect((reason as { details: string[] }).details.join('\n')).toContain('position/x');
    }
  });
});

describe('no mutation (D30.7)', () => {
  it('reads deep-frozen arguments and leaves them and the input document as they were', () => {
    const args = deepFreeze(toolArgs(12.5, 360));
    const text = json(args);
    const bus = createCommandBus(referenceComposition);
    const input = bus.getDocument();
    const inputText = json(input);
    const result: CommandResult = executeSetNodePosition(bus, args);
    expect(json(args)).toBe(text);
    expect(json(input)).toBe(inputText);
    expect(result.document).not.toBe(input);
  });

  it('reads each argument once, so a getter cannot hand the parser two values', () => {
    let reads = 0;
    const args = {
      nodeId: TITLE,
      get position() {
        reads += 1;
        return { x: 190 + reads, y: 360 };
      },
    };
    const bus = createCommandBus(referenceComposition);
    const result = executeSetNodePosition(bus, args);
    expect(reads).toBe(1);
    expect(result.inverse).toEqual(uiMove(START.x, START.y));
    expect(json(bus.getDocument())).toContain('"position":{"x":191,"y":360}');
  });
});
