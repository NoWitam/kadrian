/**
 * The frame grid (D13): the one mapping between frame indices and `timeUs`,
 * shared by the Player's frame stepping and the Producer. These functions
 * define what the document fields `fps` and `durationUs` mean; they evaluate
 * no composition state.
 *
 * `BigInt` keeps the arithmetic exact over the whole safe-integer range.
 */

const MICROSECONDS_PER_SECOND = 1_000_000n;

/** Above this rate two frames would share one microsecond. */
const MAX_FPS = 1_000_000;

function toBigInt(name: string, value: number, minimum: number, maximum: number): bigint {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const range = `${String(minimum)} to ${String(maximum)}`;
    throw new RangeError(`${name} must be an integer from ${range}, got ${String(value)}.`);
  }
  return BigInt(value);
}

function toSafeNumber(name: string, value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} exceeds the safe integer range.`);
  }
  return Number(value);
}

/** `floor(frame * 1_000_000 / fps)`: the instant that a frame samples. */
export function frameToTimeUs(frame: number, fps: number): number {
  const frames = toBigInt('frame', frame, 0, Number.MAX_SAFE_INTEGER);
  const rate = toBigInt('fps', fps, 1, MAX_FPS);
  return toSafeNumber('timeUs', (frames * MICROSECONDS_PER_SECOND) / rate);
}

/** The largest frame with `frameToTimeUs(frame) <= timeUs`: the frame shown at an instant. */
export function timeUsToFrame(timeUs: number, fps: number): number {
  const time = toBigInt('timeUs', timeUs, 0, Number.MAX_SAFE_INTEGER);
  const rate = toBigInt('fps', fps, 1, MAX_FPS);
  return toSafeNumber('frame', ((time + 1n) * rate - 1n) / MICROSECONDS_PER_SECOND);
}

/** `ceil(durationUs * fps / 1_000_000)`: frames that start before the exclusive end. */
export function frameCount(durationUs: number, fps: number): number {
  const duration = toBigInt('durationUs', durationUs, 1, Number.MAX_SAFE_INTEGER);
  const rate = toBigInt('fps', fps, 1, MAX_FPS);
  return toSafeNumber('frame count', (duration * rate - 1n) / MICROSECONDS_PER_SECOND + 1n);
}
