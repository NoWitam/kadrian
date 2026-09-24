/**
 * @kadrion/runtime — deterministic state evaluation, layout, interpolation.
 *
 * The evaluation core: the state of a composition at `timeUs` (D18, D19). It
 * knows no DOM, no layout, no assets, and no frame grid, and it reads no clock:
 * the host supplies `timeUs` (D20). Rendering the state is the job of
 * `@kadrion/renderer-dom`.
 */
export { EvaluationError } from './errors.js';
export type { EvaluationErrorCode } from './errors.js';
export { evaluateComposition } from './evaluate.js';
export type {
  BackgroundNodeState,
  CompositionState,
  GroupNodeState,
  LeafNodeState,
  LeafNodeType,
  NodeState,
  SceneState,
  TransformState,
  Vec2,
} from './state.js';
