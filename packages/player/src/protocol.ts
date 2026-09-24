/**
 * The Player ↔ render page protocol, version 1 (D25.4), as the Player sees it.
 * The page side is `agent.ts`, which must stay self-contained and therefore
 * repeats its half of these rules.
 */
export const PROTOCOL_VERSION = 1;

export const READY = 'kadrion-player:ready';
export const LOAD = 'kadrion-player:load';
export const SEEK = 'kadrion-player:seek';
export const RESULT = 'kadrion-player:result';

/** What the page reports for one request. */
export interface PageFailure {
  readonly code: string;
  readonly message: string;
  readonly details: readonly string[];
}

export interface PageResult {
  readonly requestId: number;
  readonly error: PageFailure | null;
}

/** An object whose own keys are exactly `keys`; the prototype is not compared (realms). */
export function hasExactly(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    })
  );
}

/** A non-negative safe integer: request IDs, times, and timeouts. */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isReady(data: unknown): boolean {
  return (
    hasExactly(data, ['type', 'version']) &&
    data.type === READY &&
    data.version === PROTOCOL_VERSION
  );
}

function isFailure(value: unknown): value is PageFailure {
  return (
    hasExactly(value, ['code', 'message', 'details']) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    Array.isArray(value.details) &&
    value.details.every((detail) => typeof detail === 'string')
  );
}

/** A result message of the page, or `undefined` for anything else. */
export function readResult(data: unknown): PageResult | undefined {
  if (
    !hasExactly(data, ['type', 'version', 'requestId', 'ok', 'error']) ||
    data.type !== RESULT ||
    data.version !== PROTOCOL_VERSION ||
    !isCount(data.requestId)
  ) {
    return undefined;
  }
  if (data.ok === true && data.error === null) return { requestId: data.requestId, error: null };
  if (data.ok === false && isFailure(data.error)) {
    const { code, message, details } = data.error;
    return { requestId: data.requestId, error: { code, message, details: [...details] } };
  }
  return undefined;
}
