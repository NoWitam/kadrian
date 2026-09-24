/**
 * The hand-derived expected DOM tree (`reference.expected-render.json`) must
 * stay in step with the reference composition, with the hand-derived expected
 * state, and with the rules of D22 and D23 (the Custom HTML element and its
 * messages). These checks read the three files as data and
 * involve no renderer, so the fixture is guarded on its own. The mapping below is
 * written out independently of `@kadrion/renderer-dom`.
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
  color?: string;
  width?: number;
  height?: number;
  assetId?: string;
  fontAssetId?: string;
  fontSize?: number;
  text?: string;
  html?: string;
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

interface ExpectedText {
  text: string;
}

interface ExpectedElement {
  tag: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  children: (ExpectedElement | ExpectedText)[];
}

interface Message {
  type: string;
  version: number;
  instanceId: string;
  requestId: number;
  timeUs: number;
}

interface ExpectedRender {
  rule: string[];
  assetUrls: Record<string, string>;
  golden: {
    timeUs: number;
    derivation: string[];
    tree: ExpectedElement;
    customHtml: { nodeId: string; post: Message; acknowledgement: Message }[];
  }[];
}

const COMPOSITIONS = ['packages', 'test-fixtures', 'src', 'compositions'] as const;
const reference = readJson(...COMPOSITIONS, 'reference.json') as {
  width: number;
  height: number;
  assets: { id: string; type: string }[];
  scenes: { id: string; nodes: DocumentNode[] }[];
};
const states = readJson(...COMPOSITIONS, 'reference.expected-state.json') as {
  golden: { timeUs: number; state: { scenes: { id: string; nodes: StateNode[] }[] } }[];
};
const expected = readJson(...COMPOSITIONS, 'reference.expected-render.json') as ExpectedRender;

const goldenTimes = [
  ...(/Golden timestamps: (.*?) microseconds/.exec(agentsText)?.[1] ?? '').matchAll(/`([\d_]+)`/g),
].map((match) => Number((match[1] ?? '').replaceAll('_', '')));

const px = (value: number): string => `${String(value)}px`;

/** `#rrggbb` as the CSS Object Model serialises it (D22.3). */
function rgb(hex: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `rgb(${channels.join(', ')})`;
}

/** D23.2: the policy of the element, one directive per entry. */
const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
];
/** D23.2: the shell that precedes the document's html in srcdoc, with the instance of D23.3. */
const shell = (nodeId: string): string =>
  [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${POLICY.join('; ')}">`,
    `<meta name="kadrion-instance" content="${nodeId}">`,
    '</head>',
  ].join('');

/** The request ID the fixture assumes: the frame index of a golden timestamp (§3.3). */
const FRAME_OF: Readonly<Record<number, number>> = {
  0: 0,
  2_500_000: 75,
  5_000_000: 150,
  7_500_000: 225,
  9_900_000: 297,
};

/** D23.1: the one child of a Custom HTML placeholder. */
function sandbox(node: DocumentNode): ExpectedElement {
  const none = 'none';
  return {
    tag: 'iframe',
    attributes: { sandbox: 'allow-scripts', srcdoc: `${shell(node.id)}${node.html ?? ''}` },
    style: {
      display: 'block',
      width: px(node.width ?? 0),
      height: px(node.height ?? 0),
      'border-top-style': none,
      'border-right-style': none,
      'border-bottom-style': none,
      'border-left-style': none,
    },
    children: [],
  };
}

const PLACED = { position: 'absolute', left: '0px', top: '0px' };
const ORIGIN = { ...PLACED, 'transform-origin': '0px 0px' };

/** D22.2: the evaluated values of one node as CSS text. */
function dynamic(state: StateNode): Record<string, string> {
  const { position, scale, opacity } = state;
  if (position === undefined || scale === undefined || opacity === undefined) return {};
  return {
    transform: `translate(${px(position.x)}, ${px(position.y)}) scale(${String(scale.x)}, ${String(scale.y)})`,
    opacity: String(opacity),
  };
}

/** D22.3 for one node, from the document and the expected state only. */
function element(node: DocumentNode, state: StateNode): ExpectedElement {
  const attributes = { 'data-kadrion-node': node.id };
  const canvas = { width: px(reference.width), height: px(reference.height) };
  switch (node.type) {
    case 'background':
      return {
        tag: 'div',
        attributes,
        style: { ...PLACED, ...canvas, 'background-color': rgb(node.color ?? '') },
        children: [],
      };
    case 'group':
      return {
        tag: 'div',
        attributes,
        style: { ...ORIGIN, ...dynamic(state) },
        children: (node.children ?? []).map((child, index) =>
          element(child, state.children?.[index] ?? { id: '', type: '' }),
        ),
      };
    case 'image':
      return {
        tag: 'img',
        attributes: { ...attributes, src: expected.assetUrls[node.assetId ?? ''] ?? '', alt: '' },
        style: {
          ...ORIGIN,
          display: 'block',
          width: px(node.width ?? 0),
          height: px(node.height ?? 0),
          'object-fit': 'fill',
          ...dynamic(state),
        },
        children: [],
      };
    case 'text':
      return {
        tag: 'div',
        attributes,
        style: {
          ...ORIGIN,
          'white-space': 'pre',
          'font-family': `kadrion-font-${node.fontAssetId ?? ''}`,
          'font-size': px(node.fontSize ?? 0),
          'line-height': '1.25',
          'font-weight': '400',
          'font-style': 'normal',
          color: rgb(node.color ?? ''),
          ...dynamic(state),
        },
        children: [{ text: node.text ?? '' }],
      };
    case 'custom-html':
      return {
        tag: 'div',
        attributes,
        style: {
          ...ORIGIN,
          width: px(node.width ?? 0),
          height: px(node.height ?? 0),
          ...dynamic(state),
        },
        children: [sandbox(node)],
      };
    default:
      throw new Error(`The reference composition has no node type ${node.type}.`);
  }
}

function everyElement(tree: ExpectedElement): ExpectedElement[] {
  return [tree, ...tree.children.flatMap((child) => ('tag' in child ? everyElement(child) : []))];
}

describe('expected DOM tree of the reference composition', () => {
  it('covers exactly the golden timestamps of AGENTS.md, in order', () => {
    expect(goldenTimes).toHaveLength(5);
    expect(expected.golden.map((golden) => golden.timeUs)).toEqual(goldenTimes);
    expect(states.golden.map((golden) => golden.timeUs)).toEqual(goldenTimes);
  });

  it('states its rule for numbers', () => {
    expect(expected.rule.join(' ')).toContain('String(n)');
  });

  it('states the shell of the Custom HTML element exactly as the trees use it (D23.2)', () => {
    expect(expected.rule.join(' ')).toContain(
      `srcdoc is the shell ${shell('<nodeId>')} followed by`,
    );
  });

  it('passes a URL for exactly the image and font assets that visual nodes use', () => {
    const used = reference.assets
      .filter((asset) => asset.type !== 'audio')
      .map((asset) => asset.id);
    expect(Object.keys(expected.assetUrls).sort()).toEqual(used.sort());
    for (const url of Object.values(expected.assetUrls)) expect(url).not.toBe('');
  });

  // The value that makes rounding visible: a renderer that fixes digits writes 1.7125.
  it('carries a value whose shortest decimal needs 17 digits', () => {
    const text = JSON.stringify(expected.golden.at(-1)?.tree);
    expect(text).toContain('scale(2.175, 1.7125000000000001)');
  });
});

const customHtmlNodes = reference.scenes
  .flatMap((scene) => scene.nodes)
  .flatMap((node) => [node, ...(node.children ?? [])])
  .filter((node) => node.type === 'custom-html');

describe('Custom HTML element of the reference composition (D23)', () => {
  it('is exactly one element, whose html sits in srcdoc after the shell', () => {
    expect(customHtmlNodes.map((node) => node.id)).toEqual(['node-custom-html']);
    const trees = JSON.stringify(expected.golden.map((golden) => golden.tree));
    const html = customHtmlNodes[0]?.html ?? '';
    expect(html).not.toBe('');
    // The html appears once per golden tree, always right after the shell.
    expect(trees.split(JSON.stringify(html).slice(1, -1))).toHaveLength(expected.golden.length + 1);
    expect(trees.split(JSON.stringify(shell('node-custom-html') + html).slice(1, -1))).toHaveLength(
      expected.golden.length + 1,
    );
  });

  // The fixture element must be a conforming element of D23.3. It is data of
  // schema 0.1, so the text itself is pinned, not a paraphrase; what it does is
  // run in packages/renderer-dom/test/custom-html-element.test.ts.
  it('accepts kadrion:time from its parent only, strictly, and answers its parent only', () => {
    const html = customHtmlNodes[0]?.html ?? '';
    expect(html).toContain('if(event.source!==window.parent)return;');
    expect(html).toContain("var KEYS='instanceId,requestId,timeUs,type,version';");
    expect(html).toContain("Object.keys(data).sort().join(',')!==KEYS");
    expect(html).toContain(
      "data.type!=='kadrion:time'||data.version!==1||instanceId===null||data.instanceId!==instanceId",
    );
    expect(html).toContain("document.querySelector('meta[name=kadrion-instance]')");
    expect(html).toContain(
      "window.parent.postMessage({type:'kadrion:time-ack',version:1,instanceId:instanceId,requestId:data.requestId,timeUs:data.timeUs},'*')",
    );
    expect(html.match(/postMessage/g)).toHaveLength(1);
  });
});

describe.each(expected.golden)(
  'expected DOM tree at $timeUs',
  ({ timeUs, derivation, tree, customHtml }) => {
    it('posts the golden time to every Custom HTML element and accepts only its echo', () => {
      expect(customHtml).toStrictEqual(
        customHtmlNodes.map((node) => {
          const correlation = {
            version: 1,
            instanceId: node.id,
            requestId: FRAME_OF[timeUs],
            timeUs,
          };
          return {
            nodeId: node.id,
            post: { type: 'kadrion:time', ...correlation },
            acknowledgement: { type: 'kadrion:time-ack', ...correlation },
          };
        }),
      );
      for (const { nodeId } of customHtml) {
        expect(
          derivation.filter((line) => line.startsWith(`${nodeId}: the host posts`)),
        ).toHaveLength(1);
      }
    });

    const state = states.golden.find((golden) => golden.timeUs === timeUs)?.state;

    it('is D22 applied to the document and to the expected state at the same time', () => {
      expect(state).toBeDefined();
      const canvas = { width: px(reference.width), height: px(reference.height) };
      expect(tree).toStrictEqual({
        tag: 'div',
        attributes: { 'data-kadrion-composition': '' },
        style: { position: 'relative', ...canvas, overflow: 'hidden' },
        children: reference.scenes.map((scene, sceneIndex) => {
          const sceneState = state?.scenes[sceneIndex];
          expect(sceneState?.id).toBe(scene.id);
          return {
            tag: 'div',
            attributes: { 'data-kadrion-scene': scene.id },
            style: { ...PLACED, ...canvas },
            children: scene.nodes.map((node, index) =>
              element(node, sceneState?.nodes[index] ?? { id: '', type: '' }),
            ),
          };
        }),
      });
    });

    it('sets no z-index and no position through left or top other than 0px', () => {
      for (const item of everyElement(tree)) {
        expect(Object.keys(item.style)).not.toContain('z-index');
        for (const side of ['left', 'top'] as const) {
          if (side in item.style) expect(item.style[side]).toBe('0px');
        }
      }
    });

    it('derives the CSS text of every transformed node', () => {
      const ids = everyElement(tree)
        .filter((item) => 'transform' in item.style)
        .map((item) => item.attributes['data-kadrion-node'] ?? '');
      expect(ids).toEqual([
        'node-group',
        'node-image',
        'node-caption',
        'node-title',
        'node-custom-html',
      ]);
      for (const id of ids)
        expect(derivation.some((line) => line.startsWith(`${id}: `))).toBe(true);
    });
  },
);
