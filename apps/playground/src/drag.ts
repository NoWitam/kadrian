/**
 * The drag gesture of P3 (D30.10). The render page is a sandboxed frame without
 * `allow-same-origin`, so this page cannot reach the DOM the runtime produces
 * even if it tried: the affordance is an overlay the application owns, placed
 * from the document.
 *
 * The gesture itself changes nothing lasting. `pointermove` updates a temporary
 * preview only; `pointerup` emits exactly one `SetNodePosition`, and the
 * position that survives is the one in the document the bus returns. Rounding
 * to integer composition pixels is not done here — `@kadrion/editor-sdk` owns
 * it (D15), so an AI tool call with the same numbers lands on the same
 * document.
 *
 * Two details are forced by the sandbox rather than chosen. The moves and the
 * release are listened for on the grip's document, not on the grip, because the
 * pointer leaves the grip immediately. And while a gesture runs, the overlay
 * takes pointer events, so that it shields the render frame: that frame is
 * cross-origin and Chromium runs it out of process (D26), so a pointer over it
 * is routed to its process and neither this document nor a pointer capture
 * taken here would ever see the rest of the gesture.
 */
import type { Command } from '@kadrion/editor-sdk';

export interface NodeDragOptions {
  /** The grip the pointer grabs; it sits at the node's origin inside `surface`. */
  readonly handle: HTMLElement;
  /** The overlay: the canvas box, so its width measures the preview scale, and the shield. */
  readonly surface: HTMLElement;
  /** The canvas width in composition pixels; `surface` shows exactly this much. */
  readonly compositionWidth: number;
  readonly nodeId: string;
  /** The node's position in the current document, read once per gesture. */
  readonly positionOf: () => { readonly x: number; readonly y: number };
  /** Emitted once per gesture, on `pointerup`. */
  readonly onCommand: (command: Command) => void;
  /** The temporary preview of the gesture, in client pixels; `null` clears it. */
  readonly onPreview: (offset: { readonly dx: number; readonly dy: number } | null) => void;
  /** Reports a gesture that produced no command, with the reason. */
  readonly onRefused?: (reason: string) => void;
}

interface Gesture {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly origin: { readonly x: number; readonly y: number };
  /** The surface's own `pointer-events`, restored when the gesture ends. */
  readonly shielded: string;
}

/**
 * Client pixels per composition pixel, measured from the surface rather than
 * assumed, or `null` when the surface has no box to measure — a hidden panel,
 * a detached element. A guessed scale would write a wrong but perfectly valid
 * position into the document, which is the one silent fallback this file must
 * not have.
 */
export function previewScale(surface: HTMLElement, compositionWidth: number): number | null {
  const { width } = surface.getBoundingClientRect();
  if (!(width > 0) || !(compositionWidth > 0)) return null;
  return width / compositionWidth;
}

/**
 * Attaches the gesture and returns the function that detaches it. Exactly one
 * command reaches `onCommand` for every gesture that ends in `pointerup` over a
 * measurable surface, and none for one that is cancelled.
 */
export function attachNodeDrag(options: NodeDragOptions): () => void {
  const { handle, surface, compositionWidth, nodeId, positionOf, onCommand, onPreview } = options;
  const onRefused = options.onRefused;
  const view = handle.ownerDocument;
  let gesture: Gesture | null = null;

  /** Ends the gesture and lowers the shield; returns what was running, if anything. */
  const end = (event: PointerEvent): Gesture | null => {
    if (gesture === null || event.pointerId !== gesture.pointerId) return null;
    const running = gesture;
    gesture = null;
    surface.style.pointerEvents = running.shielded;
    onPreview(null);
    return running;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (gesture !== null) return;
    gesture = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      origin: positionOf(),
      shielded: surface.style.pointerEvents,
    };
    // The shield: for the rest of the gesture the overlay, not the render
    // frame, is what the pointer hits, so this document sees every move.
    surface.style.pointerEvents = 'auto';
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (gesture === null || event.pointerId !== gesture.pointerId) return;
    onPreview({ dx: event.clientX - gesture.clientX, dy: event.clientY - gesture.clientY });
  };

  const onPointerUp = (event: PointerEvent): void => {
    const running = end(event);
    if (running === null) return;
    const scale = previewScale(surface, compositionWidth);
    if (scale === null) {
      onRefused?.('The canvas has no measurable size, so the drop point is unknown.');
      return;
    }
    onCommand({
      type: 'SetNodePosition',
      nodeId,
      position: {
        x: running.origin.x + (event.clientX - running.clientX) / scale,
        y: running.origin.y + (event.clientY - running.clientY) / scale,
      },
    });
  };

  const onPointerCancel = (event: PointerEvent): void => {
    end(event);
  };

  handle.addEventListener('pointerdown', onPointerDown);
  view.addEventListener('pointermove', onPointerMove);
  view.addEventListener('pointerup', onPointerUp);
  view.addEventListener('pointercancel', onPointerCancel);
  return () => {
    handle.removeEventListener('pointerdown', onPointerDown);
    view.removeEventListener('pointermove', onPointerMove);
    view.removeEventListener('pointerup', onPointerUp);
    view.removeEventListener('pointercancel', onPointerCancel);
  };
}
