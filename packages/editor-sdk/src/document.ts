/**
 * Finding a node in a composition and rebuilding the document around a new
 * version of it (D30.7). The document is treated as the JSON value it is: the
 * intermediate result of an edit is not a `Composition` and is not claimed to
 * be one — `applyCommand` hands it to `validateComposition`, which derives the
 * type again (D30.6).
 *
 * Only the path from the root to the edited node is rebuilt; every untouched
 * subtree, and every array that does not contain the node, stays the same
 * object. Objects are rebuilt by spreading the original, so a field that
 * already exists keeps its place and the key order of the input survives.
 */

/** A JSON object of the document, as this module reads it. */
export type DocumentObject = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is DocumentObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Any object read as a bag of unknown fields. Every document object is one;
 * `Composition` is a branded type that carries no index signature, so the view
 * is stated here once instead of at each use.
 */
export function fieldsOf(value: object): DocumentObject {
  return value as DocumentObject;
}

/** An array of unknown items, or `null`. `Array.isArray` alone widens to `any[]`. */
function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

function objectsIn(value: unknown): readonly DocumentObject[] {
  return (asArray(value) ?? []).filter(isObject);
}

/** The node with that ID, searched scene by scene and into every group (D16). */
export function findNode(document: object, nodeId: string): DocumentObject | null {
  for (const scene of objectsIn(fieldsOf(document)['scenes'])) {
    for (const node of objectsIn(scene['nodes'])) {
      if (node['id'] === nodeId) return node;
      for (const child of objectsIn(node['children'])) {
        if (child['id'] === nodeId) return child;
      }
    }
  }
  return null;
}

/** The list with `replacement` in the place of the node with that ID, or `null` when absent. */
function replaceInList(
  nodes: readonly unknown[] | null,
  nodeId: string,
  replacement: DocumentObject,
): readonly unknown[] | null {
  if (nodes === null) return null;
  const at = nodes.findIndex((node) => isObject(node) && node['id'] === nodeId);
  if (at < 0) return null;
  // Every other element stays the same object; only this one is exchanged.
  return nodes.map((node, index) => (index === at ? replacement : node));
}

/** Whether a rebuilt list holds a different object anywhere; identity decides, not equality. */
function differs(rebuilt: readonly unknown[], original: readonly unknown[]): boolean {
  return rebuilt.some((item, at) => item !== original[at]);
}

/**
 * The document with `replacement` in the place of the node with that ID, or
 * the document itself when it has no such node.
 */
export function replaceNode(
  document: object,
  nodeId: string,
  replacement: DocumentObject,
): DocumentObject {
  const root = fieldsOf(document);
  const scenes = asArray(root['scenes']);
  if (scenes === null) return root;
  const edited = scenes.map((scene) => {
    if (!isObject(scene)) return scene;
    const nodes = asArray(scene['nodes']);
    if (nodes === null) return scene;
    const top = replaceInList(nodes, nodeId, replacement);
    if (top !== null) return { ...scene, nodes: top };
    const withChildren = nodes.map((node) => {
      if (!isObject(node)) return node;
      const children = replaceInList(asArray(node['children']), nodeId, replacement);
      return children === null ? node : { ...node, children };
    });
    return differs(withChildren, nodes) ? { ...scene, nodes: withChildren } : scene;
  });
  return differs(edited, scenes) ? { ...root, scenes: edited } : root;
}
