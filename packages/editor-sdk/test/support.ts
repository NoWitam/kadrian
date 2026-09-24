/**
 * Helpers of the editor-sdk tests. The fixture document is deep-frozen by
 * `@kadrion/test-fixtures`, so an in-place mutation of the input throws in the
 * strict mode of a module instead of passing unnoticed (D30.7).
 */
import { validateComposition, type ValidatedComposition } from '@kadrion/schema';
import { referenceComposition } from '@kadrion/test-fixtures';

import { EditorError } from '../src/index.js';

/** Any document, validated, or a failure that names the first error. */
export function validated(document: unknown): ValidatedComposition {
  const result = validateComposition(document);
  if (!result.ok)
    throw new Error(`The document does not validate: ${result.errors[0]?.message ?? ''}`);
  return result.composition;
}

/** The reference composition, validated. */
export function reference(): ValidatedComposition {
  return validated(referenceComposition);
}

/** The exact JSON text of a document: the comparison P3 and P4 speak of. */
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

/** The `EditorError` a call throws. */
export function errorOf(run: () => unknown): EditorError {
  try {
    run();
  } catch (reason) {
    if (reason instanceof EditorError) return reason;
    throw reason;
  }
  throw new Error('The call did not throw.');
}

export interface Probe {
  readonly id: string;
  readonly type: string;
  readonly position?: { readonly x: number; readonly y: number };
  readonly animations?: unknown;
  readonly children?: readonly Probe[];
}

/** A node of a document, read back for an assertion. */
export function nodeOf(document: unknown, nodeId: string): Probe {
  const scenes = (document as { scenes: { nodes: Probe[] }[] }).scenes;
  for (const scene of scenes) {
    for (const node of scene.nodes) {
      if (node.id === nodeId) return node;
      for (const child of node.children ?? []) if (child.id === nodeId) return child;
    }
  }
  throw new Error(`The document has no node ${nodeId}.`);
}

/** The position of a node, as a plain pair. */
export function positionOf(document: unknown, nodeId: string): { x: number; y: number } {
  const { position } = nodeOf(document, nodeId);
  if (position === undefined) throw new Error(`The node ${nodeId} has no position.`);
  return { x: position.x, y: position.y };
}
