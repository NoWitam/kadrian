/**
 * The browser Player (D25): it creates the render page, loads a document into
 * it, and seeks and plays by asking the page for one frame at a time. It decides
 * no pixel — the page and the runtime build do — and owns only the preview
 * clock (D20.2). It never loads anything but the runtime build and the asset
 * bytes the application passes.
 */
import {
  RENDER_PAGE_FRAME_STYLE,
  RENDER_PAGE_SANDBOX,
  renderPageDocument,
  resolveAssets,
  type AssetRequest,
  type AssetResolver,
  type ResolvedAsset,
} from '@kadrion/renderer-dom';
import {
  frameCount,
  frameToTimeUs,
  timeUsToFrame,
  validateComposition,
  type ValidatedComposition,
} from '@kadrion/schema';

import { PAGE_AGENT_SCRIPT } from './agent.js';
import { playerCode, PlayerError } from './errors.js';
import { isReady, LOAD, PROTOCOL_VERSION, readResult, SEEK, type PageFailure } from './protocol.js';

/** The runtime build artifact and the hash the application expects of it (D25.5). */
export interface PlayerRuntime {
  readonly bytes: Uint8Array;
  /** `sha256:` and 64 lowercase hex digits, from the renderer's manifest. */
  readonly contentHash: string;
}

/** An asset of the document, as the Player asks the resolver for it (D14). */
export type PlayerAssetRequest = AssetRequest;

/** The bytes of one asset and their media type, as a resolver returns them. */
export type PlayerAsset = ResolvedAsset;

/**
 * The host-provided resolver of D14: bytes for an asset of the document, or
 * `null` when the host has none. The Player verifies the SHA-256 of the bytes
 * against the asset's `contentHash` before anything is rendered, through
 * `resolveAssets` of `@kadrion/renderer-dom`, which the Producer uses too (D27.3).
 */
export type PlayerAssetResolver = AssetResolver;

/** The preview clock (D25.6): milliseconds and frame callbacks. */
export interface PlayerScheduler {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
}

/** Timers that bound the Player's requests to the page. */
export interface PlayerTimers {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
}

export interface PlayerOptions {
  readonly runtime: PlayerRuntime;
  /** How long the page waits for a Custom HTML acknowledgement (D23.4). */
  readonly ackTimeoutMs?: number;
  /** How long the Player waits for the page's answer to one request. */
  readonly requestTimeoutMs?: number;
  readonly scheduler?: PlayerScheduler;
  readonly timers?: PlayerTimers;
}

export type PlayerStatus = 'empty' | 'loading' | 'seeking' | 'ready' | 'playing' | 'error';

export interface PlayerState {
  readonly status: PlayerStatus;
  /** The time of the last frame that became ready, or `null` before the first. */
  readonly timeUs: number | null;
  /** The verified content hash of the runtime build that the page runs (D25.5). */
  readonly runtimeHash: string;
  readonly error: PlayerError | null;
}

export interface Player {
  load(document: unknown, resolveAsset: PlayerAssetResolver): Promise<void>;
  seek(timeUs: number): Promise<void>;
  play(): void;
  pause(): void;
  getState(): PlayerState;
  destroy(): void;
}

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0'));
  return `sha256:${hex.join('')}`;
}

/** Integrity of the runtime build (D25.5): its hash, UTF-8, and one script element. */
async function runtimeScript(runtime: PlayerRuntime): Promise<string> {
  if (!CONTENT_HASH.test(runtime.contentHash)) {
    throw new PlayerError('runtime-hash-mismatch', 'The expected content hash is malformed.');
  }
  const actual = await sha256(runtime.bytes);
  if (actual !== runtime.contentHash) {
    throw new PlayerError(
      'runtime-hash-mismatch',
      `The runtime build has ${actual}, not ${runtime.contentHash}.`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(runtime.bytes);
  } catch {
    throw new PlayerError('runtime-unsafe', 'The runtime build is not UTF-8.');
  }
}

function pageDocument(script: string): string {
  try {
    return renderPageDocument([script, PAGE_AGENT_SCRIPT]);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new PlayerError('runtime-unsafe', message);
  }
}

function failureError(failure: PageFailure): PlayerError {
  return new PlayerError(playerCode(failure.code), failure.message, failure.details);
}

interface AssetMessage {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: ArrayBuffer;
}

/**
 * Resolves and verifies every asset of the document (D14, D27.3): a missing
 * asset or a mismatch is a typed error before the first frame. Only declared
 * assets are asked for, so nothing else reaches the page.
 */
async function assetMessages(
  composition: ValidatedComposition,
  resolveAsset: PlayerAssetResolver,
): Promise<AssetMessage[]> {
  try {
    const verified = await resolveAssets(composition, resolveAsset, sha256);
    return verified.map(({ id, mediaType, bytes }) => ({
      id,
      mediaType,
      bytes: bytes.buffer as ArrayBuffer,
    }));
  } catch (reason) {
    const code = (reason as { code?: unknown } | null)?.code;
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new PlayerError(typeof code === 'string' ? playerCode(code) : 'page-error', message);
  }
}

interface Waiting {
  readonly timeUs: number;
  readonly resolve: () => void;
  readonly reject: (error: PlayerError) => void;
}

interface Pending {
  readonly requestId: number;
  readonly settle: (error: PlayerError | null) => void;
}

/**
 * Creates the render page in `container` and resolves once it runs the verified
 * runtime build and has reported that it is ready.
 */
export async function createPlayer(
  container: HTMLElement,
  options: PlayerOptions,
): Promise<Player> {
  const view = container.ownerDocument.defaultView;
  if (view === null) throw new PlayerError('page-error', 'The container has no window.');
  const script = await runtimeScript(options.runtime);
  const runtimeHash = options.runtime.contentHash;
  const srcdoc = pageDocument(script);
  const ackTimeoutMs = options.ackTimeoutMs ?? 2_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const timers: PlayerTimers = options.timers ?? {
    setTimeout: (callback, milliseconds) => view.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => {
      view.clearTimeout(handle);
    },
  };
  const scheduler: PlayerScheduler = options.scheduler ?? {
    now: () => view.performance.now(),
    requestFrame: (callback) => view.requestAnimationFrame(callback),
    cancelFrame: (handle) => {
      view.cancelAnimationFrame(handle);
    },
  };

  const frame = container.ownerDocument.createElement('iframe');
  // Sandbox first, both before the frame is attached (D25.2, as D23.1).
  frame.setAttribute('sandbox', RENDER_PAGE_SANDBOX);
  frame.setAttribute('srcdoc', srcdoc);
  for (const [name, value] of Object.entries(RENDER_PAGE_FRAME_STYLE)) {
    frame.style.setProperty(name, value);
  }
  frame.style.setProperty('width', '0px');
  frame.style.setProperty('height', '0px');

  let status: PlayerStatus = 'empty';
  let timeUs: number | null = null;
  let error: PlayerError | null = null;
  let composition: ValidatedComposition | null = null;
  let nextRequestId = 1;
  let pending: Pending | null = null;
  let seeking = false;
  let waiting: Waiting | null = null;
  let playing: { readonly startNow: number; readonly startUs: number; handle: number } | null =
    null;
  let destroyed = false;
  /** The seek that is in flight, settled either way; a load waits for it (D25.4). */
  let inFlight: Promise<void> = Promise.resolve();
  let readyPage: ((error: PlayerError | null) => void) | null = null;

  const onMessage = (event: MessageEvent): void => {
    // Only the page's own window speaks for the page (D25.4).
    if (event.source === null || event.source !== frame.contentWindow) return;
    if (readyPage !== null && isReady(event.data)) {
      const settle = readyPage;
      readyPage = null;
      settle(null);
      return;
    }
    const result = readResult(event.data);
    if (result === undefined || pending === null || result.requestId !== pending.requestId) return;
    const { settle } = pending;
    pending = null;
    settle(result.error === null ? null : failureError(result.error));
  };
  view.addEventListener('message', onMessage);

  /** Sends one request and waits for its result, bounded by the request timeout. */
  const request = (message: Record<string, unknown>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (destroyed) {
        reject(new PlayerError('destroyed', 'The Player was destroyed.'));
        return;
      }
      if (pending !== null) {
        // Never happens: requests are sent one at a time. Refuse rather than lose one.
        reject(new PlayerError('page-error', 'A request is already pending.'));
        return;
      }
      const requestId = message.requestId as number;
      const handle = timers.setTimeout(() => {
        if (pending?.requestId !== requestId) return;
        pending = null;
        reject(new PlayerError('page-timeout', 'The render page did not answer in time.'));
      }, requestTimeoutMs);
      pending = {
        requestId,
        settle: (failure) => {
          timers.clearTimeout(handle);
          if (failure === null) resolve();
          else reject(failure);
        },
      };
      frame.contentWindow?.postMessage(message, '*');
    });

  const fail = (reason: unknown): PlayerError => {
    const failure =
      reason instanceof PlayerError
        ? reason
        : new PlayerError('page-error', reason instanceof Error ? reason.message : String(reason));
    status = 'error';
    error = failure;
    return failure;
  };

  const settledStatus = (): PlayerStatus => (playing !== null ? 'playing' : 'ready');

  const startSeek = (target: number, done: Waiting | null): void => {
    seeking = true;
    status = 'seeking';
    const requestId = nextRequestId++;
    const sent = request({ type: SEEK, version: PROTOCOL_VERSION, requestId, timeUs: target });
    inFlight = sent.then(
      () => undefined,
      () => undefined,
    );
    sent.then(
      () => {
        seeking = false;
        timeUs = target;
        error = null;
        done?.resolve();
        next();
      },
      (reason: unknown) => {
        seeking = false;
        const failure = fail(reason);
        stopClock();
        done?.reject(failure);
        next();
      },
    );
  };

  /** After a seek: start the one that waits, or settle the status. */
  const next = (): void => {
    if (waiting !== null) {
      const queued = waiting;
      waiting = null;
      startSeek(queued.timeUs, queued);
      return;
    }
    if (error === null) status = settledStatus();
  };

  const checkedTime = (target: number): number => {
    if (composition === null) throw new PlayerError('not-loaded', 'No document is loaded.');
    if (!Number.isSafeInteger(target) || target < 0 || target >= composition.durationUs) {
      throw new PlayerError(
        'time-out-of-range',
        `timeUs must be an integer in [0, ${String(composition.durationUs)}), got ${String(target)}.`,
      );
    }
    return target;
  };

  const seek = (target: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const checked = checkedTime(target);
      if (!seeking) {
        startSeek(checked, { timeUs: checked, resolve, reject });
        return;
      }
      // One seek at a time; a newer one supersedes the one that waits (D25.6).
      waiting?.reject(new PlayerError('superseded', 'A newer seek replaced this one.'));
      waiting = { timeUs: checked, resolve, reject };
    });

  const stopClock = (): void => {
    if (playing !== null) scheduler.cancelFrame(playing.handle);
    playing = null;
  };

  const tick = (): void => {
    if (playing === null || composition === null) return;
    const { fps, durationUs } = composition;
    const last = frameCount(durationUs, fps) - 1;
    const elapsedUs = Math.max(0, Math.round((scheduler.now() - playing.startNow) * 1_000));
    const index = Math.min(timeUsToFrame(playing.startUs + elapsedUs, fps), last);
    const target = frameToTimeUs(index, fps);
    if (!seeking && target !== timeUs) {
      // Skipped while a seek is in flight, so requests never pile up (D25.6).
      startSeek(target, null);
    }
    if (index === last) {
      stopClock();
      return;
    }
    playing.handle = scheduler.requestFrame(tick);
  };

  const player: Player = {
    async load(document, resolveAsset) {
      // Serialised once and validated as parsed, so that the page renders exactly
      // the document whose frame grid the Player uses (no getter, no toJSON).
      let text: string | undefined;
      try {
        text = JSON.stringify(document);
      } catch {
        text = undefined;
      }
      const result = validateComposition(text === undefined ? undefined : JSON.parse(text));
      if (text === undefined || !result.ok) {
        const details = result.ok
          ? []
          : result.errors.map(({ path, message }) => `${path}: ${message}`);
        throw fail(new PlayerError('invalid-document', 'The document is not valid.', details));
      }
      const loaded = result.composition;
      stopClock();
      waiting?.reject(new PlayerError('superseded', 'A new document was loaded.'));
      waiting = null;
      status = 'loading';
      composition = null;
      timeUs = null;
      // A seek that is still in flight finishes first; the page takes one request at a time.
      await inFlight;
      try {
        const assets = await assetMessages(loaded, resolveAsset);
        frame.style.setProperty('width', `${String(loaded.width)}px`);
        frame.style.setProperty('height', `${String(loaded.height)}px`);
        await request({
          type: LOAD,
          version: PROTOCOL_VERSION,
          requestId: nextRequestId++,
          document: text,
          assets,
          ackTimeoutMs,
        });
      } catch (reason) {
        throw fail(reason);
      }
      composition = loaded;
      await seek(0);
    },
    seek,
    play() {
      if (composition === null || playing !== null) return;
      const { fps, durationUs } = composition;
      const last = frameToTimeUs(frameCount(durationUs, fps) - 1, fps);
      const startUs = timeUs === null || timeUs >= last ? 0 : timeUs;
      playing = { startNow: scheduler.now(), startUs, handle: 0 };
      if (!seeking && error === null) status = 'playing';
      playing.handle = scheduler.requestFrame(tick);
    },
    pause() {
      stopClock();
      if (!seeking && error === null && status === 'playing') status = 'ready';
    },
    getState() {
      return Object.freeze({ status, timeUs, runtimeHash, error });
    },
    destroy() {
      destroyed = true;
      stopClock();
      view.removeEventListener('message', onMessage);
      const gone = new PlayerError('destroyed', 'The Player was destroyed.');
      waiting?.reject(gone);
      waiting = null;
      pending?.settle(gone);
      pending = null;
      readyPage?.(gone);
      readyPage = null;
      frame.remove();
    },
  };

  const pageReady = new Promise<void>((resolve, reject) => {
    const handle = timers.setTimeout(() => {
      if (readyPage === null) return;
      readyPage = null;
      reject(new PlayerError('page-timeout', 'The render page did not start in time.'));
    }, requestTimeoutMs);
    readyPage = (failure) => {
      timers.clearTimeout(handle);
      if (failure === null) resolve();
      else reject(failure);
    };
  });
  container.append(frame);
  try {
    await pageReady;
  } catch (reason) {
    player.destroy();
    throw reason;
  }
  return player;
}
