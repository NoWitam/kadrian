/**
 * Replaces every clock, timer, frame callback, and random source with a function
 * that throws, in the Node.js realm and in the realm of each given window, for
 * the duration of one synchronous call (specification §6.1, D20). Nothing of the
 * test runner runs inside that window; assertions happen after the restore.
 */
import type { DOMWindow } from 'jsdom';

type Target = readonly [target: object, key: string, value: unknown];

const TIMERS = [
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'requestIdleCallback',
] as const;

function trap(name: string): () => never {
  return function trapped(): never {
    throw new Error(`${name} was called while rendering.`);
  };
}

function targetsOf(global: typeof globalThis | DOMWindow, realm: string): Target[] {
  const targets: Target[] = [
    [global.Date, 'now', trap(`${realm} Date.now`)],
    [global.performance, 'now', trap(`${realm} performance.now`)],
    [global.Math, 'random', trap(`${realm} Math.random`)],
    ...TIMERS.map((name): Target => [global, name, trap(`${realm} ${name}`)]),
    [global, 'Date', Object.assign(trap(`${realm} Date`), { now: trap(`${realm} Date.now`) })],
  ];
  const crypto = (global as { crypto?: object }).crypto;
  if (crypto !== undefined) {
    targets.push(
      [crypto, 'getRandomValues', trap(`${realm} crypto.getRandomValues`)],
      [crypto, 'randomUUID', trap(`${realm} crypto.randomUUID`)],
    );
  }
  return targets;
}

/** Everything `withoutClocks` replaces, to prove that it puts all of it back. */
export function patchedDescriptors(windows: readonly DOMWindow[]): unknown[] {
  return [globalThis, ...windows].flatMap((global) =>
    targetsOf(global, '').map(([target, key]) => Object.getOwnPropertyDescriptor(target, key)),
  );
}

export function withoutClocks<Result>(windows: readonly DOMWindow[], run: () => Result): Result {
  const traps = [
    ...targetsOf(globalThis, 'node'),
    [process, 'hrtime', trap('node process.hrtime')] as const,
    ...windows.flatMap((window) => targetsOf(window, 'window')),
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
