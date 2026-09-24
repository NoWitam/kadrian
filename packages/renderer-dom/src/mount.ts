/**
 * Builds the DOM tree of a document (D22.3). Only static properties of the
 * document are written here; `renderState` writes the evaluated ones.
 */
import type { GroupNode, SceneNode, ValidatedComposition } from '@kadrion/schema';

import { checkAssetUrls, type AssetUrls } from './assets.js';
import { cssColor, cssPixels, fontFamily } from './css.js';
import { unsupportedNode } from './errors.js';
import { sandboxFrame } from './sandbox.js';

/** Attributes that address the elements of a mounted tree. They hold IDs, never state. */
export const STAGE_ATTRIBUTE = 'data-kadrion-composition';
export const SCENE_ATTRIBUTE = 'data-kadrion-scene';
export const NODE_ATTRIBUTE = 'data-kadrion-node';

type Styles = Readonly<Record<string, string>>;

const PLACED: Styles = Object.freeze({ position: 'absolute', left: '0px', top: '0px' });
/** Scaling happens about the top-left corner of the node (D15). */
const TRANSFORMED: Styles = Object.freeze({ ...PLACED, 'transform-origin': '0px 0px' });

function create(
  document: Document,
  tag: 'div' | 'img',
  attributes: Styles,
  styles: Styles,
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value);
  return element;
}

function nodeElement(
  document: Document,
  node: SceneNode | GroupNode['children'][number],
  canvas: Styles,
  assetUrls: AssetUrls,
): HTMLElement {
  const address = { [NODE_ATTRIBUTE]: node.id };
  switch (node.type) {
    case 'background':
      return create(document, 'div', address, {
        ...PLACED,
        ...canvas,
        'background-color': cssColor(node.color),
      });
    case 'group': {
      const group = create(document, 'div', address, TRANSFORMED);
      group.append(
        ...node.children.map((child) => nodeElement(document, child, canvas, assetUrls)),
      );
      return group;
    }
    case 'image':
      return create(
        document,
        'img',
        { ...address, src: assetUrls[node.assetId] ?? '', alt: '' },
        {
          ...TRANSFORMED,
          display: 'block',
          width: cssPixels(node.width),
          height: cssPixels(node.height),
          'object-fit': 'fill',
        },
      );
    case 'text': {
      const text = create(document, 'div', address, {
        ...TRANSFORMED,
        'white-space': 'pre',
        'font-family': fontFamily(node.fontAssetId),
        'font-size': cssPixels(node.fontSize),
        'line-height': '1.25',
        'font-weight': '400',
        'font-style': 'normal',
        color: cssColor(node.color),
      });
      // A text node, never markup: the document's text is not parsed.
      text.append(document.createTextNode(node.text));
      return text;
    }
    case 'custom-html': {
      // A sized placeholder that carries the transform, and inside it the
      // sandboxed frame, the only place the document's HTML goes (D05, D23).
      const placeholder = create(document, 'div', address, {
        ...TRANSFORMED,
        width: cssPixels(node.width),
        height: cssPixels(node.height),
      });
      placeholder.append(sandboxFrame(document, node));
      return placeholder;
    }
    default:
      return unsupportedNode(node);
  }
}

/**
 * Replaces the content of `root` with the tree of `composition` (D22.3). The
 * asset URLs are checked first; any problem throws a `RenderError` before the
 * DOM is touched. Every element is created through `root.ownerDocument`, so the
 * renderer works in whichever realm owns `root`. Nothing is kept between calls:
 * the tree itself is the only state, and `renderState` finds it again.
 */
export function mountComposition(
  root: Element,
  composition: ValidatedComposition,
  assetUrls: AssetUrls,
): void {
  const urls = checkAssetUrls(composition, assetUrls);
  const document = root.ownerDocument;
  const canvas = { width: cssPixels(composition.width), height: cssPixels(composition.height) };
  const stage = create(
    document,
    'div',
    { [STAGE_ATTRIBUTE]: '' },
    { position: 'relative', ...canvas, overflow: 'hidden' },
  );
  for (const scene of composition.scenes) {
    const sceneElement = create(
      document,
      'div',
      { [SCENE_ATTRIBUTE]: scene.id },
      { ...PLACED, ...canvas },
    );
    sceneElement.append(...scene.nodes.map((node) => nodeElement(document, node, canvas, urls)));
    stage.append(sceneElement);
  }
  root.replaceChildren(stage);
}
