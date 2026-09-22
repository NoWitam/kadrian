/**
 * Evaluation semantics (D16.6, D18) beyond the golden timestamps. The reference
 * composition has two keyframes per animation, identity bases for scale and
 * opacity, and a zero first offset, so several wrong runtimes would reproduce
 * its golden states. Each synthetic document below first proves that the wrong
 * alternative really yields other bits, then pins the runtime to the rule.
 * Expected values are the rule written out as literal arithmetic.
 */
import { isDeepStrictEqual } from 'node:util';

import {
  frameCount,
  frameToTimeUs,
  timeUsToFrame,
  type Composition,
  type ValidatedComposition,
} from '@kadrion/schema';
import { goldenTimestamps } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { EvaluationError, evaluateComposition } from '../src/index.js';
import {
  animation,
  derived,
  draftNode,
  reference,
  referenceDraft,
  seededRandom,
  stateNode,
} from './support.js';

const { fps, durationUs } = reference;
const goldenTimes = goldenTimestamps.map((golden) => golden.timeUs);
const gridTimes = Array.from({ length: frameCount(durationUs, fps) }, (_, frame) =>
  frameToTimeUs(frame, fps),
);

describe('evaluation off the frame grid', () => {
  it.each([1_250_000, 6_250_000])('%d lies between two grid times', (timeUs) => {
    expect(frameToTimeUs(timeUsToFrame(timeUs, fps), fps)).toBeLessThan(timeUs);
  });

  it('follows the rule at 1 250 000', () => {
    const state = evaluateComposition(reference, 1_250_000);
    // offset = ((60, 300) * 1 250 000) / 7 500 000 = (10, 50), all exact integers
    expect(stateNode(state, 'node-group').position).toStrictEqual({ x: 70, y: 470 });
    // before the first scale keyframe at 2 500 000: the first factor holds
    expect(stateNode(state, 'node-image').scale).toStrictEqual({ x: 1, y: 1 });
    // 0.25 + (0.75 * 1 250 000) / 7 500 000 = 0.25 + 0.125, dyadic and exact
    expect(stateNode(state, 'node-title').opacity).toBe(0.375);
  });

  it('follows the rule at 6 250 000', () => {
    const state = evaluateComposition(reference, 6_250_000);
    // offset = ((60, 300) * 6 250 000) / 7 500 000 = (50, 250)
    expect(stateNode(state, 'node-group').position).toStrictEqual({ x: 110, y: 670 });
    // elapsed 3 750 000 of 7 500 000: 1 + 0.75 / 2 and 1 + 0.375 / 2
    expect(stateNode(state, 'node-image').scale).toStrictEqual({ x: 1.375, y: 1.1875 });
    // 0.25 + (0.75 * 6 250 000) / 7 500 000 = 0.25 + 0.625
    expect(stateNode(state, 'node-title').opacity).toBe(0.875);
  });

  it('does not snap to the frame grid: every microsecond inside frame 1 has its own state', () => {
    const times = [33_333, 33_334, 50_000, 66_665];
    expect(times.map((timeUs) => timeUsToFrame(timeUs, fps))).toEqual([1, 1, 1, 1]);
    const xs = times.map(
      (timeUs) => stateNode(evaluateComposition(reference, timeUs), 'node-group').position.x,
    );
    expect(xs).toStrictEqual(times.map((timeUs) => 60 + (60 * timeUs) / 7_500_000));
    expect([...xs].sort((a, b) => a - b)).toStrictEqual(xs);
    expect(new Set(xs).size).toBe(times.length);
  });

  it.each([1, 24, 60, 120])('ignores the frame rate: %d fps yields the same states', (rate) => {
    const retimed = derived((draft) => {
      draft.fps = rate;
    });
    for (const timeUs of [...goldenTimestamps.map((golden) => golden.timeUs), 33_334, 9_999_999]) {
      expect(evaluateComposition(retimed, timeUs)).toStrictEqual(
        evaluateComposition(reference, timeUs),
      );
    }
  });
});

describe('time domain', () => {
  it.each([
    ['NaN', Number.NaN, 'time-not-integer'],
    ['+Infinity', Number.POSITIVE_INFINITY, 'time-not-integer'],
    ['-Infinity', Number.NEGATIVE_INFINITY, 'time-not-integer'],
    ['a fraction', 0.5, 'time-not-integer'],
    ['a fraction next to a valid time', 2_500_000.5, 'time-not-integer'],
    ['a numeric string', '0' as unknown as number, 'time-not-integer'],
    ['a negative integer', -1, 'time-out-of-range'],
    ['durationUs, which is exclusive', durationUs, 'time-out-of-range'],
    ['durationUs + 1', durationUs + 1, 'time-out-of-range'],
    ['2^53, an integer that is not safe', 2 ** 53, 'time-out-of-range'],
    ['the largest double, also an integer', Number.MAX_VALUE, 'time-out-of-range'],
  ])('rejects %s with a typed error', (_, timeUs, code) => {
    const attempt = (): unknown => evaluateComposition(reference, timeUs);
    expect(attempt).toThrow(EvaluationError);
    expect(attempt).toThrow(RangeError);
    expect(attempt).toThrow(expect.objectContaining({ name: 'EvaluationError', code }));
  });

  it('accepts both ends of the domain', () => {
    expect(evaluateComposition(reference, 0).timeUs).toBe(0);
    expect(evaluateComposition(reference, durationUs - 1).timeUs).toBe(durationUs - 1);
  });

  it('reports negative zero as zero', () => {
    expect(-0).not.toStrictEqual(0); // the comparison used here tells them apart
    expect(evaluateComposition(reference, -0)).toStrictEqual(evaluateComposition(reference, 0));
  });

  it('never samples a keyframe at durationUs, because the end is exclusive (D16.5)', () => {
    const { scale } = stateNode(evaluateComposition(reference, durationUs - 1), 'node-image');
    expect(scale).toStrictEqual({
      x: 1 * (1 + ((1.75 - 1) * 7_499_999) / 7_500_000),
      y: 1 * (1 + ((1.375 - 1) * 7_499_999) / 7_500_000),
    });
    expect(scale.x).toBeLessThan(1.75);
    expect(scale.y).toBeLessThan(1.375);
  });
});

type Order = (a: number, b: number, elapsed: number, span: number) => number;

interface Channel {
  readonly base: number;
  /** Position offsets are added to the base value; scale and opacity factors are multiplied. */
  readonly added: boolean;
  readonly a: number;
  readonly b: number;
  readonly t0: number;
  readonly t1: number;
}

interface Keyframe<Value> {
  readonly timeUs: number;
  readonly value: Value;
}

interface Ends<Value> {
  readonly first: Keyframe<Value>;
  readonly last: Keyframe<Value>;
  readonly times: { readonly t0: number; readonly t1: number };
}

function ends<Value>(keyframes: readonly Keyframe<Value>[]): Ends<Value> {
  const [first, last] = keyframes;
  if (first === undefined || last === undefined || keyframes.length !== 2) {
    throw new Error('Every animation of the reference composition has two keyframes.');
  }
  return { first, last, times: { t0: first.timeUs, t1: last.timeUs } };
}

/** The five animated scalar channels of the reference composition, read from the fixture. */
const channels = ['node-group', 'node-image', 'node-title'].flatMap((id): Channel[] => {
  const node = draftNode(referenceDraft(), id);
  return node.animations.flatMap((item): Channel[] => {
    if (item.property === 'opacity') {
      const { first, last, times } = ends(item.keyframes);
      return [{ base: node.opacity, added: false, a: first.value, b: last.value, ...times }];
    }
    const { first, last, times } = ends(item.keyframes);
    const added = item.property === 'position';
    const base = node[item.property];
    return [
      { base: base.x, added, a: first.value.x, b: last.value.x, ...times },
      { base: base.y, added, a: first.value.y, b: last.value.y, ...times },
    ];
  });
});

/** D16.6 and D18 for those channels, with the order of the interpolation left open. */
const finalValues = (timeUs: number, order: Order): number[] =>
  channels.map(({ base, added, a, b, t0, t1 }) => {
    const sampled = timeUs <= t0 ? a : timeUs >= t1 ? b : order(a, b, timeUs - t0, t1 - t0);
    return added ? base + sampled : base * sampled;
  });

describe('the arithmetic rule (D18)', () => {
  // Wrong orders of the same formula, for the premises below.
  const progressFirst: Order = (a, b, elapsed, span) => a + (b - a) * (elapsed / span);
  const symmetric: Order = (a, b, elapsed, span) => a * (1 - elapsed / span) + b * (elapsed / span);

  it('multiplies before it divides: 49 pixels over 49 µs are exactly 1 pixel after 1 µs', () => {
    expect(progressFirst(0, 49, 1, 49)).toBe(0.999_999_999_999_999_9);
    expect(symmetric(0, 49, 1, 49)).toBe(0.999_999_999_999_999_9);

    const document = derived((draft) => {
      const group = draftNode(draft, 'node-group');
      group.position = { x: 0, y: 0 };
      group.animations = [
        {
          id: 'anim-group-position',
          property: 'position',
          interpolation: 'linear',
          keyframes: [
            { timeUs: 0, value: { x: 0, y: 0 } },
            { timeUs: 49, value: { x: 49, y: -49 } },
          ],
        },
      ];
    });
    const { position } = stateNode(evaluateComposition(document, 1), 'node-group');
    expect(position).toStrictEqual({ x: 1, y: -1 });
  });

  it('is pinned on the frame grid of the reference composition, at frame 61', () => {
    const timeUs = frameToTimeUs(61, fps);
    expect(timeUs).toBe(2_033_333);
    // Exact arithmetic: the offset is 121 999 980 / 7 500 000 = 16.266664, which
    // rounds to 4 578 658 870 560 066 * 2^-48. Adding 60 gives
    // 21 467 157 473 199 426 * 2^-48, an exact tie between two doubles of the
    // binade [64, 128); ties go to even: 5 366 789 368 299 856 * 2^-46.
    const expected = 76.266_663_999_999_99;
    expect(60 + progressFirst(0, 60, timeUs, 7_500_000)).not.toBe(expected);
    expect(60 + symmetric(0, 60, timeUs, 7_500_000)).not.toBe(expected);
    expect(stateNode(evaluateComposition(reference, timeUs), 'node-group').position.x).toBe(
      expected,
    );
  });

  it('is not pinned by the golden timestamps, but by 69 frames of the grid (D18, evidence 1 and 2)', () => {
    const multiplyFirst: Order = (a, b, elapsed, span) => a + ((b - a) * elapsed) / span;
    const differing = (times: readonly number[], order: Order): number[] =>
      times.filter(
        (timeUs) =>
          !isDeepStrictEqual(finalValues(timeUs, order), finalValues(timeUs, multiplyFirst)),
      );

    // The model below is the rule of the runtime, for every frame of the grid.
    expect(channels).toHaveLength(5);
    for (const timeUs of gridTimes) {
      const state = evaluateComposition(reference, timeUs);
      const { position } = stateNode(state, 'node-group');
      const { scale } = stateNode(state, 'node-image');
      const { opacity } = stateNode(state, 'node-title');
      expect([position.x, position.y, scale.x, scale.y, opacity]).toStrictEqual(
        finalValues(timeUs, multiplyFirst),
      );
    }

    expect(differing(goldenTimes, progressFirst)).toEqual([]);
    expect(differing(goldenTimes, symmetric)).toEqual([9_900_000]);
    expect(finalValues(9_900_000, symmetric)).toContain(1.740_000_000_000_000_2);
    expect(differing(gridTimes, progressFirst)).toHaveLength(69);
    // Every channel is pinned on its own: position x and y, scale x and y, opacity.
    const perChannel = channels.map(
      (_, index) =>
        gridTimes.filter(
          (timeUs) =>
            !Object.is(
              finalValues(timeUs, progressFirst)[index],
              finalValues(timeUs, multiplyFirst)[index],
            ),
        ).length,
    );
    expect(perChannel).toEqual([16, 10, 19, 7, 35]);
  });

  it('meets the base value after the interpolation, not inside its endpoints', () => {
    // position: base (3, 3), offsets 1 -> 2, two thirds of the way
    expect(3 + (1 + ((2 - 1) * 2) / 3)).not.toBe(3 + 1 + ((3 + 2 - (3 + 1)) * 2) / 3);
    // scale: base 3, factors 0.25 -> 0.75
    expect(3 * (0.25 + ((0.75 - 0.25) * 2) / 3)).not.toBe(0.75 + ((2.25 - 0.75) * 2) / 3);
    // opacity: base 0.3, factors 0.2 -> 0.8
    expect(0.3 * (0.2 + ((0.8 - 0.2) * 2) / 3)).not.toBe(
      0.3 * 0.2 + ((0.3 * 0.8 - 0.3 * 0.2) * 2) / 3,
    );

    const document = derived((draft) => {
      const title = draftNode(draft, 'node-title');
      title.position = { x: 3, y: 3 };
      title.scale = { x: 3, y: 3 };
      title.opacity = 0.3;
      title.animations = [
        animation('anim-a', 'position', [0, { x: 1, y: 2 }], [3, { x: 2, y: 1 }]),
        animation('anim-b', 'scale', [0, { x: 0.25, y: 0.75 }], [3, { x: 0.75, y: 0.25 }]),
        animation('anim-title-opacity', 'opacity', [0, 0.2], [3, 0.8]),
      ];
    });
    expect(stateNode(evaluateComposition(document, 2), 'node-title')).toStrictEqual({
      id: 'node-title',
      type: 'text',
      position: { x: 3 + (1 + ((2 - 1) * 2) / 3), y: 3 + (2 + ((1 - 2) * 2) / 3) },
      scale: { x: 3 * (0.25 + ((0.75 - 0.25) * 2) / 3), y: 3 * (0.75 + ((0.25 - 0.75) * 2) / 3) },
      opacity: 0.3 * (0.2 + ((0.8 - 0.2) * 2) / 3),
    });
  });
});

describe('sampling (D16.6, D18)', () => {
  it('modifies the base value instead of replacing it', () => {
    const document = derived((draft) => {
      const image = draftNode(draft, 'node-image');
      image.position = { x: 100, y: 200 };
      image.scale = { x: 3, y: 0.5 };
      image.opacity = 0.5;
      image.animations = [
        animation('anim-image-scale', 'scale', [0, { x: 2, y: 2 }], [1_000_000, { x: 4, y: 6 }]),
        animation('anim-a', 'opacity', [0, 0.5], [1_000_000, 1]),
        animation('anim-b', 'position', [0, { x: 7, y: -5 }], [1_000_000, { x: 13, y: 5 }]),
      ];
    });
    expect(stateNode(evaluateComposition(document, 500_000), 'node-image')).toStrictEqual({
      id: 'node-image',
      type: 'image',
      position: { x: 100 + 10, y: 200 + 0 },
      scale: { x: 3 * 3, y: 0.5 * 4 },
      opacity: 0.5 * 0.75,
    });
  });

  it('holds the first value before the first keyframe, even when it is not the identity', () => {
    const document = derived((draft) => {
      const title = draftNode(draft, 'node-title');
      title.animations = [
        animation('anim-a', 'position', [1_000_000, { x: 7, y: -5 }], [2_000_000, { x: 13, y: 5 }]),
        animation('anim-b', 'scale', [1_000_000, { x: 2, y: 3 }], [2_000_000, { x: 4, y: 5 }]),
        animation('anim-title-opacity', 'opacity', [1_000_000, 0.5], [2_000_000, 0.25]),
      ];
    });
    const held = { position: { x: 90 + 7, y: 160 - 5 }, scale: { x: 2, y: 3 }, opacity: 0.5 };
    for (const timeUs of [0, 999_999, 1_000_000]) {
      expect(stateNode(evaluateComposition(document, timeUs), 'node-title')).toMatchObject(held);
    }
    const last = { position: { x: 90 + 13, y: 160 + 5 }, scale: { x: 4, y: 5 }, opacity: 0.25 };
    for (const timeUs of [2_000_000, 2_000_001, durationUs - 1]) {
      expect(stateNode(evaluateComposition(document, timeUs), 'node-title')).toMatchObject(last);
    }
  });

  it('yields exactly the keyframe value on a middle and on a last keyframe', () => {
    // Applying the formula on a keyframe would miss both values, and leave the schema range.
    expect(0 + ((0.1 - 0) * 3) / 3).toBe(0.100_000_000_000_000_02);
    expect(0.1 + ((0 - 0.1) * 3) / 3).toBeLessThan(0);

    const document = derived((draft) => {
      draftNode(draft, 'node-title').animations = [
        animation('anim-title-opacity', 'opacity', [0, 0], [3, 0.1], [6, 0]),
      ];
    });
    const opacityAt = (timeUs: number): number =>
      stateNode(evaluateComposition(document, timeUs), 'node-title').opacity;
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(opacityAt)).toStrictEqual([
      0,
      0 + ((0.1 - 0) * 1) / 3,
      0 + ((0.1 - 0) * 2) / 3,
      0.1,
      0.1 + ((0 - 0.1) * 1) / 3,
      0.1 + ((0 - 0.1) * 2) / 3,
      0,
      0,
    ]);
  });

  it('finds each animation by its property, whatever the order in the document', () => {
    const animations = [
      animation('anim-a', 'position', [0, { x: 1, y: 2 }], [1_000, { x: 3, y: 5 }]),
      animation('anim-b', 'scale', [0, { x: 1, y: 2 }], [1_000, { x: 2, y: 1 }]),
      animation('anim-title-opacity', 'opacity', [0, 0.25], [1_000, 0.75]),
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const states = orders.map((order) => {
      const document = derived((draft) => {
        draftNode(draft, 'node-title').animations = order.flatMap(
          (index) => animations[index] ?? [],
        );
      });
      return stateNode(evaluateComposition(document, 500), 'node-title');
    });
    expect(states[0]).toStrictEqual({
      id: 'node-title',
      type: 'text',
      position: { x: 90 + 2, y: 160 + 3.5 },
      scale: { x: 1 * 1.5, y: 1 * 1.5 },
      opacity: 1 * 0.5,
    });
    for (const state of states) expect(state).toStrictEqual(states[0]);
  });

  it('keeps the values of children local: nothing of the group is folded into them', () => {
    const document = derived((draft) => {
      const group = draftNode(draft, 'node-group');
      group.scale = { x: 3, y: 0.5 };
      group.opacity = 0.5;
      group.animations = [
        ...group.animations,
        animation('anim-a', 'scale', [0, { x: 2, y: 2 }], [7_500_000, { x: 4, y: 4 }]),
        animation('anim-b', 'opacity', [0, 0.5], [7_500_000, 1]),
      ];
    });
    const state = evaluateComposition(document, 5_000_000);
    const plain = evaluateComposition(reference, 5_000_000);
    expect(stateNode(state, 'node-group')).toMatchObject({
      position: { x: 100, y: 620 },
      scale: {
        x: 3 * (2 + ((4 - 2) * 5_000_000) / 7_500_000),
        y: 0.5 * (2 + ((4 - 2) * 5_000_000) / 7_500_000),
      },
      opacity: 0.5 * (0.5 + ((1 - 0.5) * 5_000_000) / 7_500_000),
    });
    for (const id of ['node-image', 'node-caption']) {
      expect(stateNode(state, id)).toStrictEqual(stateNode(plain, id));
    }
  });

  it('samples pairs like scalars: every segment, and the exact value on a keyframe', () => {
    // Coming from the left, the formula would miss the middle keyframe in both channels.
    expect(0 + ((0.1 - 0) * 3) / 3).not.toBe(0.1);
    expect(0.1 + ((0 - 0.1) * 3) / 3).not.toBe(0);

    const document = derived((draft) => {
      draftNode(draft, 'node-title').animations = [
        animation(
          'anim-a',
          'scale',
          [0, { x: 0, y: 0.1 }],
          [3, { x: 0.1, y: 0 }],
          [6, { x: 0, y: 0.1 }],
        ),
        animation(
          'anim-b',
          'position',
          [0, { x: 0, y: 0 }],
          [3, { x: 10, y: -10 }],
          [6, { x: 0, y: 5 }],
        ),
      ];
    });
    const at = (timeUs: number) => {
      const { position, scale } = stateNode(evaluateComposition(document, timeUs), 'node-title');
      return { position, scale };
    };
    expect([1, 3, 4, 6, 7].map(at)).toStrictEqual([
      {
        position: { x: 90 + (0 + ((10 - 0) * 1) / 3), y: 160 + (0 + ((-10 - 0) * 1) / 3) },
        scale: { x: 1 * (0 + ((0.1 - 0) * 1) / 3), y: 1 * (0.1 + ((0 - 0.1) * 1) / 3) },
      },
      { position: { x: 90 + 10, y: 160 - 10 }, scale: { x: 0.1, y: 0 } },
      {
        position: { x: 90 + (10 + ((0 - 10) * 1) / 3), y: 160 + (-10 + ((5 - -10) * 1) / 3) },
        scale: { x: 1 * (0.1 + ((0 - 0.1) * 1) / 3), y: 1 * (0 + ((0.1 - 0) * 1) / 3) },
      },
      { position: { x: 90 + 0, y: 160 + 5 }, scale: { x: 0, y: 0.1 } },
      { position: { x: 90 + 0, y: 160 + 5 }, scale: { x: 0, y: 0.1 } },
    ]);
  });

  it('animates every kind of node: a group, its children, top-level nodes, and Custom HTML', () => {
    const ids = [
      'node-group',
      'node-image',
      'node-caption',
      'node-title',
      'node-custom-html',
      'node-top-image',
    ];
    const document = derived((draft) => {
      const image = draftNode(draft, 'node-image');
      if (image.type !== 'image') throw new Error('node-image is an image.');
      draft.scenes[0]?.nodes.push({ ...structuredClone(image), id: 'node-top-image' });
      ids.forEach((id, index) => {
        draftNode(draft, id).animations = [
          animation(`anim-kind-${String(index)}`, 'opacity', [0, 0], [4, 1]),
        ];
      });
    });
    const state = evaluateComposition(document, 1);
    expect(ids.map((id) => stateNode(state, id).opacity)).toStrictEqual(ids.map(() => 0.25));
  });
});

describe('ranges (D18)', () => {
  it('keeps opacity within 0–1 and scale non-negative for seeded random documents', () => {
    const random = seededRandom(18);
    const integer = (maximum: number): number => Math.floor(random() * (maximum + 1));
    // Edge values often, otherwise three-digit decimals: what people type, and rarely dyadic.
    const decimal = (maximum: number): number =>
      [0, maximum, (integer(1000) / 1000) * maximum][Math.min(integer(6), 2)] ?? 0;
    const keyframeTimes = (): number[] => {
      const times = [integer(1000)];
      for (let count = 1 + integer(2); count > 0; count -= 1) {
        const span = 1 + integer(random() < 0.5 ? 9 : 2_999_999);
        times.push((times.at(-1) ?? 0) + span);
      }
      return times;
    };

    const violations: string[] = [];
    for (let run = 0; run < 200; run += 1) {
      const times = keyframeTimes();
      const document = derived((draft) => {
        const title = draftNode(draft, 'node-title');
        title.opacity = decimal(1);
        title.scale = { x: decimal(1000), y: decimal(1000) };
        title.animations = [
          animation(
            'anim-title-opacity',
            'opacity',
            ...times.map((timeUs): [number, number] => [timeUs, decimal(1)]),
          ),
          animation(
            'anim-a',
            'scale',
            ...times.map((timeUs): [number, { x: number; y: number }] => [
              timeUs,
              { x: decimal(1000), y: decimal(1000) },
            ]),
          ),
        ];
      });
      const samples = [
        ...times.flatMap((timeUs) => [timeUs - 1, timeUs, timeUs + 1]),
        integer(9_999_999),
      ];
      for (const timeUs of samples.filter((sample) => sample >= 0 && sample < durationUs)) {
        const { opacity, scale } = stateNode(evaluateComposition(document, timeUs), 'node-title');
        const inRange = opacity >= 0 && opacity <= 1 && scale.x >= 0 && scale.y >= 0;
        if (!inRange || !Number.isFinite(scale.x + scale.y)) {
          violations.push(
            `run ${String(run)}, timeUs ${String(timeUs)}: ${JSON.stringify({ opacity, scale })}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('input', () => {
  it('is a validated composition; a plain one does not compile (specification Q17)', () => {
    const plain: Composition = reference;
    // @ts-expect-error -- a plain Composition has not passed validateComposition
    expect(evaluateComposition(plain, 0)).toStrictEqual(evaluateComposition(reference, 0));
  });

  // Tests may forge the brand; package sources may not (tests/repo/lint-guardrails.test.ts).
  // The runtime does not validate again (D19.2). It reports exactly these members, which it
  // could otherwise only skip or guess.
  const ramp = animation('anim-title-opacity', 'opacity', [0, 0], [4, 1]);
  it.each<[string, (title: Record<string, unknown>) => void]>([
    [
      'an animation without keyframes',
      (title) => {
        title.animations = [animation('anim-title-opacity', 'opacity')];
      },
    ],
    [
      'an unknown animation property',
      (title) => {
        title.animations = [{ ...ramp, property: 'rotation' }];
      },
    ],
    [
      'an unknown interpolation',
      (title) => {
        title.animations = [{ ...ramp, interpolation: 'step' }];
      },
    ],
    [
      'an interpolation named like a member of Object.prototype',
      (title) => {
        title.animations = [{ ...ramp, interpolation: 'constructor' }];
      },
    ],
    [
      'an unknown node type',
      (title) => {
        title.type = 'video';
      },
    ],
  ])('reports a forged document with %s instead of skipping or guessing', (_, forge) => {
    const draft = referenceDraft();
    forge(draftNode(draft, 'node-title'));
    const forged = draft as unknown as ValidatedComposition;
    // On a keyframe, between keyframes, and on a hold alike: the time does not matter.
    for (const timeUs of [0, 2, 9_000_000]) {
      expect(() => evaluateComposition(forged, timeUs)).toThrow(
        expect.objectContaining({ name: 'EvaluationError', code: 'invalid-document' }),
      );
    }
  });
});
