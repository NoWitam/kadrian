/**
 * The hand-derived expected state (`reference.expected-state.json`) must stay in
 * step with the reference composition it describes. These checks read both
 * files as data and involve no runtime, so the fixture is guarded on its own.
 */
import { describe, expect, it } from 'vitest';

import { agentsText, readJson } from './repo.js';

interface Vec2 {
  x: number;
  y: number;
}

interface DocumentNode {
  id: string;
  type: string;
  position?: Vec2;
  scale?: Vec2;
  opacity?: number;
  animations?: { property: 'position' | 'scale' | 'opacity' }[];
  children?: DocumentNode[];
}

interface StateNode {
  id: string;
  type: string;
  position?: Vec2;
  scale?: Vec2;
  opacity?: number;
  children?: StateNode[];
}

interface ExpectedStates {
  rule: string[];
  golden: {
    timeUs: number;
    derivation: string[];
    state: { timeUs: number; scenes: { id: string; nodes: StateNode[] }[] };
  }[];
}

const COMPOSITIONS = ['packages', 'test-fixtures', 'src', 'compositions'] as const;
const reference = readJson(...COMPOSITIONS, 'reference.json') as {
  scenes: { id: string; nodes: DocumentNode[] }[];
};
const expected = readJson(...COMPOSITIONS, 'reference.expected-state.json') as ExpectedStates;

const PROPERTIES = ['position', 'scale', 'opacity'] as const;

/** Golden timestamps exactly as `AGENTS.md` lists them. */
const goldenTimes = [
  ...(/Golden timestamps: (.*?) microseconds/.exec(agentsText)?.[1] ?? '').matchAll(/`([\d_]+)`/g),
].map((match) => Number((match[1] ?? '').replaceAll('_', '')));

type Outline = [id: string, type: string, children: Outline[]];
const outline = (nodes: readonly (DocumentNode | StateNode)[]): Outline[] =>
  nodes.map((node) => [node.id, node.type, outline(node.children ?? [])]);

const flatten = <N extends { children?: N[] }>(nodes: readonly N[]): N[] =>
  nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);

const documentNodes = new Map(
  flatten(reference.scenes.flatMap((scene) => scene.nodes)).map((node) => [node.id, node]),
);
const animatedNodeIds = [...documentNodes.values()]
  .filter((node) => (node.animations ?? []).length > 0)
  .map((node) => node.id);

describe('expected state of the reference composition', () => {
  it('covers exactly the golden timestamps of AGENTS.md, in order', () => {
    expect(goldenTimes).toHaveLength(5);
    expect(expected.golden.map((golden) => golden.timeUs)).toEqual(goldenTimes);
  });

  it('states its rule', () => {
    expect(expected.rule.join(' ')).toContain('a + ((b - a) * (t - t0)) / (t1 - t0)');
  });

  // Specification §3.2: these are the cases the golden timestamps were placed for.
  it.each([
    'lies before the first keyframe',
    'lies after the last keyframe',
    'is the first keyframe',
    'is the last keyframe',
  ])('derives a value for a time that %s', (phrase) => {
    const derivations = expected.golden.flatMap((golden) => golden.derivation);
    expect(derivations.some((line) => line.includes(phrase))).toBe(true);
  });
});

describe.each(expected.golden)('expected state at $timeUs', ({ timeUs, derivation, state }) => {
  const stateNodes = flatten(state.scenes.flatMap((scene) => scene.nodes));

  it('carries its own time', () => {
    expect(state.timeUs).toBe(timeUs);
  });

  it('mirrors the order and the hierarchy of the document', () => {
    expect(state.scenes.map((scene) => scene.id)).toEqual(
      reference.scenes.map((scene) => scene.id),
    );
    expect(state.scenes.map((scene) => outline(scene.nodes))).toEqual(
      reference.scenes.map((scene) => outline(scene.nodes)),
    );
  });

  it('holds evaluated values only, never static properties of the document', () => {
    for (const node of stateNodes) {
      const transform = node.type === 'background' ? [] : PROPERTIES;
      const children = node.type === 'group' ? ['children'] : [];
      expect(Object.keys(node).sort()).toEqual(['id', 'type', ...transform, ...children].sort());
    }
  });

  it('keeps the base value of every property that has no animation', () => {
    for (const node of stateNodes) {
      const source = documentNodes.get(node.id);
      const animated = (source?.animations ?? []).map((animation) => animation.property);
      for (const property of PROPERTIES.filter((name) => !animated.includes(name))) {
        expect(node[property], `${node.id}.${property}`).toEqual(source?.[property]);
      }
    }
  });

  it('derives the value of every animated node', () => {
    expect(animatedNodeIds).toEqual(['node-group', 'node-image', 'node-title']);
    for (const id of animatedNodeIds) {
      expect(derivation.some((line) => line.startsWith(`${id} `))).toBe(true);
    }
  });
});
