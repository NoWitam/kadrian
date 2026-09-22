/**
 * The runtime against the hand-derived expected state of the reference
 * composition. The fixture was written before the runtime and is never
 * regenerated from it; `toStrictEqual` compares numbers with `Object.is`, so the
 * comparison is bit for bit.
 */
import { goldenTimestamps, referenceExpectedStates } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { evaluateComposition } from '../src/index.js';
import { reference } from './support.js';

/** What document nodes and node states have in common. */
interface Outlined {
  readonly id: string;
  readonly type: string;
  readonly children?: readonly Outlined[];
}

type Outline = [id: string, type: string, children: Outline[]];

const outline = (nodes: readonly Outlined[]): Outline[] =>
  nodes.map((node) => [node.id, node.type, outline(node.children ?? [])]);

describe('reference composition at the golden timestamps', () => {
  it('has a hand-derived expectation for every golden timestamp', () => {
    expect(referenceExpectedStates.golden.map((golden) => golden.timeUs)).toEqual(
      goldenTimestamps.map((golden) => golden.timeUs),
    );
  });

  it.each(referenceExpectedStates.golden)(
    'evaluates to the hand-derived state at $timeUs',
    ({ timeUs, state }) => {
      expect(evaluateComposition(reference, timeUs)).toStrictEqual(state);
    },
  );
});

describe('shape of the state', () => {
  it.each(goldenTimestamps)(
    'mirrors the order and the hierarchy of the document at $timeUs',
    ({ timeUs }) => {
      const state = evaluateComposition(reference, timeUs);
      expect(state.timeUs).toBe(timeUs);
      expect(state.scenes.map((scene) => [scene.id, outline(scene.nodes)])).toEqual(
        reference.scenes.map((scene) => [scene.id, outline(scene.nodes)]),
      );
    },
  );
});
