/**
 * The renderer against the hand-derived DOM tree of the reference composition
 * (D22), and every evaluated value of the frame grid against the number rule.
 * The fixture was written before the renderer and is never regenerated from it.
 */
import { evaluateComposition, type NodeState } from '@kadrion/runtime';
import { frameCount, frameToTimeUs } from '@kadrion/schema';
import {
  goldenTimestamps,
  referenceExpectedRender,
  type ExpectedElement,
} from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { mountComposition, renderState } from '../src/index.js';
import { cssColor, cssNumber } from '../src/css.js';
import {
  createRoot,
  createWindow,
  describeRoot,
  elementOf,
  reference,
  referenceUrls,
} from './support.js';

const gridTimes = Array.from(
  { length: frameCount(reference.durationUs, reference.fps) },
  (_, frame) => frameToTimeUs(frame, reference.fps),
);

describe('CSS text of a number (D22.1)', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-3, '-3'],
    [0.1875, '0.1875'],
    [1.7125000000000001, '1.7125000000000001'],
    [92.266_663_999_999_99, '92.26666399999999'],
    [0.1 + 0.2, '0.30000000000000004'],
    [1e-7, '1e-7'],
    [1_000_000, '1000000'],
  ])('writes %d as %s', (value, text) => {
    expect(cssNumber(value)).toBe(text);
  });

  it('writes the shortest decimal that reads back as the same double', () => {
    expect(1.7125000000000001).not.toBe(1.7125);
    expect(Number(cssNumber(1.7125000000000001))).toBe(1.7125000000000001);
    expect(Number(cssNumber(92.266_663_999_999_99))).toBe(92.266_663_999_999_99);
  });

  // Premise of the comparisons below: jsdom stores what the renderer writes.
  it.each([
    ['transform', 'translate(1e-7px, -3px) scale(1.7125000000000001, 0)'],
    ['opacity', '1e-7'],
    ['opacity', '0.30000000000000004'],
    ['color', 'rgb(255, 255, 255)'],
    ['font-family', 'kadrion-font-asset-font'],
    ['transform-origin', '0px 0px'],
  ])('reads %s: %s back unchanged in the DOM used by the tests', (name, value) => {
    const element = createWindow().document.createElement('div');
    element.style.setProperty(name, value);
    expect(element.style.getPropertyValue(name)).toBe(value);
  });
});

describe('CSS text of a colour (D22.3)', () => {
  it.each([
    ['#0b1020', 'rgb(11, 16, 32)'],
    ['#d0d5dd', 'rgb(208, 213, 221)'],
    ['#ffffff', 'rgb(255, 255, 255)'],
    ['#000000', 'rgb(0, 0, 0)'],
  ])('writes %s as %s', (hex, text) => {
    expect(cssColor(hex)).toBe(text);
  });
});

// jsdom rewrites some values when it stores them (a hex colour, a trailing zero),
// so the tree read back cannot show what was written. This records the raw text.
describe('the text the renderer writes', () => {
  it('is exactly the text of the hand-derived tree, before the DOM stores it', () => {
    const window = createWindow();
    const written: string[] = [];
    const prototype: object = window.CSSStyleDeclaration.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, 'setProperty');
    Object.defineProperty(prototype, 'setProperty', {
      configurable: true,
      writable: true,
      value: function record(this: CSSStyleDeclaration, ...args: unknown[]): unknown {
        written.push(`${String(args[0])}: ${String(args[1])}`);
        return Reflect.apply(original?.value as (...rest: unknown[]) => unknown, this, args);
      },
    });
    const golden = referenceExpectedRender.golden.at(-1);
    const root = createRoot(window);
    try {
      mountComposition(root, reference, referenceUrls);
      renderState(root, evaluateComposition(reference, golden?.timeUs ?? 0));
    } finally {
      if (original !== undefined) Object.defineProperty(prototype, 'setProperty', original);
    }
    const declarations = (element: ExpectedElement): string[] => [
      ...Object.entries(element.style).map(([name, value]) => `${name}: ${value}`),
      ...element.children.flatMap((child) => ('tag' in child ? declarations(child) : [])),
    ];
    expect(golden).toBeDefined();
    expect([...written].sort()).toEqual(
      declarations(golden?.tree ?? ({} as ExpectedElement)).sort(),
    );
  });
});

describe('reference composition at the golden timestamps', () => {
  it('has a hand-derived tree for every golden timestamp', () => {
    expect(referenceExpectedRender.golden.map((golden) => golden.timeUs)).toEqual(
      goldenTimestamps.map((golden) => golden.timeUs),
    );
  });

  it.each(referenceExpectedRender.golden)(
    'renders exactly the hand-derived tree at $timeUs',
    ({ timeUs, tree }) => {
      const root = createRoot();
      mountComposition(root, reference, referenceUrls);
      renderState(root, evaluateComposition(reference, timeUs));
      expect(describeRoot(root)).toStrictEqual([tree]);
    },
  );
});

type Transformed = Exclude<NodeState, { type: 'background' }>;

function transformed(nodes: readonly NodeState[]): Transformed[] {
  return nodes.flatMap((node): Transformed[] => {
    if (node.type === 'background') return [];
    return node.type === 'group' ? [node, ...node.children] : [node];
  });
}

describe('every frame of the grid (D22.1, D22.2)', () => {
  // Golden values are integers and dyadic fractions; the grid holds values such as
  // 92.26666399999999 (frame 61), which a renderer that rounds would change.
  it('writes String() of every evaluated value, on one mounted tree', () => {
    const root = createRoot();
    mountComposition(root, reference, referenceUrls);
    // Values whose shortest decimal has at least 15 significant digits.
    const long = (value: number): boolean => String(value).replace(/[-.]/g, '').length >= 15;
    let longValues = 0;
    for (const timeUs of gridTimes) {
      const state = evaluateComposition(reference, timeUs);
      renderState(root, state);
      for (const node of transformed(state.scenes.flatMap((scene) => scene.nodes))) {
        const element = elementOf(root, node.id);
        const { position, scale, opacity } = node;
        const text = `translate(${String(position.x)}px, ${String(position.y)}px) scale(${String(scale.x)}, ${String(scale.y)})`;
        expect(element.style.getPropertyValue('transform'), `${node.id} at ${String(timeUs)}`).toBe(
          text,
        );
        expect(element.style.getPropertyValue('opacity')).toBe(String(opacity));
        longValues += [position.x, position.y, scale.x, scale.y, opacity].filter(long).length;
      }
    }
    // The grid really exercised long fractions, in every animated channel.
    expect(longValues).toBeGreaterThan(100);
    renderState(root, evaluateComposition(reference, gridTimes[61] ?? 0));
    expect(elementOf(root, 'node-group').style.transform).toBe(
      'translate(92.26666399999999px, 509.33332px) scale(1, 1)',
    );
  });
});
