/**
 * The evaluated state of a composition at one instant (D19). It mirrors the
 * document: scenes, nodes, and group children keep their order and hierarchy
 * (D16.4), and every value is local to the parent of its node (D15). Static
 * properties such as colours, text, and asset references stay in the document;
 * a renderer walks the document and the state side by side.
 */

/** A pair of evaluated values. Unlike persisted coordinates, they may be fractional (D15). */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** The animatable properties of a node after its animations were applied (D16.6). */
export interface TransformState {
  /** Offset of the origin of the node relative to the origin of its parent, in composition pixels. */
  readonly position: Vec2;
  readonly scale: Vec2;
  /** Not multiplied into children: a group is composited before its opacity applies (D15). */
  readonly opacity: number;
}

export type LeafNodeType = 'image' | 'text' | 'custom-html';

export interface BackgroundNodeState {
  readonly id: string;
  readonly type: 'background';
}

export interface LeafNodeState<Type extends LeafNodeType = LeafNodeType> extends TransformState {
  readonly id: string;
  readonly type: Type;
}

export interface GroupNodeState extends TransformState {
  readonly id: string;
  readonly type: 'group';
  /** Array order is the z-order, as in the document; groups do not nest in schema 0.1. */
  readonly children: readonly LeafNodeState<'image' | 'text'>[];
}

export type NodeState = BackgroundNodeState | GroupNodeState | LeafNodeState;

export interface SceneState {
  readonly id: string;
  /** Array order is the z-order, as in the document. */
  readonly nodes: readonly NodeState[];
}

export interface CompositionState {
  /** The instant this state was evaluated for. */
  readonly timeUs: number;
  readonly scenes: readonly SceneState[];
}
