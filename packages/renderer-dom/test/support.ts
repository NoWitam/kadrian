/** Shared helpers of the renderer tests. Nothing here is part of the package. */
import { validateComposition, type Composition, type ValidatedComposition } from '@kadrion/schema';
import {
  referenceComposition,
  referenceExpectedRender,
  type ExpectedElement,
  type ExpectedText,
} from '@kadrion/test-fixtures';
import { JSDOM, type DOMWindow } from 'jsdom';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

/** An editable copy of a document. It has to pass `validated` before it can be rendered. */
export type Draft = DeepMutable<Composition>;
export type DraftNode = Draft['scenes'][number]['nodes'][number];

/** The renderer accepts validated documents only, so every test document goes through here. */
export function validated(input: unknown): ValidatedComposition {
  const result = validateComposition(input);
  if (!result.ok) {
    throw new Error(`The test document is invalid: ${JSON.stringify(result.errors, null, 2)}`);
  }
  return result.composition;
}

/** The shared reference composition. It is deeply frozen, so writing to it throws. */
export const reference = validated(referenceComposition);

/** The URLs the expected trees assume. */
export const referenceUrls = referenceExpectedRender.assetUrls;

/** A variant of the reference composition: clone, edit, validate. */
export function derived(edit: (draft: Draft) => void): ValidatedComposition {
  const draft = structuredClone(referenceComposition) as Draft;
  edit(draft);
  return validated(draft);
}

/** Finds a node of a draft by ID, at the top level or inside a group. */
export function draftNode(draft: Draft, id: string): DraftNode {
  for (const scene of draft.scenes) {
    for (const node of scene.nodes) {
      if (node.id === id) return node;
      const child =
        node.type === 'group' ? node.children.find((item) => item.id === id) : undefined;
      if (child !== undefined) return child;
    }
  }
  throw new Error(`The draft has no node "${id}".`);
}

/** A node of a draft that has a transform, that is, anything but the background. */
export function transformedNode(
  draft: Draft,
  id: string,
): Exclude<DraftNode, { type: 'background' }> {
  const node = draftNode(draft, id);
  if (node.type === 'background') throw new Error(`"${id}" has no transform.`);
  return node;
}

/** A fresh DOM window with its own realm, as a page of the Player or the Producer has. */
export function createWindow(
  runScripts: 'outside-only' | 'dangerously' = 'outside-only',
): DOMWindow {
  return new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    // A real origin: with the default about:blank, jsdom throws when a failing
    // assertion prints the window.
    url: 'https://kadrion.invalid/',
    runScripts,
    pretendToBeVisual: true,
  }).window;
}

/** A root element in a fresh window. */
export function createRoot(window: DOMWindow = createWindow()): HTMLElement {
  const root = window.document.createElement('div');
  window.document.body.append(root);
  return root;
}

/**
 * The DOM below `node` in the shape of the expected trees: tag, every attribute
 * except `style`, every inline style declaration read back through the CSS
 * Object Model, and every child node. Any other kind of node fails the test.
 */
export function describeNode(node: Node): ExpectedElement | ExpectedText {
  const window = node.ownerDocument?.defaultView;
  if (window === null || window === undefined) throw new Error('The node has no window.');
  if (node.nodeType === window.Node.TEXT_NODE) return { text: node.textContent ?? '' };
  if (!(node instanceof window.HTMLElement)) {
    throw new Error(`Unexpected node ${node.nodeName} in the rendered tree.`);
  }
  const attributes = Object.fromEntries(
    [...node.attributes]
      .filter((attribute) => attribute.name !== 'style')
      .map((attribute) => [attribute.name, attribute.value]),
  );
  const style = Object.fromEntries(
    Array.from({ length: node.style.length }, (_, index) => {
      const name = node.style.item(index);
      return [name, node.style.getPropertyValue(name)];
    }),
  );
  return {
    tag: node.localName,
    attributes,
    style,
    children: [...node.childNodes].map((child) => describeNode(child)),
  };
}

/** The tree that the renderer placed in `root`. */
export function describeRoot(root: Element): (ExpectedElement | ExpectedText)[] {
  return [...root.childNodes].map((child) => describeNode(child));
}

/** The element that the renderer made for a node. */
export function elementOf(root: Element, id: string): HTMLElement {
  const element = root.querySelector(`[data-kadrion-node="${id}"]`);
  const window = root.ownerDocument.defaultView;
  if (window === null || !(element instanceof window.HTMLElement)) {
    throw new Error(`The rendered tree has no element for "${id}".`);
  }
  return element;
}

/** Every element below `root`, in document order, `root` excluded. */
export function elementsOf(root: Element): Element[] {
  return [...root.querySelectorAll('*')];
}

/** Every object and array reachable from a value, the value itself included. */
export function everyObject(value: unknown): object[] {
  if (typeof value !== 'object' || value === null) return [];
  return [value, ...Object.values(value).flatMap((child) => everyObject(child))];
}

export function deepFreeze<T>(value: T): T {
  for (const object of everyObject(value)) Object.freeze(object);
  return value;
}

/** Small seeded generator (mulberry32), so that "random" orders are the same in every run. */
export function shuffled<Item>(items: readonly Item[], seed: number): Item[] {
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  return items
    .map((item) => ({ item, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}
