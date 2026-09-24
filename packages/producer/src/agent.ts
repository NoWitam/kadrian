/**
 * The Producer's page agent (D28.3): its script inside the render page, next to
 * the runtime build. Like the Player's, it is serialised with `String(fn)`, so it
 * must stay self-contained. Its transport is CDP evaluation, not `postMessage`:
 * it exposes `kadrionProducer.load` and `kadrionProducer.frame`, which the
 * Producer calls through Playwright, and nothing else. It holds no pixel logic:
 * it decodes the base64 of the asset bytes that CDP carries, and calls
 * `KadrionRuntime.load` and `KadrionRuntime.frame` (D25.3, D27.1). The
 * `FontFace` constructor and the timer are captured when it starts, so a page
 * whose clocks are replaced later still gets them (§6.1).
 */
export function producerAgent(): void {
  interface Result {
    ok: boolean;
    errors?: unknown;
  }
  interface Runtime {
    load(root: Element, document: unknown, assets: unknown, host: unknown): Promise<Result>;
    frame(root: Element, document: unknown, timeUs: number, host: unknown): Promise<Result>;
  }
  interface Outcome {
    ok: boolean;
    code: string | null;
    message: string | null;
    details: string[];
  }

  const runtime = (window as unknown as { KadrionRuntime?: Runtime }).KadrionRuntime;
  const root = document.getElementById('kadrion-root');
  const startTimeout = window.setTimeout.bind(window);
  const stopTimeout = window.clearTimeout.bind(window);
  const Face = (window as unknown as { FontFace?: typeof FontFace }).FontFace;
  const fontHost =
    Face === undefined
      ? {}
      : { createFont: (family: string, bytes: ArrayBuffer): FontFace => new Face(family, bytes) };
  const state = { documentJson: null as string | null, loads: 0, frames: 0 };

  const done = (result: Result): Outcome =>
    result.ok
      ? { ok: true, code: null, message: null, details: [] }
      : {
          ok: false,
          code: 'invalid-document',
          message: 'The document is not a valid composition.',
          details: Array.isArray(result.errors)
            ? result.errors.map(
                (error: { path?: unknown; message?: unknown }) =>
                  `${String(error.path)}: ${String(error.message)}`,
              )
            : [],
        };
  const failed = (reason: unknown): Outcome => {
    const code = (reason as { code?: unknown } | null)?.code;
    const message = (reason as { message?: unknown } | null)?.message;
    return {
      ok: false,
      code: typeof code === 'string' ? code : 'page-error',
      message: typeof message === 'string' ? message : String(reason),
      details: [],
    };
  };
  const bytesOf = (text: string): ArrayBuffer => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  };

  const api = {
    load(documentJson: string, assets: { id: string; mediaType: string; base64: string }[]) {
      state.loads += 1;
      const decoded = assets.map(({ id, mediaType, base64 }) => ({
        id,
        mediaType,
        bytes: bytesOf(base64),
      }));
      return (runtime as Runtime)
        .load(root as Element, JSON.parse(documentJson), decoded, fontHost)
        .then((result) => {
          if (result.ok) state.documentJson = documentJson;
          return done(result);
        }, failed);
    },
    frame(timeUs: number, requestId: number, ackTimeoutMs: number) {
      if (state.documentJson === null) {
        return Promise.resolve(failed({ code: 'page-error', message: 'No document is loaded.' }));
      }
      state.frames += 1;
      const host = {
        messageTarget: {
          addEventListener: (type: 'message', listener: (event: MessageEvent) => void): void => {
            window.addEventListener(type, listener);
          },
          removeEventListener: (type: 'message', listener: (event: MessageEvent) => void): void => {
            window.removeEventListener(type, listener);
          },
        },
        startTimer: (expire: () => void): (() => void) => {
          const handle = startTimeout(expire, ackTimeoutMs);
          return () => {
            stopTimeout(handle);
          };
        },
        requestId,
      };
      return (runtime as Runtime)
        .frame(root as Element, JSON.parse(state.documentJson), timeUs, host)
        .then(done, failed);
    },
    stats() {
      return { loads: state.loads, frames: state.frames };
    },
  };

  if (runtime === undefined || root === null) {
    throw new Error('The render page has no KadrionRuntime or no root.');
  }
  Object.defineProperty(window, 'kadrionProducer', { value: Object.freeze(api) });
}

/** The agent as the script text of the render page (D25.2, D28.3). */
export const PRODUCER_AGENT_SCRIPT = `(${String(producerAgent)})();`;
