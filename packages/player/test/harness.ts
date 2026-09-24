/**
 * Runs the Player against its real render page in jsdom (D25). jsdom loads no
 * `srcdoc`, sets no `event.source` in `postMessage`, and has neither image
 * decoding nor a font set, so this harness does what a browser would:
 *
 * - every frame attached below the top window gets its `srcdoc` loaded and its
 *   scripts run: the render page (runtime build and page agent) and, inside it,
 *   the Custom HTML elements;
 * - messages are delivered asynchronously, cloned, with the origin `null` from a
 *   sandboxed frame, and with the `source` the receiver compares against: a
 *   frame's `window.parent` is a facade object, messages from the parent carry
 *   that facade as `source`, and messages from the frame carry the frame's
 *   window. In these tests only a parent posts to its frame, which is what lets
 *   the facade stand for the incumbent rule (the attacker case is in
 *   `packages/renderer-dom/test/custom-html-element.test.ts`);
 * - `decode`, `FontFace`, and `document.fonts` are doubles, resolved unless a
 *   test says so; the font set records the faces added to it (D27.1).
 *
 * It models a browser; PR-06 runs the P1 test in pinned Chromium. Nothing here is
 * part of the package.
 */
import { JSDOM, type DOMWindow } from 'jsdom';

export interface Delivery {
  readonly target: Window;
  readonly source: unknown;
  readonly data: unknown;
}

/** A face registered through the stand-in `FontFace` of a loaded frame. */
export interface HarnessFont {
  readonly family: string;
  readonly bytes: ArrayBuffer;
}

export interface HarnessOptions {
  /** How images decode in every loaded frame. */
  readonly decode?: 'resolve' | 'reject';
  /** How every font face loads in every loaded frame. */
  readonly font?: 'resolve' | 'reject';
  /** Leave frames unloaded, as if the page never started. */
  readonly loadFrames?: boolean;
}

export interface Harness {
  readonly window: DOMWindow;
  readonly container: HTMLElement;
  /** Every delivered message, in order. */
  readonly log: Delivery[];
  /** The facade that a frame's scripts see as `window.parent`. */
  parentOf(view: Window): object | undefined;
  /** The faces in the font set of a loaded frame, in the order they were added. */
  fontsOf(view: Window): readonly HarnessFont[];
  /** Delivers a message to `target` as if `source` had posted it. */
  deliver(target: Window, data: unknown, source: unknown, origin?: string): Promise<void>;
  /** Resolves after every pending delivery and its handlers ran. */
  settle(): Promise<void>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://app.invalid/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const log: Delivery[] = [];
  const facades = new Map<Window, object>();
  const fontSets = new Map<Window, HarnessFont[]>();
  let inFlight = 0;

  const deliver = (
    target: Window,
    data: unknown,
    source: unknown,
    origin = 'null',
  ): Promise<void> => {
    inFlight += 1;
    const clone: unknown = structuredClone(data);
    return Promise.resolve().then(() => {
      inFlight -= 1;
      log.push({ target, source, data: clone });
      const TargetEvent = (target as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
      const event = new TargetEvent('message', { data: clone, origin });
      Object.defineProperty(event, 'source', { value: source });
      target.dispatchEvent(event);
    });
  };

  const setUp = (frame: HTMLIFrameElement, parent: Window): void => {
    const view = frame.contentWindow;
    if (view === null || facades.has(view)) return;
    const parentOrigin = parent === (window as unknown as Window) ? window.location.origin : 'null';
    const facade = {
      postMessage: (data: unknown): void => {
        void deliver(parent, data, view);
      },
      get frames(): Window {
        return parent.frames;
      },
    };
    facades.set(view, facade);
    Object.defineProperty(view, 'parent', { configurable: true, get: () => facade });
    Object.defineProperty(view, 'postMessage', {
      configurable: true,
      value: (data: unknown): void => {
        void deliver(view, data, facade, parentOrigin);
      },
    });
    const inner = view as unknown as DOMWindow;
    Object.defineProperty(inner.HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: () =>
        options.decode === 'reject'
          ? Promise.reject(new Error('EncodingError'))
          : Promise.resolve(),
    });
    const faces: HarnessFont[] = [];
    fontSets.set(view, faces);
    Object.defineProperty(inner.document, 'fonts', {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        clear: () => {
          faces.length = 0;
        },
        add: (face: HarnessFont) => {
          faces.push(face);
        },
      },
    });
    Object.defineProperty(inner, 'FontFace', {
      configurable: true,
      value: class {
        readonly family: string;
        readonly bytes: ArrayBuffer;
        constructor(family: string, bytes: ArrayBuffer) {
          this.family = family;
          this.bytes = bytes;
        }
        load(): Promise<unknown> {
          return options.font === 'reject'
            ? Promise.reject(new Error('OTS parsing error'))
            : Promise.resolve(this);
        }
      },
    });
    watch(inner.document, view);
    loadSrcdoc(frame);
  };

  function watch(document: Document, owner: Window): void {
    const View = owner as unknown as DOMWindow;
    new View.MutationObserver((records) => {
      if (options.loadFrames === false) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          const frames =
            node instanceof View.HTMLIFrameElement
              ? [node]
              : node instanceof View.Element
                ? [...node.querySelectorAll('iframe')]
                : [];
          for (const frame of frames) setUp(frame, owner);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  }
  watch(window.document, window as unknown as Window);

  return {
    window,
    container,
    log,
    parentOf: (view) => facades.get(view),
    fontsOf: (view) => fontSets.get(view) ?? [],
    deliver,
    async settle() {
      for (let turn = 0; turn < 200 && inFlight > 0; turn += 1) await Promise.resolve();
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    },
  };
}

/** Puts the `srcdoc` of an attached frame into its document and runs its scripts. */
export function loadSrcdoc(frame: HTMLIFrameElement): void {
  const view = frame.contentWindow as unknown as DOMWindow | null;
  const document = frame.contentDocument;
  if (view === null || document === null) throw new Error('The frame is not attached.');
  const parsed = new view.DOMParser().parseFromString(
    frame.getAttribute('srcdoc') ?? '',
    'text/html',
  );
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
}

/** Waits for real time: the page's Custom HTML timer and the Player's request timer are real. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
