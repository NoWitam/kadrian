import type { SceneNode, ValidatedComposition } from '@kadrion/schema';

import { EvaluationError, unsupported } from './errors.js';
import { sampleScalar, sampleVec2 } from './keyframes.js';
import type {
  CompositionState,
  LeafNodeState,
  LeafNodeType,
  NodeState,
  TransformState,
  Vec2,
} from './state.js';

type TransformedNode = Exclude<SceneNode, { readonly type: 'background' }>;

/**
 * An animation modifies the base value and never replaces it (D16.6): position
 * keyframes are offsets that are added, scale and opacity keyframes are factors
 * that are multiplied. The base value meets the sampled value in one operation
 * (D18); a property without an animation is its base value.
 */
function evaluateTransform(node: TransformedNode, timeUs: number): TransformState {
  let position: Vec2 = { x: node.position.x, y: node.position.y };
  let scale: Vec2 = { x: node.scale.x, y: node.scale.y };
  let opacity = node.opacity;

  // Validation guarantees at most one animation per property, in any order.
  for (const animation of node.animations) {
    switch (animation.property) {
      case 'position': {
        const offset = sampleVec2(animation, timeUs);
        position = { x: node.position.x + offset.x, y: node.position.y + offset.y };
        break;
      }
      case 'scale': {
        const factor = sampleVec2(animation, timeUs);
        scale = { x: node.scale.x * factor.x, y: node.scale.y * factor.y };
        break;
      }
      case 'opacity':
        opacity = node.opacity * sampleScalar(animation, timeUs);
        break;
      default:
        unsupported(animation, 'property');
    }
  }
  return { position, scale, opacity };
}

function evaluateLeaf<Type extends LeafNodeType>(
  node: TransformedNode & { readonly type: Type },
  timeUs: number,
): LeafNodeState<Type> {
  return { id: node.id, type: node.type, ...evaluateTransform(node, timeUs) };
}

/** Children keep their local values: nothing of the group is folded into them (D15). */
function evaluateNode(node: SceneNode, timeUs: number): NodeState {
  switch (node.type) {
    case 'background':
      return { id: node.id, type: node.type };
    case 'group':
      return {
        id: node.id,
        type: node.type,
        ...evaluateTransform(node, timeUs),
        children: node.children.map((child) => evaluateLeaf(child, timeUs)),
      };
    case 'image':
    case 'text':
    case 'custom-html':
      return evaluateLeaf(node, timeUs);
    default:
      return unsupported(node, 'type');
  }
}

/**
 * The state of a composition at `timeUs`, derived from `(composition, timeUs)`
 * and nothing else: no clock, no timer, no playback history, no cache (D18,
 * D19). The document is never modified, and the state shares no object with it.
 *
 * `timeUs` is an integer with `0 <= timeUs < durationUs`; it need not lie on the
 * frame grid, which is host-side sampling (D13). Any other value throws an
 * `EvaluationError` instead of being clamped or rounded.
 */
export function evaluateComposition(
  composition: ValidatedComposition,
  timeUs: number,
): CompositionState {
  if (!Number.isInteger(timeUs)) {
    const message = `timeUs must be an integer number of microseconds, got ${String(timeUs)}.`;
    throw new EvaluationError('time-not-integer', message);
  }
  if (timeUs < 0 || timeUs >= composition.durationUs) {
    const range = `at least 0 and less than durationUs (${String(composition.durationUs)})`;
    throw new EvaluationError(
      'time-out-of-range',
      `timeUs must be ${range}, got ${String(timeUs)}.`,
    );
  }

  // `-0` is an integer inside the domain; the state reports it as `0`.
  const time = timeUs === 0 ? 0 : timeUs;
  return {
    timeUs: time,
    scenes: composition.scenes.map((scene) => ({
      id: scene.id,
      nodes: scene.nodes.map((node) => evaluateNode(node, time)),
    })),
  };
}
