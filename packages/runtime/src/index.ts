/**
 * @kadrion/runtime — deterministic state evaluation, layout, interpolation.
 *
 * The evaluation core: the state of a composition at `timeUs`. It knows no DOM,
 * no layout, no assets, and no frame grid yet. PROVISIONAL: this API implements
 * the Proposed ADRs D18 and D19 and may change until the project owner accepts
 * them.
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
