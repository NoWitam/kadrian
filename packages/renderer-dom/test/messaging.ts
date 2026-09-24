/**
 * Runs real Custom HTML elements in jsdom (D23.3). jsdom runs the scripts of a
 * child frame, but it loads no `srcdoc`, and its `postMessage` sets no
 * `event.source` and delivers later on a Node.js timer. So this harness does two
 * things a browser does:
 *
 * - `loadSrcdoc` puts the frame's `srcdoc` into its document and runs its scripts;
 * - `installMessaging` replaces `postMessage` of every given window with a
 *   synchronous delivery whose `source` follows the HTML "incumbent" rule: the
 *   window whose script is running. That is the window whose `message` handler
 *   the harness is dispatching into, and the top window otherwise (test code,
 *   which plays the host). The origin is `null` for a sandboxed frame.
 *
 * It models the browser; it is not one. PR-06 repeats these tests in pinned
 * Chromium. Nothing here is part of the package.
 */
import type { DOMWindow } from 'jsdom';

/** Puts the `srcdoc` of an attached frame into its document and runs its scripts. */
export function loadSrcdoc(frame: HTMLIFrameElement): Window {
  const view = frame.contentWindow;
  const document = frame.contentDocument;
  if (view === null || document === null) throw new Error('The frame is not attached.');
  const parser = new (view as unknown as { DOMParser: typeof DOMParser }).DOMParser();
  const parsed = parser.parseFromString(frame.getAttribute('srcdoc') ?? '', 'text/html');
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  // Scripts that arrive through a parser or a clone do not run; fresh ones do.
  for (const script of [...document.querySelectorAll('script')]) {
    const fresh = document.createElement('script');
    fresh.textContent = script.textContent;
    script.replaceWith(fresh);
  }
  return view;
}

export interface Delivery {
  readonly target: Window;
  readonly source: Window;
  readonly data: unknown;
  /** Messages the target posted while it handled this one. */
  readonly posted: Delivery[];
}

export interface Messaging {
  /** Every delivery, in order, including nested ones. */
  readonly log: Delivery[];
  /** The incumbent rule may be replaced, to prove that the tests depend on it. */
  restore(): void;
}

export function installMessaging(
  top: DOMWindow,
  frames: readonly Window[],
  options: { readonly incumbent?: 'script' | 'top' } = {},
): Messaging {
  const log: Delivery[] = [];
  const running: { window: Window; posted: Delivery[] }[] = [];
  const windows: Window[] = [top as unknown as Window, ...frames];
  const saved = windows.map(
    (window) => [window, Object.getOwnPropertyDescriptor(window, 'postMessage')] as const,
  );
  const deliver = (target: Window, data: unknown): void => {
    const current = running.at(-1);
    const source =
      options.incumbent === 'top' || current === undefined
        ? (top as unknown as Window)
        : current.window;
    const delivery: Delivery = { target, source, data, posted: [] };
    (current?.posted ?? log).push(delivery);
    if (current !== undefined) log.push(delivery);
    const origin = source === (top as unknown as Window) ? top.location.origin : 'null';
    const init = { data: structuredClone(data), origin, source };
    const TargetEvent = (target as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
    const event = new TargetEvent('message', init as MessageEventInit);
    running.push({ window: target, posted: delivery.posted });
    try {
      target.dispatchEvent(event);
    } finally {
      running.pop();
    }
  };
  for (const window of windows) {
    Object.defineProperty(window, 'postMessage', {
      configurable: true,
      writable: true,
      value: (data: unknown): void => {
        deliver(window, data);
      },
    });
  }
  return {
    log,
    restore() {
      for (const [window, descriptor] of saved) {
        if (descriptor === undefined) Reflect.deleteProperty(window, 'postMessage');
        else Object.defineProperty(window, 'postMessage', descriptor);
      }
    },
  };
}
