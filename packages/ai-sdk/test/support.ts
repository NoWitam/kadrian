/**
 * Helpers of the ai-sdk tests. The fixture document is deep-frozen by
 * `@kadrion/test-fixtures`, so an in-place mutation of it throws instead of
 * passing unnoticed.
 */
import { EditorError, type Command, type CommandBus } from '@kadrion/editor-sdk';
import { referenceComposition } from '@kadrion/test-fixtures';

export const TITLE = 'node-title';
export const START = { x: 90, y: 160 };

/** The command a drag of the title on the canvas dispatches (P3, D30.10). */
export function uiMove(x: number, y: number, nodeId = TITLE): Command {
  return { type: 'SetNodePosition', nodeId, position: { x, y } };
}

/** The same edit as the arguments of a `set_node_position` call (D31.2). */
export function toolArgs(x: number, y: number, nodeId = TITLE): unknown {
  return { nodeId, position: { x, y } };
}

/** The exact JSON text of a document: the comparison P4 speaks of. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** The code of the `EditorError` a call throws, or what it did instead. */
export function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (reason) {
    if (reason instanceof EditorError) return reason.code;
    return `threw ${reason instanceof Error ? reason.name : typeof reason}`;
  }
  return 'did not throw';
}

/** A copy of the reference composition whose title spells its position `y` before `x`. */
export function yBeforeX(): unknown {
  const draft = structuredClone(referenceComposition) as {
    scenes: { nodes: { id: string; position?: unknown }[] }[];
  };
  const title = draft.scenes[0]?.nodes.find((node) => node.id === TITLE);
  if (title === undefined) throw new Error('The fixture has no title node.');
  title.position = { y: START.y, x: START.x };
  return draft;
}

/** The observable state of a bus: its document and both stacks. */
export function stateOf(bus: CommandBus): { document: unknown; undo: boolean; redo: boolean } {
  return { document: bus.getDocument(), undo: bus.canUndo(), redo: bus.canRedo() };
}

/** Freezes a value and everything in it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}
