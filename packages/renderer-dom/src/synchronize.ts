/**
 * The time contract of Custom HTML (specification §7.4, D23.3, D23.4): the host
 * pushes `timeUs` to each element directly, each element answers once it has
 * applied that time, and a missing answer within a bounded wait is a typed
 * error, never a silently accepted stale frame. Messages are bound to the exact
 * window they come from and correlated by instance and request (D23.3). The renderer never measures time: the host
 * lends the window where the answers arrive and the timer that bounds the wait
 * (D20.2). Nothing is kept between calls.
 */
import type { CompositionState } from '@kadrion/runtime';

import { RenderError } from './errors.js';
import { mountedNodes } from './render.js';
import { FRAME_ATTRIBUTES, NAVIGATED_ATTRIBUTE, SANDBOX_TOKENS, sandboxShell } from './sandbox.js';

/** Protocol version 1 (D23.3): what the host posts. */
export const TIME_MESSAGE = 'kadrion:time';
/** Protocol version 1 (D23.3): the only answer that counts. */
export const ACKNOWLEDGEMENT_MESSAGE = 'kadrion:time-ack';
export const PROTOCOL_VERSION = 1;

/** Both messages carry exactly these keys (D23.3), sorted. */
const MESSAGE_KEYS = 'instanceId,requestId,timeUs,type,version';

/** A listener for the `message` events of a window. */
export type MessageListener = (event: MessageEvent) => void;

/** The part of a window that the renderer uses: its `message` events. */
export interface MessageTarget {
  addEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
}

/** What the host lends for one synchronization (D23.4). */
export interface CustomHtmlHost {
  /** The window of the document that owns the root, where the elements' answers arrive. */
  readonly messageTarget: MessageTarget;
  /**
   * Starts the bounded wait: calls `expire` once when the host decides that the
   * wait is over, and returns a function that cancels it. The duration is the
   * host's policy.
   */
  readonly startTimer: (expire: () => void) => () => void;
  /**
   * Identifies this synchronization in every message and answer: a non-negative
   * safe integer that the host chooses, so that the renderer keeps no counter.
   */
  readonly requestId: number;
}

interface Frame {
  readonly nodeId: string;
  readonly frame: HTMLIFrameElement;
}

function navigatedError(nodeId: string): RenderError {
  return new RenderError(
    'custom-html-navigated',
    `The Custom HTML element "${nodeId}" loaded another document than its shell; its session is over (D23.9).`,
  );
}

/** The mounted frame of a Custom HTML placeholder, exactly as `mountComposition` built it. */
function frameOf(placeholder: HTMLElement, nodeId: string): HTMLIFrameElement {
  const frame = placeholder.firstElementChild;
  // Before the attribute check: the mark is an attribute too, and deserves its own code.
  if (frame?.localName === 'iframe' && frame.hasAttribute(NAVIGATED_ATTRIBUTE)) {
    throw navigatedError(nodeId);
  }
  if (
    placeholder.childNodes.length !== 1 ||
    frame?.localName !== 'iframe' ||
    frame.getAttributeNames().sort().join(',') !== FRAME_ATTRIBUTES ||
    frame.getAttribute('sandbox') !== SANDBOX_TOKENS ||
    frame.getAttribute('srcdoc')?.startsWith(sandboxShell(nodeId)) !== true
  ) {
    throw new RenderError(
      'not-mounted',
      `The Custom HTML element "${nodeId}" holds no sandboxed frame built by mountComposition.`,
    );
  }
  // A mounted `iframe` of this renderer; `instanceof` would fail across realms.
  return frame as HTMLIFrameElement;
}

/** An own data property, read without running a getter. */
function ownValue(data: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(data, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** A message of protocol version 1 (D23.3). */
interface Message {
  readonly type: string;
  readonly version: number;
  readonly instanceId: string;
  readonly requestId: number;
  readonly timeUs: number;
}

/**
 * Exactly the acknowledgement of `expected`: the same five keys and nothing
 * else, of the answer type, with its version, instance, request, and time. The
 * prototype is not compared: the data belongs to the realm of the receiver.
 */
function isAcknowledgement(data: unknown, expected: Message): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const keys = Reflect.ownKeys(data);
  if (keys.some((key) => typeof key !== 'string')) return false;
  return (
    (keys as string[]).sort().join(',') === MESSAGE_KEYS &&
    ownValue(data, 'type') === expected.type &&
    ownValue(data, 'version') === expected.version &&
    ownValue(data, 'instanceId') === expected.instanceId &&
    ownValue(data, 'requestId') === expected.requestId &&
    ownValue(data, 'timeUs') === expected.timeUs
  );
}

/**
 * Pushes `state.timeUs` to every Custom HTML element of the tree that
 * `mountComposition` built in `root`, and resolves once each of them has
 * acknowledged exactly that time. Call it after `renderState` with the same
 * state, and capture a frame only after it resolved.
 *
 * - The tree is checked first, as by `renderState`; a problem rejects before any
 *   message is posted.
 * - An answer counts only from that element's frame, with the opaque origin
 *   `null`, in the exact shape of D23.3, and for the requested time; anything
 *   else is ignored and the wait goes on.
 * - A frame whose shell becomes active during the wait fires `load` and gets
 *   the time once more: a message posted before that is lost.
 * - A frame that loads any other document (D23.9) ends its session: a frame
 *   marked before the call rejects before any post, a mark during the wait
 *   rejects with `custom-html-navigated` at once, so no later answer counts.
 * - When the host's timer expires first, it rejects with the `RenderError` code
 *   `custom-html-timeout`, naming every element that did not answer.
 * - Either way it removes its listeners and cancels the timer.
 *
 * Answers are correlated by instance, request, and time (D23.3); the DOM holds
 * one instant, so the host runs one synchronization per root at a time (D23.6).
 */
export function synchronizeCustomHtml(
  root: Element,
  state: CompositionState,
  host: CustomHtmlHost,
): Promise<void> {
  // The executor runs synchronously; a check that throws in it rejects the promise.
  return new Promise<void>((resolve, reject) => {
    const { requestId } = host;
    if (!Number.isSafeInteger(requestId) || requestId < 0) {
      throw new RenderError(
        'invalid-request',
        `The request ID must be a non-negative safe integer, got ${String(requestId)}.`,
      );
    }
    const frames: readonly Frame[] = mountedNodes(root, state)
      .filter(({ state: node }) => node.type === 'custom-html')
      .map(({ element, state: node }) => ({
        nodeId: node.id,
        frame: frameOf(element, node.id),
      }));
    if (frames.length === 0) {
      resolve();
      return;
    }
    const { timeUs } = state;
    const waiting = new Set(frames.map(({ nodeId }) => nodeId));
    const messageFor = (nodeId: string, type: string): Message => ({
      type,
      version: PROTOCOL_VERSION,
      instanceId: nodeId,
      requestId,
      timeUs,
    });
    const post = ({ nodeId, frame }: Frame): void => {
      // Directly to this frame's window, never broadcast. Its origin is opaque and
      // cannot be named; the message holds nothing but the time and its correlation.
      frame.contentWindow?.postMessage(messageFor(nodeId, TIME_MESSAGE), '*');
    };
    const reposts = frames.map((entry) => {
      const repost = (): void => {
        if (run.settled) return;
        if (entry.frame.hasAttribute(NAVIGATED_ATTRIBUTE)) {
          settle();
          reject(navigatedError(entry.nodeId));
          return;
        }
        post(entry);
      };
      return { frame: entry.frame, repost };
    });
    // Local to this call: whether it has settled, and how to cancel the host's timer.
    const run = { settled: false, cancelTimer: (): void => undefined };
    const settle = (): void => {
      run.settled = true;
      host.messageTarget.removeEventListener('message', onMessage);
      for (const { frame, repost } of reposts) frame.removeEventListener('load', repost);
      run.cancelTimer();
    };
    function onMessage(event: MessageEvent): void {
      if (run.settled || event.origin !== 'null') return;
      // The exact window of one frame authenticates the answer; the origin `null`
      // alone would not, since every sandboxed frame has it (D23.3).
      const answered = frames.find(({ frame }) => frame.contentWindow === event.source);
      if (answered === undefined) return;
      const expected = messageFor(answered.nodeId, ACKNOWLEDGEMENT_MESSAGE);
      if (!isAcknowledgement(event.data, expected)) return;
      waiting.delete(answered.nodeId);
      if (waiting.size > 0) return;
      settle();
      resolve();
    }
    host.messageTarget.addEventListener('message', onMessage);
    for (const { frame, repost } of reposts) frame.addEventListener('load', repost);
    const cancel = host.startTimer(() => {
      if (run.settled) return;
      settle();
      const missing = [...waiting].map((nodeId) => JSON.stringify(nodeId)).join(', ');
      reject(
        new RenderError(
          'custom-html-timeout',
          `Custom HTML did not acknowledge timeUs ${String(timeUs)} in time: ${missing}.`,
        ),
      );
    });
    // A timer that expired inside startTimer has settled already: cancel it, post nothing.
    if (run.settled) {
      cancel();
      return;
    }
    run.cancelTimer = cancel;
    for (const entry of frames) post(entry);
  });
}
