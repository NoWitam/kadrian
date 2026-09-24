/**
 * The mapping of D22 beyond the reference composition. Each synthetic document
 * first proves that the wrong variant really gives another result, then pins
 * the renderer to the rule. Expected values are D15 written out as arithmetic.
 */
import { evaluateComposition } from '@kadrion/runtime';
import { describe, expect, it } from 'vitest';

import { mountComposition, renderState } from '../src/index.js';
import {
  createRoot,
  derived,
  draftNode,
  elementOf,
  elementsOf,
  reference,
  referenceUrls,
  transformedNode,
  type Draft,
} from './support.js';

interface Point {
  readonly x: number;
  readonly y: number;
}

const NUMBER = String.raw`(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)`;
const TRANSFORM = new RegExp(
  String.raw`^translate\(${NUMBER}px, ${NUMBER}px\) scale\(${NUMBER}, ${NUMBER}\)$`,
);
const ORIGIN = new RegExp(String.raw`^${NUMBER}px ${NUMBER}px$`);

/**
 * Maps a point of an element's own space into the space of its parent, reading
 * everything that matters from the element: `left`, `top`, the transform, and
 * the transform origin. CSS: p' = offset + origin + translate + scale * (p - origin).
 */
function toParent(element: HTMLElement, point: Point): Point {
  const style = element.style;
  const transform = TRANSFORM.exec(style.getPropertyValue('transform'));
  const origin = ORIGIN.exec(style.getPropertyValue('transform-origin'));
  if (transform === null || origin === null) {
    throw new Error(`Unreadable transform of ${element.outerHTML.slice(0, 80)}`);
  }
  const [tx, ty, sx, sy] = transform.slice(1).map(Number) as [number, number, number, number];
  const [ox, oy] = origin.slice(1).map(Number) as [number, number];
  const left = Number.parseFloat(style.getPropertyValue('left'));
  const top = Number.parseFloat(style.getPropertyValue('top'));
  expect(style.getPropertyValue('position')).toBe('absolute');
  return {
    x: left + ox + tx + sx * (point.x - ox),
    y: top + oy + ty + sy * (point.y - oy),
  };
}

/** Maps a point of a node's own space into the space of its scene, element by element. */
function toScene(element: HTMLElement, point: Point): Point {
  let current: HTMLElement | null = element;
  let mapped = point;
  while (current !== null && !current.hasAttribute('data-kadrion-scene')) {
    mapped = toParent(current, mapped);
    current = current.parentElement;
  }
  return mapped;
}

function groupWithImage(draft: Draft): void {
  const group = draftNode(draft, 'node-group');
  const image = draftNode(draft, 'node-image');
  if (group.type !== 'group' || image.type !== 'image') throw new Error('Unexpected fixture.');
  group.position = { x: 100, y: 50 };
  group.scale = { x: 2, y: 0.5 };
  group.animations = [];
  image.position = { x: 10, y: 20 };
  image.scale = { x: 3, y: 4 };
  image.animations = [];
  image.width = 5;
  image.height = 6;
}

describe('nested transforms and a scale that is not the identity (D15, D22.2)', () => {
  // The bottom-right corner (5, 6) of the image, by D15: into the group, then into the scene.
  const inGroup = { x: 10 + 3 * 5, y: 20 + 4 * 6 };
  const expected = { x: 100 + 2 * inGroup.x, y: 50 + 0.5 * inGroup.y };

  it('premise: the wrong orders and spaces give other coordinates', () => {
    const scaleFirst = (t: Point, s: Point, p: Point): Point => ({
      x: s.x * (t.x + p.x),
      y: s.y * (t.y + p.y),
    });
    const wrongOrder = scaleFirst(
      { x: 100, y: 50 },
      { x: 2, y: 0.5 },
      scaleFirst({ x: 10, y: 20 }, { x: 3, y: 4 }, { x: 5, y: 6 }),
    );
    const unscaledChildren = { x: 100 + inGroup.x, y: 50 + inGroup.y };
    // Scaling about the centre of the 5 x 6 image instead of its top-left corner.
    const centred = { x: 10 + 2.5 + 3 * (5 - 2.5), y: 20 + 3 + 4 * (6 - 3) };
    expect(expected).toStrictEqual({ x: 150, y: 72 });
    for (const wrong of [
      wrongOrder,
      unscaledChildren,
      { x: 100 + 2 * centred.x, y: 50 + 0.5 * centred.y },
    ]) {
      expect(wrong).not.toStrictEqual(expected);
    }
  });

  it('places the corner of a scaled child of a scaled group where D15 puts it', () => {
    const document = derived(groupWithImage);
    const root = createRoot();
    mountComposition(root, document, referenceUrls);
    renderState(root, evaluateComposition(document, 0));
    const image = elementOf(root, 'node-image');
    expect(image.parentElement).toBe(elementOf(root, 'node-group'));
    expect(image.style.getPropertyValue('transform-origin')).toBe('0px 0px');
    expect(toScene(image, { x: 5, y: 6 })).toStrictEqual(expected);
    expect(toScene(image, { x: 0, y: 0 })).toStrictEqual({ x: 100 + 2 * 10, y: 50 + 0.5 * 20 });
  });

  it('writes a scale with an exponent and a tiny opacity as valid CSS numbers', () => {
    const document = derived((draft) => {
      groupWithImage(draft);
      const image = transformedNode(draft, 'node-image');
      image.scale = { x: 1e-7, y: 0.1 };
      image.opacity = 1e-7;
    });
    const root = createRoot();
    mountComposition(root, document, referenceUrls);
    renderState(root, evaluateComposition(document, 0));
    const image = elementOf(root, 'node-image');
    expect(image.style.transform).toBe('translate(10px, 20px) scale(1e-7, 0.1)');
    expect(image.style.opacity).toBe('1e-7');
  });
});

describe('opacity of a group (D15, D22.2)', () => {
  const document = derived((draft) => {
    transformedNode(draft, 'node-group').opacity = 0.5;
    transformedNode(draft, 'node-caption').opacity = 0.8;
  });

  it('premise: folding the group into its children changes the child value', () => {
    expect(0.5 * 0.8).not.toBe(0.8);
  });

  it('stays on the group element and is not folded into its children', () => {
    const root = createRoot();
    mountComposition(root, document, referenceUrls);
    renderState(root, evaluateComposition(document, 5_000_000));
    const group = elementOf(root, 'node-group');
    expect(group.style.opacity).toBe('0.5');
    expect(elementOf(root, 'node-caption').style.opacity).toBe('0.8');
    expect(elementOf(root, 'node-image').style.opacity).toBe('1');
    expect([...group.children].map((child) => child.getAttribute('data-kadrion-node'))).toEqual([
      'node-image',
      'node-caption',
    ]);
  });
});

describe('z-order (D16.4, D22.2)', () => {
  const order = ['node-background', 'node-custom-html', 'node-title', 'node-group'];
  const document = derived((draft) => {
    const nodes = draft.scenes[0]?.nodes ?? [];
    nodes.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  });

  it('premise: the reordered document differs from the reference and from its reverse', () => {
    const referenceOrder = reference.scenes[0]?.nodes.map((node) => node.id);
    expect(order).not.toEqual(referenceOrder);
    expect([...order].reverse()).not.toEqual(order);
  });

  it('follows the array order in the DOM and sets no z-index anywhere', () => {
    const root = createRoot();
    mountComposition(root, document, referenceUrls);
    renderState(root, evaluateComposition(document, 0));
    const scene = root.querySelector('[data-kadrion-scene]');
    expect(
      [...(scene?.children ?? [])].map((child) => child.getAttribute('data-kadrion-node')),
    ).toEqual(order);
    for (const element of elementsOf(root)) {
      expect(element.getAttribute('style') ?? '').not.toContain('z-index');
    }
  });
});

describe('content that must never become markup (D05, D22.3, D23.2)', () => {
  const markup = '<img src=x onerror="globalThis.hacked = true"><b>bold</b>';

  it('sets text as one text node, never parsed', () => {
    const document = derived((draft) => {
      const title = draftNode(draft, 'node-title');
      if (title.type !== 'text') throw new Error('node-title is a text node.');
      title.text = markup;
    });
    const root = createRoot();
    mountComposition(root, document, referenceUrls);
    const title = elementOf(root, 'node-title');
    expect(title.children).toHaveLength(0);
    expect(title.childNodes).toHaveLength(1);
    expect(title.firstChild?.nodeType).toBe(root.ownerDocument.TEXT_NODE);
    expect(title.textContent).toBe(markup);
    expect(root.querySelectorAll('b, img:not([data-kadrion-node])')).toHaveLength(0);
  });

  it('puts the Custom HTML into the srcdoc of its frame and nowhere else', () => {
    const document = derived((draft) => {
      const custom = draftNode(draft, 'node-custom-html');
      if (custom.type !== 'custom-html') throw new Error('node-custom-html is Custom HTML.');
      custom.html = markup;
    });
    const root = createRoot();
    mountComposition(root, document, referenceUrls);
    renderState(root, evaluateComposition(document, 0));
    const placeholder = elementOf(root, 'node-custom-html');
    expect(placeholder.localName).toBe('div');
    expect(placeholder.childNodes).toHaveLength(1);
    const frame = placeholder.firstElementChild;
    expect(frame?.localName).toBe('iframe');
    expect(frame?.childNodes).toHaveLength(0);
    expect(frame?.getAttribute('srcdoc')?.endsWith(markup)).toBe(true);
    // Never parsed in the host document: no element, and the text only inside the attribute.
    expect(root.querySelectorAll('b, img:not([data-kadrion-node])')).toHaveLength(0);
    frame?.removeAttribute('srcdoc');
    expect(root.innerHTML).not.toContain('onerror');
    expect(root.ownerDocument.documentElement.outerHTML).not.toContain('onerror');
    expect((root.ownerDocument.defaultView as { hacked?: unknown } | null)?.hacked).toBeUndefined();
  });
});
