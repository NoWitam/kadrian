/** Shared helpers of the runtime tests. Nothing here is part of the package. */
import { validateComposition, type Composition, type ValidatedComposition } from '@kadrion/schema';
import { referenceComposition } from '@kadrion/test-fixtures';

import type { CompositionState, GroupNodeState, LeafNodeState } from '../src/index.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

/** An editable copy of a document. It has to pass `validated` before it can be evaluated. */
export type Draft = DeepMutable<Composition>;
export type DraftNode = Exclude<Draft['scenes'][number]['nodes'][number], { type: 'background' }>;
export type DraftAnimation = DraftNode['animations'][number];

type KeyframeValue<Property extends DraftAnimation['property']> = Extract<
  DraftAnimation,
  { property: Property }
>['keyframes'][number]['value'];

/** A linear animation from `[timeUs, value]` pairs. */
export function animation<Property extends DraftAnimation['property']>(
  id: string,
  property: Property,
  ...keyframes: [timeUs: number, value: KeyframeValue<Property>][]
): DraftAnimation {
  return {
    id,
    property,
    interpolation: 'linear',
    keyframes: keyframes.map(([timeUs, value]) => ({ timeUs, value })),
  } as DraftAnimation;
}

/** The runtime accepts validated documents only, so every test document goes through here. */
export function validated(input: unknown): ValidatedComposition {
  const result = validateComposition(input);
  if (!result.ok) {
    throw new Error(`The test document is invalid: ${JSON.stringify(result.errors, null, 2)}`);
  }
  return result.composition;
}

/** The shared reference composition. It is deeply frozen, so writing to it throws. */
export const reference = validated(referenceComposition);

export function referenceDraft(): Draft {
  return structuredClone(referenceComposition) as Draft;
}

/** A variant of the reference composition: clone, edit, validate. */
export function derived(edit: (draft: Draft) => void): ValidatedComposition {
  const draft = referenceDraft();
  edit(draft);
  return validated(draft);
}

export function draftNode(draft: Draft, id: string): DraftNode {
  for (const scene of draft.scenes) {
    for (const node of scene.nodes) {
      if (node.type === 'background') continue;
      if (node.id === id) return node;
      const child =
        node.type === 'group' ? node.children.find((item) => item.id === id) : undefined;
      if (child !== undefined) return child;
    }
  }
  throw new Error(`The draft has no transformed node "${id}".`);
}

export function stateNode(state: CompositionState, id: string): GroupNodeState | LeafNodeState {
  for (const scene of state.scenes) {
    for (const node of scene.nodes) {
      if (node.type === 'background') continue;
      if (node.id === id) return node;
      const child =
        node.type === 'group' ? node.children.find((item) => item.id === id) : undefined;
      if (child !== undefined) return child;
    }
  }
  throw new Error(`The state has no transformed node "${id}".`);
}

/** Small seeded generator (mulberry32), so that "random" orders are the same in every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffled<Item>(items: readonly Item[], seed: number): Item[] {
  const random = seededRandom(seed);
  return items
    .map((item) => ({ item, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}
