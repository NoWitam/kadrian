/**
 * Test doubles for the Custom HTML time contract (D23). jsdom neither loads
 * `srcdoc` nor isolates a frame, and its `postMessage` schedules delivery with
 * the Node.js `setTimeout` and does not clone. So the element is played by a
 * double: it replaces `postMessage` of the frame's window, records every message
 * the renderer posts, and answers on the host window exactly when the test says
 * so, with the source and origin a real sandboxed frame would have. The timer is
 * the host's, and here it expires only when the test says so. Nothing here is
 * part of the package.
 */
import type { DOMWindow } from 'jsdom';

import type { CustomHtmlHost, MessageListener } from '../src/index.js';

export interface Posted {
  readonly message: unknown;
  readonly targetOrigin: unknown;
}

/** One Custom HTML element, played by the test. */
export interface ElementDouble {
  /** The window that a real frame's answers would come from. */
  readonly source: Window;
  /** Every message the renderer posted to this element, in order. */
  readonly posted: Posted[];
  /**
   * An answer as a sandboxed frame would send it, unless `options` says
   * otherwise. jsdom reads the clock when it constructs an event (`timeStamp`),
   * not when it dispatches one, so a clock test builds its events beforehand.
   */
  event(data: unknown, options?: AnswerOptions): MessageEvent;
  /** Dispatches an answer on the host window. */
  dispatch(event: MessageEvent): void;
  /** `dispatch(event(data, options))`. */
  answer(data: unknown, options?: AnswerOptions): void;
}

export interface AnswerOptions {
  readonly origin?: string;
  /** The window the answer comes from; `null` is a valid value, not a default. */
  readonly source?: unknown;
}

/** The frame that `mountComposition` built for a Custom HTML node. */
export function frameFor(root: Element, nodeId: string): HTMLIFrameElement {
  const frame = root.querySelector(`[data-kadrion-node="${nodeId}"] > iframe`);
  if (frame === null) throw new Error(`The tree has no frame for "${nodeId}".`);
  return frame as HTMLIFrameElement;
}

/** Plays the element in the frame of `nodeId`; the root must be attached. */
export function elementDouble(window: DOMWindow, root: Element, nodeId: string): ElementDouble {
  const source = frameFor(root, nodeId).contentWindow;
  if (source === null) throw new Error(`The frame of "${nodeId}" is not attached.`);
  const posted: Posted[] = [];
  Object.defineProperty(source, 'postMessage', {
    configurable: true,
    writable: true,
    value: (message: unknown, targetOrigin: unknown): void => {
      posted.push({ message, targetOrigin });
    },
  });
  const event = (data: unknown, options: AnswerOptions = {}): MessageEvent => {
    const init = {
      data,
      origin: options.origin ?? 'null',
      source: 'source' in options ? options.source : source,
    };
    return new window.MessageEvent('message', init as MessageEventInit);
  };
  const dispatch = (message: MessageEvent): void => {
    window.dispatchEvent(message);
  };
  return {
    source,
    posted,
    event,
    dispatch,
    answer(data, options) {
      dispatch(event(data, options));
    },
  };
}

/** The host side: a window that counts its `message` listeners, and a manual timer. */
export interface HostDouble {
  readonly host: CustomHtmlHost;
  /** `message` listeners currently registered through the host. */
  readonly listeners: () => number;
  readonly timersStarted: () => number;
  readonly timersCancelled: () => number;
  /** Lets every started timer expire. */
  expire(): void;
}

/** The request ID a host double passes unless a test names another. */
export const REQUEST_ID = 7;

export function hostDouble(
  window: DOMWindow,
  options: { readonly expireAtStart?: boolean; readonly requestId?: number } = {},
): HostDouble {
  const active = new Set<MessageListener>();
  const expires: (() => void)[] = [];
  let cancelled = 0;
  return {
    host: {
      messageTarget: {
        addEventListener(type, listener) {
          active.add(listener);
          window.addEventListener(type, listener);
        },
        removeEventListener(type, listener) {
          active.delete(listener);
          window.removeEventListener(type, listener);
        },
      },
      startTimer(expire) {
        expires.push(expire);
        if (options.expireAtStart === true) expire();
        return () => {
          cancelled += 1;
        };
      },
      requestId: options.requestId ?? REQUEST_ID,
    },
    listeners: () => active.size,
    timersStarted: () => expires.length,
    timersCancelled: () => cancelled,
    expire() {
      for (const expire of expires) expire();
    },
  };
}

/** Whether a promise has settled, observed after the pending microtasks ran. */
export async function settledState(promise: Promise<unknown>): Promise<string> {
  let state = 'pending';
  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  return state;
}
