/**
 * The editing half of the playground, as one function, so that what the page
 * runs is what the tests drive (D30.10). `main.ts` is the bootstrap around it:
 * it fetches the runtime build, makes the real Player, and hands both to
 * `wireEditor`.
 *
 * Nothing here is a domain rule. The function sizes the two canvas boxes from
 * the document, places the grip over the node, converts client pixels, and
 * hands every edit to the bus; the position that survives comes back in the
 * document the bus returns, which is what the Player is then asked to render.
 */
import { createCommandBus, EditorError, type CommandBus } from '@kadrion/editor-sdk';

import { attachNodeDrag, previewScale } from './drag.js';

/** How the host resolves an asset; the Player's own resolver satisfies it. */
export type AssetResolve = (request: { readonly id: string }) => unknown;

/** What the editor needs of a Player. The real one has more (D25). */
export interface PreviewPlayer {
  load(document: unknown, resolveAsset: AssetResolve): Promise<void>;
  seek(timeUs: number): Promise<void>;
  getState(): { readonly timeUs: number | null };
}

export interface EditorElements {
  /** The Player's element: the canvas at its own size, scaled by the stylesheet. */
  readonly stage: HTMLElement;
  /** The application's own layer over the stage, and the shield during a gesture. */
  readonly overlay: HTMLElement;
  /** The grip that drags the node. */
  readonly grip: HTMLElement;
}

export interface EditorOptions {
  readonly bus: CommandBus;
  readonly player: PreviewPlayer;
  readonly elements: EditorElements;
  readonly resolve: AssetResolve;
  /** The node the grip drags; it must be one the document gives a position. */
  readonly nodeId: string;
  /** The grip's box in composition pixels: an affordance of the page, not a node property. */
  readonly gripSize: number;
  readonly onError: (reason: unknown) => void;
}

export interface Editor {
  /** The node's position in the current document. */
  position(): { x: number; y: number };
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Re-renders from the current document, keeping the time the preview showed. */
  show(): Promise<void>;
  detach(): void;
}

interface PageNode {
  readonly id: string;
  readonly position?: { readonly x: number; readonly y: number };
  readonly children?: readonly PageNode[];
}

/** The position a node has in the current document; the document is the only truth (D30.10). */
export function positionOf(bus: CommandBus, nodeId: string): { x: number; y: number } {
  const { scenes } = bus.getDocument() as unknown as { scenes: readonly { nodes: PageNode[] }[] };
  for (const scene of scenes) {
    for (const node of scene.nodes) {
      for (const candidate of [node, ...(node.children ?? [])]) {
        if (candidate.id === nodeId && candidate.position !== undefined) {
          return { x: candidate.position.x, y: candidate.position.y };
        }
      }
    }
  }
  throw new Error(`The document has no movable node ${nodeId}.`);
}

/**
 * The nodes the grip may drag (D32.4): top-level nodes with a position and no
 * position animation. A group child's position is relative to its group, and a
 * node with a position animation is not moved by one `SetNodePosition` (D30.2),
 * so the grip would sit in the wrong place for either. This only chooses where
 * the page offers a grip; the bus still decides what it accepts.
 */
export function draggableNodes(document: unknown): string[] {
  const { scenes } = document as {
    scenes: readonly {
      nodes: readonly (PageNode & { animations?: readonly { property: string }[] })[];
    }[];
  };
  return scenes.flatMap((scene) =>
    scene.nodes
      .filter(
        (node) =>
          node.position !== undefined &&
          !(node.animations ?? []).some((animation) => animation.property === 'position'),
      )
      .map((node) => node.id),
  );
}

/** A validated bus over the document the page starts from. */
export function busFor(document: unknown): CommandBus {
  return createCommandBus(document);
}

/**
 * Gives the stage and the overlay the canvas box in composition pixels. Both
 * carry the same scale from the stylesheet, so the preview scale measured from
 * the overlay is the real one and never a layout accident.
 *
 * It runs before the Player is created: the render frame must be laid out in a
 * stage that already has its height, or the Custom HTML element inside it never
 * paints. `wireEditor` calls it again, so a caller may leave it out.
 */
export function sizeCanvas(
  elements: Pick<EditorElements, 'stage' | 'overlay'>,
  size: { readonly width: number; readonly height: number },
): void {
  for (const box of [elements.stage, elements.overlay]) {
    box.style.width = `${String(size.width)}px`;
    box.style.height = `${String(size.height)}px`;
  }
}

export function wireEditor(options: EditorOptions): Editor {
  const { bus, player, elements, resolve, nodeId, gripSize, onError } = options;
  const { overlay, grip } = elements;
  const { width, height } = bus.getDocument();
  sizeCanvas(elements, { width, height });
  grip.style.width = `${String(gripSize)}px`;
  grip.style.height = `${String(gripSize)}px`;

  const place = (): void => {
    const { x, y } = positionOf(bus, nodeId);
    grip.style.left = `${String(x)}px`;
    grip.style.top = `${String(y)}px`;
    grip.style.transform = '';
  };

  const show = async (): Promise<void> => {
    // `load` seeks to 0 (D25), so the time the preview was showing is restored.
    const at = player.getState().timeUs ?? 0;
    await player.load(bus.getDocument(), resolve);
    if (at !== 0) await player.seek(at);
    place();
  };

  const step = async (move: () => void): Promise<void> => {
    try {
      move();
    } catch (reason: unknown) {
      onError(reason);
      return;
    }
    await show();
  };

  const detach = attachNodeDrag({
    handle: grip,
    surface: overlay,
    compositionWidth: width,
    nodeId,
    positionOf: () => positionOf(bus, nodeId),
    onPreview: (offset) => {
      if (offset === null) {
        grip.style.transform = '';
        return;
      }
      // The grip lives in the scaled overlay, so the client delta is converted
      // back into composition pixels before it is shown.
      const scale = previewScale(overlay, width);
      if (scale === null) return;
      grip.style.transform = `translate(${String(offset.dx / scale)}px, ${String(offset.dy / scale)}px)`;
    },
    onRefused: (reason) => {
      place();
      onError(new EditorError('invalid-argument', reason));
    },
    onCommand: (command) => {
      try {
        bus.dispatch(command);
      } catch (reason: unknown) {
        place();
        onError(reason);
        return;
      }
      void show().catch(onError);
    },
  });

  place();
  return {
    position: () => positionOf(bus, nodeId),
    undo: () => step(() => bus.undo()),
    redo: () => step(() => bus.redo()),
    show,
    detach,
  };
}
