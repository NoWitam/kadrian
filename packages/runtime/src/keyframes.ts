/**
 * Keyframe sampling and the one arithmetic rule of the runtime (D18). The order
 * of the operations is part of the contract: another order yields other bits.
 */
import type { NodeAnimation } from '@kadrion/schema';

import { EvaluationError } from './errors.js';
import type { Vec2 } from './state.js';

interface Keyframe<Value> {
  readonly timeUs: number;
  readonly value: Value;
}

type Interpolate = (start: number, end: number, elapsedUs: number, spanUs: number) => number;

/**
 * `start + ((end - start) * elapsedUs) / spanUs`, in exactly this order, called
 * only with `0 < elapsedUs < spanUs`. It uses nothing but `+ - * /`, which
 * ECMAScript defines as correctly rounded binary64 operations, so every engine
 * yields the same bits. The product feeds a division, so there is no
 * multiply-add pattern that a fused operation could contract.
 */
const linear: Interpolate = (start, end, elapsedUs, spanUs) =>
  start + ((end - start) * elapsedUs) / spanUs;

/**
 * One entry per interpolation mode of the schema. A mode that the schema gains
 * leaves this object incomplete, which fails compilation until it is implemented.
 */
const INTERPOLATORS: Readonly<Record<NodeAnimation['interpolation'], Interpolate>> = { linear };

/** A mode outside the table cannot come out of validation; it is reported, never skipped. */
function interpolatorOf(animation: NodeAnimation): Interpolate {
  if (!Object.hasOwn(INTERPOLATORS, animation.interpolation)) {
    const mode = JSON.stringify(animation.interpolation);
    const message = `The document has an unsupported interpolation, ${mode}.`;
    throw new EvaluationError('invalid-document', message);
  }
  return INTERPOLATORS[animation.interpolation];
}

/**
 * The value of an animation at `timeUs` (D16.6, D18). At or before the first
 * keyframe the first value holds, and at or after the last keyframe the last
 * value holds. A time exactly on a keyframe yields the value of that keyframe
 * without any arithmetic; only a time strictly between two keyframes is
 * interpolated. Keyframe times ascend strictly, which validation guarantees.
 */
function sample<Value>(
  keyframes: readonly Keyframe<Value>[],
  timeUs: number,
  between: (previous: Keyframe<Value>, next: Keyframe<Value>) => Value,
): Value {
  let previous: Keyframe<Value> | undefined;
  for (const keyframe of keyframes) {
    if (timeUs <= keyframe.timeUs) {
      return previous === undefined || timeUs === keyframe.timeUs
        ? keyframe.value
        : between(previous, keyframe);
    }
    previous = keyframe;
  }
  if (previous === undefined) {
    const message = 'An animation without keyframes cannot come out of validateComposition.';
    throw new EvaluationError('invalid-document', message);
  }
  return previous.value;
}

export function sampleScalar(
  animation: Extract<NodeAnimation, { property: 'opacity' }>,
  timeUs: number,
): number {
  const interpolate = interpolatorOf(animation);
  return sample(animation.keyframes, timeUs, (previous, next) =>
    interpolate(
      previous.value,
      next.value,
      timeUs - previous.timeUs,
      next.timeUs - previous.timeUs,
    ),
  );
}

/** `x` and `y` are independent channels of the same rule. */
export function sampleVec2(
  animation: Extract<NodeAnimation, { property: 'position' | 'scale' }>,
  timeUs: number,
): Vec2 {
  const interpolate = interpolatorOf(animation);
  return sample(animation.keyframes, timeUs, (previous, next) => {
    const elapsedUs = timeUs - previous.timeUs;
    const spanUs = next.timeUs - previous.timeUs;
    return {
      x: interpolate(previous.value.x, next.value.x, elapsedUs, spanUs),
      y: interpolate(previous.value.y, next.value.y, elapsedUs, spanUs),
    };
  });
}
