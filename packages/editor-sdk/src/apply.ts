/**
 * Applying one command to one document (D30.4). The function is pure with
 * respect to the document (§9): it never mutates its input, and the same
 * document and command always give the same result.
 */
import { validateComposition, type ValidatedComposition } from '@kadrion/schema';

import { parseCommand, type Command } from './commands.js';
import { findNode, isObject, replaceNode, type DocumentObject } from './document.js';
import { EditorError } from './errors.js';

export interface CommandResult {
  /** The edited document, accepted by the full `validateComposition` (D30.6). */
  readonly document: ValidatedComposition;
  /** The command that undoes this one, or `null` when nothing changed (D30.5, D30.9). */
  readonly inverse: Command | null;
}

/** One coordinate of a node of a validated document, which the schema guarantees is an integer. */
function coordinate(position: DocumentObject, axis: 'x' | 'y', nodeId: string): number {
  const value: unknown = position[axis];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EditorError(
      'unsupported-node',
      `The node \`${nodeId}\` has no numeric position.${axis}.`,
    );
  }
  return value;
}

/**
 * Applies a command in the order D30.4 fixes: parse, find, read the previous
 * value from the input document, rebuild immutably, validate the result in
 * full, and only then return. Any failure throws an `EditorError` and leaves
 * the input document exactly as it was.
 *
 * The argument is typed, but it is parsed all the same: the type is structural,
 * so a caller can write a literal, and parsing at every entry point is what
 * guarantees that the UI and the AI tool of D31 normalise their coordinates
 * identically (D30.3).
 */
export function applyCommand(document: ValidatedComposition, command: Command): CommandResult {
  const parsed = parseCommand(command);
  const node = findNode(document, parsed.nodeId);
  if (node === null) {
    throw new EditorError('unknown-node', `The document has no node \`${parsed.nodeId}\`.`);
  }
  const position = node['position'];
  if (!isObject(position)) {
    throw new EditorError(
      'unsupported-node',
      `The node \`${parsed.nodeId}\` has no position; it cannot be moved.`,
    );
  }
  const previous = {
    x: coordinate(position, 'x', parsed.nodeId),
    y: coordinate(position, 'y', parsed.nodeId),
  };
  // A command that changes no value leaves the document and writes no history (D30.9).
  if (previous.x === parsed.position.x && previous.y === parsed.position.y) {
    return { document, inverse: null };
  }
  const inverse = parseCommand({
    type: parsed.type,
    nodeId: parsed.nodeId,
    position: previous,
  });
  // Spreading the originals keeps every existing field in its place (D30.7).
  const edited = replaceNode(document, parsed.nodeId, {
    ...node,
    position: { ...position, x: parsed.position.x, y: parsed.position.y },
  });
  const result = validateComposition(edited);
  if (!result.ok) {
    throw new EditorError(
      'invalid-result',
      `The command \`${parsed.type}\` would produce a document the schema rejects.`,
      result.errors.map(({ path, message }) => `${path}: ${message}`),
    );
  }
  return { document: result.composition, inverse };
}
