/**
 * Specification §6.1 at the level of the DOM renderer (D22.4): the DOM under a
 * root depends on the mounted document and the last state only — not on
 * earlier states, not on their order, not on another root — and the renderer
 * writes neither the document nor the state.
 */
import { evaluateComposition, type CompositionState } from '@kadrion/runtime';
import { referenceExpectedRender, type ExpectedElement } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { mountComposition, renderState } from '../src/index.js';
import {
  createRoot,
  createWindow,
  deepFreeze,
  derived,
  describeRoot,
  draftNode,
  elementOf,
  elementsOf,
  everyObject,
  reference,
  referenceUrls,
  shuffled,
} from './support.js';

const SEED = 20_260_922;
const goldenTimes = referenceExpectedRender.golden.map((golden) => golden.timeUs);
const expectedTrees = new Map(
  referenceExpectedRender.golden.map((golden) => [golden.timeUs, [golden.tree]]),
);

function mountedReference(root: HTMLElement = createRoot()): HTMLElement {
  mountComposition(root, reference, referenceUrls);
  return root;
}

const expectedAt = (timeUs: number): ExpectedElement[] | undefined => expectedTrees.get(timeUs);

describe('one mounted tree, many instants', () => {
  const orders = {
    ascending: [...goldenTimes],
    descending: [...goldenTimes].reverse(),
    shuffled: shuffled(goldenTimes, SEED),
  };

  it('uses three orders that really differ', () => {
    expect(orders.shuffled).not.toEqual(orders.ascending);
    expect(orders.shuffled).not.toEqual(orders.descending);
    expect([...orders.shuffled].sort((a, b) => a - b)).toEqual(orders.ascending);
  });

  it.each(Object.entries(orders))(
    'yields the hand-derived tree after every render in %s order, in the same elements',
    (_, order) => {
      const root = mountedReference();
      const elements = elementsOf(root);
      // stage, scene, background, group, image, caption, title, Custom HTML, its frame
      expect(elements).toHaveLength(9);
      for (const timeUs of order) {
        renderState(root, evaluateComposition(reference, timeUs));
        expect(describeRoot(root), String(timeUs)).toStrictEqual(expectedAt(timeUs));
        const now = elementsOf(root);
        expect(now).toHaveLength(elements.length);
        now.forEach((element, index) => {
          expect(element).toBe(elements[index]);
        });
      }
    },
  );

  it('yields the same tree when the same state is rendered again and again', () => {
    const root = mountedReference();
    const state = evaluateComposition(reference, 9_900_000);
    for (let run = 0; run < 3; run += 1) {
      renderState(root, state);
      expect(describeRoot(root)).toStrictEqual(expectedAt(9_900_000));
    }
  });

  // A renderer that skips values it believes to be unchanged would keep the damage.
  it('restores styles that something else changed in between', () => {
    const root = mountedReference();
    const state = evaluateComposition(reference, 5_000_000);
    renderState(root, state);
    for (const id of ['node-group', 'node-image', 'node-title', 'node-custom-html']) {
      const element = elementOf(root, id);
      element.style.setProperty('transform', 'none');
      element.style.setProperty('opacity', '0.5');
    }
    elementOf(root, 'node-caption').style.removeProperty('transform');
    elementOf(root, 'node-caption').style.removeProperty('opacity');
    renderState(root, state);
    expect(describeRoot(root)).toStrictEqual(expectedAt(5_000_000));
  });

  it('keeps two roots apart when their renders interleave', () => {
    const window = createWindow();
    const first = mountedReference(createRoot(window));
    const second = mountedReference(createRoot(window));
    const elsewhere = mountedReference();
    const plan: [HTMLElement, number][] = [
      [first, 0],
      [second, 9_900_000],
      [elsewhere, 5_000_000],
      [first, 7_500_000],
      [second, 2_500_000],
      [first, 2_500_000],
    ];
    const last = new Map<HTMLElement, number>();
    for (const [root, timeUs] of plan) {
      renderState(root, evaluateComposition(reference, timeUs));
      last.set(root, timeUs);
      for (const [other, otherTime] of last) {
        expect(describeRoot(other)).toStrictEqual(expectedAt(otherTime));
      }
    }
  });

  // D22.4: mount writes the document, never an evaluated value.
  it('writes no transform and no opacity before the first render', () => {
    const root = mountedReference();
    const text = root.innerHTML;
    expect(text).not.toContain('opacity');
    expect(text).not.toMatch(/transform:|translate|scale\(/);
    renderState(root, evaluateComposition(reference, 0));
    expect(root.innerHTML).toContain('transform: translate(');
  });

  it('builds a fresh tree on every mount and removes what the root held before', () => {
    const root = createRoot();
    root.append(root.ownerDocument.createElement('span'), 'text');
    mountComposition(root, reference, referenceUrls);
    const first = elementsOf(root);
    mountComposition(root, reference, referenceUrls);
    const second = elementsOf(root);
    expect(root.childNodes).toHaveLength(1);
    expect(second.filter((element) => first.includes(element))).toEqual([]);
    renderState(root, evaluateComposition(reference, 0));
    expect(describeRoot(root)).toStrictEqual(expectedAt(0));
  });
});

describe('the document and the state are read, never written', () => {
  it('renders a deeply frozen document and state, where a write would throw', () => {
    expect(everyObject(reference).every((object) => Object.isFrozen(object))).toBe(true);
    const before = JSON.stringify(reference);
    const root = mountedReference();
    for (const timeUs of goldenTimes) {
      const state = deepFreeze(evaluateComposition(reference, timeUs));
      const text = JSON.stringify(state);
      renderState(root, state);
      expect(JSON.stringify(state)).toBe(text);
    }
    expect(JSON.stringify(reference)).toBe(before);
  });
});

describe('a state that does not fit the mounted tree (D22.4)', () => {
  it('is rejected when nothing was mounted', () => {
    const root = createRoot();
    root.append(root.ownerDocument.createElement('div'));
    const attempt = (): void => {
      renderState(root, evaluateComposition(reference, 0));
    };
    expect(attempt).toThrow(expect.objectContaining({ name: 'RenderError', code: 'not-mounted' }));
    expect(() => {
      renderState(createRoot(), evaluateComposition(reference, 0));
    }).toThrow(expect.objectContaining({ code: 'not-mounted' }));
  });

  const mismatches: [string, CompositionState][] = [
    [
      'the last top-level node',
      evaluateComposition(
        derived((draft) => {
          draftNode(draft, 'node-custom-html').id = 'node-other';
        }),
        2_500_000,
      ),
    ],
    [
      'the last child of the group',
      evaluateComposition(
        derived((draft) => {
          draftNode(draft, 'node-caption').id = 'node-other';
        }),
        2_500_000,
      ),
    ],
    [
      'the order of two nodes',
      evaluateComposition(
        derived((draft) => {
          const nodes = draft.scenes[0]?.nodes ?? [];
          nodes.push(...nodes.splice(2, 1));
        }),
        2_500_000,
      ),
    ],
    [
      'a missing node',
      evaluateComposition(
        derived((draft) => {
          draft.scenes[0]?.nodes.pop();
        }),
        2_500_000,
      ),
    ],
  ];

  // A renderer that writes node by node and throws on the last one would leave
  // the DOM showing two instants at once.
  it.each(mismatches)('writes nothing when %s differs', (_, state) => {
    const root = mountedReference();
    renderState(root, evaluateComposition(reference, 0));
    expect(() => {
      renderState(root, state);
    }).toThrow(expect.objectContaining({ name: 'RenderError', code: 'state-mismatch' }));
    expect(describeRoot(root)).toStrictEqual(expectedAt(0));
  });

  // In the reference order the group comes before every leaf, so a mismatch inside
  // it is found before any leaf is planned. With the group last, every other node
  // is planned first: only a check of the whole structure before the first write
  // keeps them unchanged.
  it('writes nothing when a child of a group that comes after the leaves differs', () => {
    const groupLast = (draft: Parameters<Parameters<typeof derived>[0]>[0]): void => {
      const nodes = draft.scenes[0]?.nodes ?? [];
      nodes.push(...nodes.splice(1, 1));
    };
    const mounted = derived(groupLast);
    expect(mounted.scenes[0]?.nodes.at(-1)?.id).toBe('node-group');
    const root = createRoot();
    mountComposition(root, mounted, referenceUrls);
    renderState(root, evaluateComposition(mounted, 0));
    const before = describeRoot(root);
    const renamed = derived((draft) => {
      groupLast(draft);
      draftNode(draft, 'node-caption').id = 'node-other';
    });
    expect(() => {
      renderState(root, evaluateComposition(renamed, 2_500_000));
    }).toThrow(expect.objectContaining({ name: 'RenderError', code: 'state-mismatch' }));
    expect(describeRoot(root)).toStrictEqual(before);
  });

  // D22.4: `render` checks IDs, order, and hierarchy only. A document whose static
  // properties changed has to be mounted again; this test documents the contract.
  it('keeps the static properties of the mounted document until the next mount', () => {
    const edited = derived((draft) => {
      const title = draftNode(draft, 'node-title');
      if (title.type !== 'text') throw new Error('node-title is a text node.');
      title.text = 'Edited';
    });
    const root = mountedReference();
    renderState(root, evaluateComposition(edited, 0));
    expect(elementOf(root, 'node-title').textContent).toBe('Kadrion');
    mountComposition(root, edited, referenceUrls);
    renderState(root, evaluateComposition(edited, 0));
    expect(elementOf(root, 'node-title').textContent).toBe('Edited');
  });
});
