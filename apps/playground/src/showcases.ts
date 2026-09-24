/**
 * The showcases of the playground (D32.1): data only. Each one names the JSON
 * the page loads, where that JSON lives in the repository, the node the grip
 * drags, and an example call of the AI tool. The feature labels are text for a
 * reader; nothing branches on them. `tests/repo/showcases.test.ts` keeps every
 * entry valid, so a schema change forces the showcases to follow (D32.8).
 */

/** A tool call as a model would send it: the name and the arguments (D31.1). */
export interface ShowcaseToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

export interface Showcase {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** What the showcase demonstrates, as labels for a reader (proofs, decisions). */
  readonly features: readonly string[];
  /** The URL of the built JSON the page fetches and shows. */
  readonly url: string;
  /** The repository path of the source of that JSON. */
  readonly sourceFile: string;
  /** A top-level node with a position and no position animation, or null (D32.4). */
  readonly dragNodeId: string | null;
  readonly toolCall: ShowcaseToolCall;
}

export const SHOWCASES: readonly Showcase[] = [
  {
    id: 'reference',
    title: 'Reference composition',
    description:
      'The spike reference: 1080x1920, 30 fps, 10 s. Background, image, two texts, a group, opacity/position/scale keyframes, a sandboxed Custom HTML progress bar, and an audio clip. Drag the title or undo/redo (P3).',
    features: ['P1', 'P3', 'P4', 'D16', 'D23', 'D30'],
    url: '/pkg/test-fixtures/compositions/reference.json',
    sourceFile: 'packages/test-fixtures/src/compositions/reference.json',
    dragNodeId: 'node-title',
    toolCall: {
      name: 'set_node_position',
      arguments: { nodeId: 'node-title', position: { x: 190, y: 360 } },
    },
  },
  {
    id: 'keyframes',
    title: 'Keyframes',
    description:
      'One text per animated property: opacity with three keyframes, a position offset that moves right and then down, and a scale from 0.5 to 2.5. Linear interpolation only (D18).',
    features: ['D16', 'D18', 'D19'],
    url: '/app/showcases/keyframes.json',
    sourceFile: 'apps/playground/src/showcases/keyframes.json',
    dragNodeId: 'node-heading',
    toolCall: {
      name: 'set_node_position',
      arguments: { nodeId: 'node-heading', position: { x: 300.5, y: 140 } },
    },
  },
  {
    id: 'group',
    title: 'Group transform',
    description:
      "A group scales and fades in; its children — an image and a caption with its own position animation — follow the group's transform. Children positions are relative to the group.",
    features: ['D15', 'D16', 'D22'],
    url: '/app/showcases/group.json',
    sourceFile: 'apps/playground/src/showcases/group.json',
    dragNodeId: 'node-title',
    toolCall: {
      name: 'set_node_position',
      arguments: { nodeId: 'node-card-caption', position: { x: 40, y: 760 } },
    },
  },
  {
    id: 'custom-html',
    title: 'Sandboxed Custom HTML',
    description:
      'A dial drawn by a Custom HTML element. It keeps no clock: it draws the time the host sends over the versioned message protocol and acknowledges it, so seeking backwards works (D23). It runs in an allow-scripts-only sandbox.',
    features: ['D05', 'D23'],
    url: '/app/showcases/custom-html.json',
    sourceFile: 'apps/playground/src/showcases/custom-html.json',
    dragNodeId: 'node-dial',
    toolCall: {
      name: 'set_node_position',
      arguments: { nodeId: 'node-dial', position: { x: 90, y: 900 } },
    },
  },
  {
    id: 'landscape',
    title: 'Landscape at 24 fps',
    description:
      'Canvas size and frame rate are data: 1920x1080 at 24 fps, 5 s, with an image sliding in, a fading title, and an audio clip (muxed by the Producer, silent in the preview).',
    features: ['D07', 'D13', 'D15'],
    url: '/app/showcases/landscape.json',
    sourceFile: 'apps/playground/src/showcases/landscape.json',
    dragNodeId: 'node-title',
    toolCall: {
      name: 'set_node_position',
      arguments: { nodeId: 'node-subtitle', position: { x: 860, y: 760 } },
    },
  },
];
