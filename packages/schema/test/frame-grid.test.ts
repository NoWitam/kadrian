import { goldenTimestamps } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { frameCount, frameToTimeUs, timeUsToFrame } from '../src/index.js';

const FPS = 30;
const DURATION_US = 10_000_000;
const FRAMES = Array.from({ length: 300 }, (_, frame) => frame);

describe('frame grid of the reference composition (D13)', () => {
  it('has 300 frames; the last one samples 9 966 666 µs and the end is exclusive', () => {
    expect(frameCount(DURATION_US, FPS)).toBe(300);
    expect(frameToTimeUs(299, FPS)).toBe(9_966_666);
    expect(frameToTimeUs(300, FPS)).toBe(DURATION_US);
    expect(FRAMES.slice(0, 4).map((frame) => frameToTimeUs(frame, FPS))).toEqual([
      0, 33_333, 66_666, 100_000,
    ]);
  });

  it('round-trips every frame', () => {
    expect(FRAMES.map((frame) => timeUsToFrame(frameToTimeUs(frame, FPS), FPS))).toEqual(FRAMES);
  });

  it('is strictly increasing', () => {
    const times = FRAMES.map((frame) => frameToTimeUs(frame, FPS));
    expect(times.every((time, frame) => frame === 0 || time > (times[frame - 1] ?? time))).toBe(
      true,
    );
  });

  it('maps both ends of every frame interval to that frame', () => {
    // timeUsToFrame is monotonic, so the two ends decide every instant between them.
    const first = FRAMES.map((frame) => timeUsToFrame(frameToTimeUs(frame, FPS), FPS));
    const last = FRAMES.map((frame) => timeUsToFrame(frameToTimeUs(frame + 1, FPS) - 1, FPS));
    expect(first).toEqual(FRAMES);
    expect(last).toEqual(FRAMES);
  });

  it('brackets every instant of the first 200 000 µs, two full periods of the grid', () => {
    const wrong: number[] = [];
    for (let timeUs = 0; timeUs < 200_000; timeUs += 1) {
      const frame = timeUsToFrame(timeUs, FPS);
      const isBracketed =
        frameToTimeUs(frame, FPS) <= timeUs && timeUs < frameToTimeUs(frame + 1, FPS);
      if (!isBracketed) wrong.push(timeUs);
    }
    expect(wrong).toEqual([]);
  });

  it('puts every golden timestamp on the grid, as specification §3.3 lists them', () => {
    for (const { timeUs, frame } of goldenTimestamps) {
      expect(timeUsToFrame(timeUs, FPS)).toBe(frame);
      expect(frameToTimeUs(frame, FPS)).toBe(timeUs);
    }
    expect(goldenTimestamps.map(({ timeUs }) => timeUs)).toEqual([
      0, 2_500_000, 5_000_000, 7_500_000, 9_900_000,
    ]);
  });

  it('cannot be replaced by the naive inverse, which is wrong for 200 of the 300 frames', () => {
    const naive = (timeUs: number): number => Math.floor((timeUs * FPS) / 1_000_000);
    expect(FRAMES.filter((frame) => naive(frameToTimeUs(frame, FPS)) !== frame)).toHaveLength(200);
  });
});

describe('frame grid for every frame rate that schema 0.1 accepts', () => {
  const rates = Array.from({ length: 120 }, (_, index) => index + 1);

  it.each([1, 24, 25, 30, 50, 60, 120])('holds all properties at %i fps', (fps) => {
    const count = frameCount(DURATION_US, fps);
    expect(count).toBe(timeUsToFrame(DURATION_US - 1, fps) + 1);
    for (let frame = 0; frame < count; frame += 1) {
      const start = frameToTimeUs(frame, fps);
      const end = frameToTimeUs(frame + 1, fps);
      expect(end).toBeGreaterThan(start);
      expect(timeUsToFrame(start, fps)).toBe(frame);
      expect(timeUsToFrame(end - 1, fps)).toBe(frame);
    }
  });

  it('round-trips the first second at every rate from 1 to 120', () => {
    const broken = rates.filter((fps) =>
      Array.from({ length: fps }, (_, frame) => frame).some(
        (frame) => timeUsToFrame(frameToTimeUs(frame, fps), fps) !== frame,
      ),
    );
    expect(broken).toEqual([]);
  });

  it('counts frames as ceil(durationUs * fps / 1_000_000)', () => {
    expect(frameCount(1, FPS)).toBe(1);
    expect(frameCount(33_333, FPS)).toBe(1);
    expect(frameCount(33_334, FPS)).toBe(2);
    expect(frameCount(1_000_000, 1)).toBe(1);
    expect(frameCount(1_000_001, 1)).toBe(2);
  });
});

describe('frame grid domain', () => {
  it('stays exact at the top of the safe integer range', () => {
    const lastFrame = timeUsToFrame(Number.MAX_SAFE_INTEGER, FPS);
    expect(frameToTimeUs(lastFrame, FPS)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(timeUsToFrame(frameToTimeUs(lastFrame, FPS), FPS)).toBe(lastFrame);
    expect(timeUsToFrame(frameToTimeUs(lastFrame - 1, FPS), FPS)).toBe(lastFrame - 1);
  });

  it('is strictly increasing up to 1 000 000 fps and rejects anything above', () => {
    expect(frameToTimeUs(1, 1_000_000)).toBe(1);
    expect(() => frameToTimeUs(1, 1_000_001)).toThrow(RangeError);
  });

  it.each([
    ['a fractional frame', () => frameToTimeUs(1.5, FPS)],
    ['a negative frame', () => frameToTimeUs(-1, FPS)],
    ['a fractional time', () => timeUsToFrame(0.5, FPS)],
    ['a negative time', () => timeUsToFrame(-1, FPS)],
    ['an unsafe time', () => timeUsToFrame(2 ** 53, FPS)],
    ['a time that is not a number', () => timeUsToFrame(Number.NaN, FPS)],
    ['a fractional frame rate', () => frameToTimeUs(1, 29.97)],
    ['a zero frame rate', () => timeUsToFrame(0, 0)],
    ['a zero duration', () => frameCount(0, FPS)],
    ['a result beyond the safe integer range', () => frameToTimeUs(Number.MAX_SAFE_INTEGER, 1)],
  ])('rejects %s', (_name, call) => {
    expect(call).toThrow(RangeError);
  });
});
