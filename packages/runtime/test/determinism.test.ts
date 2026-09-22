/**
 * Specification §6.1 at the level of the evaluation core: the state depends on
 * `(composition, timeUs)` and on nothing else — not on earlier calls, not on the
 * order of calls, not on a clock, and the document is only ever read.
 */
import { frameCount, frameToTimeUs, type ValidatedComposition } from '@kadrion/schema';
import {
  goldenTimestamps,
  referenceComposition,
  referenceExpectedStates,
} from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { evaluateComposition, type CompositionState } from '../src/index.js';
import {
  derived,
  draftNode,
  reference,
  referenceDraft,
  shuffled,
  stateNode,
  validated,
} from './support.js';

const SEED = 20_260_921;

const goldenTimes = goldenTimestamps.map((golden) => golden.timeUs);
const goldenStates = new Map(
  referenceExpectedStates.golden.map((golden) => [golden.timeUs, golden.state]),
);
const gridTimes = Array.from(
  { length: frameCount(reference.durationUs, reference.fps) },
  (_, frame) => frameToTimeUs(frame, reference.fps),
);

/** Evaluates in the given order and reports the states in ascending order of time. */
function evaluatedInOrder(
  composition: ValidatedComposition,
  order: readonly number[],
): [number, CompositionState][] {
  const states = order.map((timeUs): [number, CompositionState] => [
    timeUs,
    evaluateComposition(composition, timeUs),
  ]);
  return states.sort(([a], [b]) => a - b);
}

/** Every object and array reachable from a value, the value itself included. */
function everyObject(value: unknown): object[] {
  if (typeof value !== 'object' || value === null) return [];
  return [value, ...Object.values(value).flatMap((child) => everyObject(child))];
}

// A document with more than one segment per animation, which the reference lacks:
// only here could a cached segment cursor or a playback assumption go stale.
const MID = 4_000_000;
const END = 8_000_000;
const threeKeyframes = derived((draft) => {
  draftNode(draft, 'node-title').animations = [
    {
      id: 'anim-title-opacity',
      property: 'opacity',
      interpolation: 'linear',
      keyframes: [
        { timeUs: 0, value: 0 },
        { timeUs: MID, value: 1 },
        { timeUs: END, value: 0.5 },
      ],
    },
  ];
});

/** The rule of D18 spelled out for that one channel; the base opacity is 1. */
function expectedTitleOpacity(timeUs: number): number {
  if (timeUs <= 0) return 0;
  if (timeUs < MID) return 0 + ((1 - 0) * (timeUs - 0)) / (MID - 0);
  if (timeUs === MID) return 1;
  if (timeUs < END) return 1 + ((0.5 - 1) * (timeUs - MID)) / (END - MID);
  return 0.5;
}

const jumps = [MID + 1, MID - 1, MID, 0, MID + 1, END - 1, MID - 1, END, 9_999_999, 1, MID];

describe('repeatability', () => {
  it.each(goldenTimestamps)('yields the same, freshly built state at $timeUs', ({ timeUs }) => {
    const [first, second, third] = [1, 2, 3].map(() => evaluateComposition(reference, timeUs));
    expect(first).toStrictEqual(goldenStates.get(timeUs));
    expect(second).toStrictEqual(first);
    expect(third).toStrictEqual(first);
    expect(second).not.toBe(first);
  });
});

describe('order independence', () => {
  const orders = (times: readonly number[]) => ({
    ascending: [...times],
    descending: [...times].reverse(),
    shuffled: shuffled(times, SEED),
  });

  it('uses three orders that really differ', () => {
    for (const times of [goldenTimes, gridTimes]) {
      const { ascending, descending, shuffled: mixed } = orders(times);
      expect(mixed).not.toEqual(ascending);
      expect(mixed).not.toEqual(descending);
      expect([...mixed].sort((a, b) => a - b)).toEqual(ascending);
    }
  });

  it.each(['ascending', 'descending', 'shuffled'] as const)(
    'yields the hand-derived golden states in %s order',
    (order) => {
      expect(evaluatedInOrder(reference, orders(goldenTimes)[order])).toStrictEqual(
        goldenTimes.map((timeUs) => [timeUs, goldenStates.get(timeUs)]),
      );
    },
  );

  it('yields the same state for each of the 300 grid frames in every order', () => {
    const { ascending, descending, shuffled: mixed } = orders(gridTimes);
    const expected = evaluatedInOrder(reference, ascending);
    expect(expected).toHaveLength(300);
    expect(evaluatedInOrder(reference, descending)).toStrictEqual(expected);
    expect(evaluatedInOrder(reference, mixed)).toStrictEqual(expected);
  });

  it('survives jumps back and forth across a middle keyframe', () => {
    for (const timeUs of jumps) {
      const state = evaluateComposition(threeKeyframes, timeUs);
      expect(stateNode(state, 'node-title').opacity, String(timeUs)).toBe(
        expectedTitleOpacity(timeUs),
      );
    }
  });

  it('keeps two compositions apart when their evaluations interleave', () => {
    jumps.forEach((timeUs, index) => {
      const goldenTime = goldenTimes[index % goldenTimes.length] ?? 0;
      expect(evaluateComposition(reference, goldenTime)).toStrictEqual(
        goldenStates.get(goldenTime),
      );
      const state = evaluateComposition(threeKeyframes, timeUs);
      expect(stateNode(state, 'node-title').opacity, String(timeUs)).toBe(
        expectedTitleOpacity(timeUs),
      );
    });
  });
});

/**
 * Replaces every clock, timer, frame callback, and random source with a
 * function that throws, for the duration of one synchronous call. Nothing of
 * the test runner runs inside that window; assertions happen after the restore.
 */
function withoutClocks<Result>(run: () => Result): Result {
  const trap = (name: string) =>
    function trapped(): never {
      throw new Error(`${name} was called during evaluation.`);
    };
  const traps: readonly (readonly [target: object, key: string, value: unknown])[] = [
    [Date, 'now', trap('Date.now')],
    [performance, 'now', trap('performance.now')],
    [Math, 'random', trap('Math.random')],
    [crypto, 'getRandomValues', trap('crypto.getRandomValues')],
    [crypto, 'randomUUID', trap('crypto.randomUUID')],
    [process, 'hrtime', trap('process.hrtime')],
    [globalThis, 'setTimeout', trap('setTimeout')],
    [globalThis, 'setInterval', trap('setInterval')],
    [globalThis, 'setImmediate', trap('setImmediate')],
    [globalThis, 'requestAnimationFrame', trap('requestAnimationFrame')],
    [globalThis, 'Date', Object.assign(trap('Date'), { now: trap('Date.now') })],
  ];
  const saved = traps.map(
    ([target, key]) => [target, key, Object.getOwnPropertyDescriptor(target, key)] as const,
  );
  try {
    for (const [target, key, value] of traps) {
      Object.defineProperty(target, key, { configurable: true, writable: true, value });
    }
    return run();
  } finally {
    for (const [target, key, descriptor] of saved.reverse()) {
      if (descriptor === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, descriptor);
    }
  }
}

describe('clock independence', () => {
  const probes: readonly (readonly [name: string, probe: () => unknown])[] = [
    ['Date.now', () => Date.now()],
    ['Date', () => new Date()],
    ['performance.now', () => performance.now()],
    ['Math.random', () => Math.random()],
    ['crypto.getRandomValues', () => crypto.getRandomValues(new Uint8Array(1))],
    ['crypto.randomUUID', () => crypto.randomUUID()],
    ['process.hrtime', () => process.hrtime()],
    ['setTimeout', () => setTimeout(() => undefined, 0)],
    ['setInterval', () => setInterval(() => undefined, 1_000)],
    ['setImmediate', () => setImmediate(() => undefined)],
    [
      'requestAnimationFrame',
      () => (Reflect.get(globalThis, 'requestAnimationFrame') as () => unknown)(),
    ],
  ];

  /** Everything `withoutClocks` replaces, to prove that it puts all of it back. */
  const patched = (): unknown[] => [
    Object.getOwnPropertyDescriptor(Date, 'now'),
    Object.getOwnPropertyDescriptor(performance, 'now'),
    Object.getOwnPropertyDescriptor(Math, 'random'),
    Object.getOwnPropertyDescriptor(crypto, 'getRandomValues'),
    Object.getOwnPropertyDescriptor(crypto, 'randomUUID'),
    Object.getOwnPropertyDescriptor(process, 'hrtime'),
    ...['setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame', 'Date'].map((key) =>
      Object.getOwnPropertyDescriptor(globalThis, key),
    ),
  ];

  it.each(probes)('the harness really traps %s, and restores it', (name, probe) => {
    const before = patched();
    expect(() => withoutClocks(probe)).toThrow(`${name} was called during evaluation.`);
    expect(patched()).toEqual(before);
    expect(Date.now()).toBeTypeOf('number');
  });

  it('evaluates the golden timestamps while every clock, timer, and random source throws', () => {
    const states = withoutClocks(() =>
      goldenTimes.map((timeUs) => evaluateComposition(reference, timeUs)),
    );
    expect(states).toStrictEqual(goldenTimes.map((timeUs) => goldenStates.get(timeUs)));
  });

  it('evaluates a multi-segment document and the whole frame grid under the same conditions', () => {
    const opacities = withoutClocks(() =>
      jumps.map(
        (timeUs) => stateNode(evaluateComposition(threeKeyframes, timeUs), 'node-title').opacity,
      ),
    );
    expect(opacities).toStrictEqual(jumps.map((timeUs) => expectedTitleOpacity(timeUs)));

    const grid = withoutClocks(() => evaluatedInOrder(reference, gridTimes));
    expect(grid).toStrictEqual(evaluatedInOrder(reference, gridTimes));
  });
});

describe('the document is read, never written', () => {
  it('evaluates the deeply frozen fixture, where a write would throw', () => {
    expect(everyObject(reference).every((object) => Object.isFrozen(object))).toBe(true);
    const before = JSON.stringify(reference);
    for (const timeUs of gridTimes) evaluateComposition(reference, timeUs);
    expect(JSON.stringify(reference)).toBe(before);
  });

  it('leaves a document that is not frozen untouched as well', () => {
    const document = validated(structuredClone(referenceComposition));
    expect(Object.isFrozen(document)).toBe(false);
    for (const timeUs of gridTimes) evaluateComposition(document, timeUs);
    expect(document).toStrictEqual(referenceComposition);
  });

  it('builds a state that shares no object with the document', () => {
    const document = validated(structuredClone(referenceComposition));
    const documentObjects = new Set(everyObject(document));
    // Holds, keyframe hits, and interpolated times: each returns values another way.
    for (const timeUs of [...goldenTimes, 1, 9_999_999]) {
      const shared = everyObject(evaluateComposition(document, timeUs)).filter((object) =>
        documentObjects.has(object),
      );
      expect(shared, String(timeUs)).toEqual([]);
    }
  });

  it('hands out a fresh state: damaging one does not reach the next evaluation', () => {
    const damaged = evaluateComposition(reference, 5_000_000);
    for (const object of everyObject(damaged)) {
      for (const key of Object.keys(object)) expect(Reflect.set(object, key, 'damaged')).toBe(true);
    }
    expect(evaluateComposition(reference, 5_000_000)).toStrictEqual(goldenStates.get(5_000_000));
  });

  it('builds every state from fresh, unfrozen objects, down to the last pair of values', () => {
    const first = everyObject(evaluateComposition(reference, 5_000_000));
    const second = new Set(everyObject(evaluateComposition(reference, 5_000_000)));
    expect(first.length).toBeGreaterThan(10);
    expect(first.filter((object) => second.has(object))).toEqual([]);
    expect(first.filter((object) => Object.isFrozen(object))).toEqual([]);
  });

  // D19.1: no cache. A memo keyed by the identity of the document would pass every other test.
  it('keeps nothing between calls: a document changed in place yields the new state', () => {
    const draft = referenceDraft();
    const document = validated(draft);
    expect(document).toBe(draft);
    const before = evaluateComposition(document, 5_000_000);
    draftNode(draft, 'node-title').position.x = 91; // still a valid document
    const after = evaluateComposition(document, 5_000_000);
    expect(stateNode(before, 'node-title').position.x).toBe(90);
    expect(stateNode(after, 'node-title').position.x).toBe(91);
  });
});
