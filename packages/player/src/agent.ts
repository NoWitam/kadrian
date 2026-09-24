/**
 * The page agent (D25.4): the Player's script inside the render page, next to
 * the runtime build. It is serialised with `String(pageAgent)`, so it must stay
 * self-contained: no import, no helper outside the function, nothing that
 * TypeScript compiles into a call to a helper. It only transports: it checks
 * messages, keeps the document's JSON text, passes the asset bytes through
 * unchanged, and calls `KadrionRuntime.load` and `KadrionRuntime.frame`, whose
 * order of work decides the pixels (D25.3, D27.1). It lends the page's
 * `FontFace` constructor and a timer, both captured when it starts: the timer
 * bounds the Custom HTML wait, and the clock of the page belongs to the host
 * (D20.2).
 */
export function pageAgent(): void {
  interface Failure {
    code: string;
    message: string;
    details: string[];
  }
  interface Runtime {
    load(
      root: Element,
      document: unknown,
      assets: unknown,
      host: unknown,
    ): Promise<{ ok: boolean; errors?: unknown }>;
    frame(
      root: Element,
      document: unknown,
      timeUs: number,
      host: unknown,
    ): Promise<{ ok: boolean; errors?: unknown }>;
  }

  const VERSION = 1;
  const LOAD_KEYS = ['ackTimeoutMs', 'assets', 'document', 'requestId', 'type', 'version'];
  const SEEK_KEYS = ['requestId', 'timeUs', 'type', 'version'];

  const runtime = (window as unknown as { KadrionRuntime?: Runtime }).KadrionRuntime;
  const root = document.getElementById('kadrion-root');
  const state = { documentJson: null as string | null, ackTimeoutMs: 0 };
  // Captured now, so that nothing that runs in the page later can replace them.
  const startTimeout = window.setTimeout.bind(window);
  const stopTimeout = window.clearTimeout.bind(window);
  const Face = (window as unknown as { FontFace?: typeof FontFace }).FontFace;
  const fontHost =
    Face === undefined
      ? {}
      : { createFont: (family: string, bytes: ArrayBuffer): FontFace => new Face(family, bytes) };
  let queue: Promise<void> = Promise.resolve();

  const sortedKeys = (value: object): string =>
    Reflect.ownKeys(value)
      .map((key) => (typeof key === 'string' ? key : '#symbol'))
      .sort()
      .join(',');
  const hasExactly = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    sortedKeys(value) === keys.join(',');
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

  const post = (message: object): void => {
    window.parent.postMessage(message, '*');
  };
  const reply = (requestId: number, error: Failure | null): void => {
    post({ type: 'kadrion-player:result', version: VERSION, requestId, ok: error === null, error });
  };
  const failure = (reason: unknown): Failure => {
    const code = (reason as { code?: unknown } | null)?.code;
    const message = (reason as { message?: unknown } | null)?.message;
    return {
      code: typeof code === 'string' ? code : 'page-error',
      message: typeof message === 'string' ? message : String(reason),
      details: [],
    };
  };
  const invalid = (errors: unknown): Failure => ({
    code: 'invalid-document',
    message: 'The document is not a valid composition.',
    details: Array.isArray(errors)
      ? errors.map(
          (error: { path?: unknown; message?: unknown }) =>
            `${String(error.path)}: ${String(error.message)}`,
        )
      : [],
  });

  const load = (data: Record<string, unknown>): Promise<void> => {
    const requestId = data.requestId as number;
    const text = data.document as string;
    // Parsed here, so that the validator sees a plain object of this realm (D21);
    // the assets go through unchanged, and the artifact checks them (D27.1).
    return (runtime as Runtime)
      .load(root as Element, JSON.parse(text), data.assets, fontHost)
      .then((result) => {
        if (!result.ok) {
          reply(requestId, invalid(result.errors));
          return;
        }
        state.documentJson = text;
        state.ackTimeoutMs = data.ackTimeoutMs as number;
        reply(requestId, null);
      });
  };

  const seek = (data: Record<string, unknown>): Promise<void> => {
    const requestId = data.requestId as number;
    if (state.documentJson === null) {
      reply(requestId, { code: 'not-loaded', message: 'No document is loaded.', details: [] });
      return Promise.resolve();
    }
    const host = {
      // A thin wrapper: the renderer gets message events, not the window (D23).
      messageTarget: {
        addEventListener: (type: 'message', listener: (event: MessageEvent) => void): void => {
          window.addEventListener(type, listener);
        },
        removeEventListener: (type: 'message', listener: (event: MessageEvent) => void): void => {
          window.removeEventListener(type, listener);
        },
      },
      startTimer: (expire: () => void): (() => void) => {
        const handle = startTimeout(expire, state.ackTimeoutMs);
        return () => {
          stopTimeout(handle);
        };
      },
      requestId,
    };
    return (runtime as Runtime)
      .frame(root as Element, JSON.parse(state.documentJson), data.timeUs as number, host)
      .then((result) => {
        reply(requestId, result.ok ? null : invalid(result.errors));
      });
  };

  const enqueue = (requestId: number, run: () => Promise<void>): void => {
    queue = queue.then(run).catch((reason: unknown) => {
      reply(requestId, failure(reason));
    });
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const data: unknown = event.data;
    if (
      hasExactly(data, LOAD_KEYS) &&
      data.type === 'kadrion-player:load' &&
      data.version === VERSION &&
      isCount(data.requestId) &&
      typeof data.document === 'string' &&
      Array.isArray(data.assets) &&
      isCount(data.ackTimeoutMs)
    ) {
      enqueue(data.requestId, () => load(data));
    } else if (
      hasExactly(data, SEEK_KEYS) &&
      data.type === 'kadrion-player:seek' &&
      data.version === VERSION &&
      isCount(data.requestId) &&
      isCount(data.timeUs)
    ) {
      enqueue(data.requestId, () => seek(data));
    }
  });

  if (runtime === undefined || root === null) {
    throw new Error('The render page has no KadrionRuntime or no root.');
  }
  post({ type: 'kadrion-player:ready', version: VERSION });
}

/** The agent as the script text of the render page (D25.2). */
export const PAGE_AGENT_SCRIPT = `(${String(pageAgent)})();`;
