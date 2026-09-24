/**
 * When the media of a rendered frame are ready (D25.3): every image under the
 * root has been decoded, and the document's font set has settled. The renderer
 * waits on the browser's own promises and never on a clock; a host bounds the
 * whole frame with its own timeout. Font loading itself is open question Q5.
 */
import { RenderError } from './errors.js';

interface Decodable {
  decode?: () => Promise<void>;
}

interface WithFonts {
  readonly fonts?: { readonly ready: Promise<unknown> };
}

/** Resolves once every image under `root` is decoded and `document.fonts.ready` has settled. */
export function awaitMediaReady(root: Element): Promise<void> {
  // The executor runs synchronously; a check that throws in it rejects the promise.
  return new Promise<void>((resolve, reject) => {
    // Typed as optional on purpose: jsdom, for one, has no font set.
    const document = root.ownerDocument as unknown as WithFonts;
    const fonts = document.fonts;
    if (fonts === undefined) {
      throw new RenderError('readiness-unsupported', 'The document has no font set to wait for.');
    }
    const decodes = [...root.querySelectorAll('img')].map((image) => {
      const decode = (image as Decodable).decode;
      if (typeof decode !== 'function') {
        throw new RenderError(
          'readiness-unsupported',
          'Images of this document cannot be decoded.',
        );
      }
      const nodeId = image.getAttribute('data-kadrion-node') ?? '';
      return decode.call(image).catch(() => {
        throw new RenderError(
          'asset-decode-failed',
          `The image of "${nodeId}" could not be decoded.`,
        );
      });
    });
    Promise.all([...decodes, fonts.ready]).then(() => {
      resolve();
    }, reject);
  });
}
