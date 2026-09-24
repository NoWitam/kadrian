/**
 * The command bus and its history (D30.9). The history is host memory: it is
 * not part of the composition, not part of the schema, never reaches
 * `@kadrion/runtime` or the Producer, and may be empty after a reload. Taskio
 * stores document versions (D02), which is a different thing from an
 * operational undo stack.
 */
import { validateComposition, type ValidatedComposition } from '@kadrion/schema';

import { applyCommand, type CommandResult } from './apply.js';
import { parseCommand, type Command } from './commands.js';
import { EditorError } from './errors.js';

export interface CommandBus {
  /** The current document; every render starts from this one. */
  getDocument(): ValidatedComposition;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * Parses, applies, and records one command. The argument is `unknown` on
   * purpose: the AI tool contract of D31 hands its arguments to this same
   * method and cannot acquire a second path into the document (D30.9).
   */
  dispatch(command: unknown): CommandResult;
  undo(): CommandResult;
  redo(): CommandResult;
}

/**
 * A bus over one document. Throws `invalid-document` when the document is not a
 * composition, so a bus never exists around an invalid one.
 */
export function createCommandBus(document: unknown): CommandBus {
  const initial = validateComposition(document);
  if (!initial.ok) {
    throw new EditorError(
      'invalid-document',
      'The command bus needs a valid composition to start from.',
      initial.errors.map(({ path, message }) => `${path}: ${message}`),
    );
  }
  let current = initial.composition;
  const undoable: Command[] = [];
  const redoable: Command[] = [];

  /**
   * Parses and applies one command. Every failure throws before a stack is
   * read or written, which is what keeps rule 6 of D30.9 true: a failed command
   * changes neither stack and leaves the current document where it was.
   */
  function apply(command: unknown): CommandResult {
    return applyCommand(current, parseCommand(command));
  }

  /** Spends the top entry of `from` and records its inverse on `to`. */
  function step(from: Command[], to: Command[], empty: 'nothing-to-undo' | 'nothing-to-redo') {
    const inverse = from[from.length - 1];
    if (inverse === undefined) {
      throw new EditorError(
        empty,
        empty === 'nothing-to-undo' ? 'Nothing to undo.' : 'Nothing to redo.',
      );
    }
    const result = apply(inverse);
    from.pop();
    current = result.document;
    if (result.inverse !== null) to.push(result.inverse);
    return result;
  }

  // A frozen facade (D30.13): no caller can replace, add, or delete a method of
  // the bus it shares with others. The closure above stays mutable on purpose.
  return Object.freeze<CommandBus>({
    getDocument: () => current,
    canUndo: () => undoable.length > 0,
    canRedo: () => redoable.length > 0,
    dispatch(command) {
      const result = apply(command);
      if (result.inverse !== null) {
        current = result.document;
        undoable.push(result.inverse);
        // A new command invalidates the redo branch; a no-op changed nothing.
        redoable.length = 0;
      }
      return result;
    },
    undo: () => step(undoable, redoable, 'nothing-to-undo'),
    redo: () => step(redoable, undoable, 'nothing-to-redo'),
  });
}
