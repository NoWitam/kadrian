/**
 * The playground (D25.9, D30.10, D32): showcases, documents of the user's own,
 * the drag of P3, and the AI tool of P4 on one command bus. This file is the
 * bootstrap and the page's wiring: it fetches the runtime build and its
 * manifest, makes the one Player, and for every document makes a bus and hands
 * both to `wireEditor`, which holds the editing behaviour the tests drive.
 *
 * Nothing here is a domain rule. A document goes through `JSON.parse`, the bus
 * (the full `validateComposition`), and `player.load`; whatever they refuse is
 * shown as they report it. Assets are the bytes `@kadrion/test-fixtures`
 * generates, looked up by ID with no fallback (D32.2).
 */
import { executeSetNodePosition, setNodePositionTool } from '@kadrion/ai-sdk';
import type { CommandBus } from '@kadrion/editor-sdk';
import { createPlayer, type Player } from '@kadrion/player';
import { frameCount, frameToTimeUs, timeUsToFrame } from '@kadrion/schema';
import { FONT_GLYPHS, generateReferenceAssets, referenceComposition } from '@kadrion/test-fixtures';

import { busFor, draggableNodes, positionOf, sizeCanvas, wireEditor, type Editor } from './app.js';
import { SHOWCASES, type Showcase } from './showcases.js';

const RUNTIME = '/pkg/renderer-dom/runtime-build/kadrion-runtime.js';
const MANIFEST = '/pkg/renderer-dom/runtime-build/kadrion-runtime.json';

/** The preview scale of the stylesheet (`#stage`, `#overlay`). */
const SCALE = 0.35;
/** The grip's box in composition pixels. It is an affordance of this page, not a node property. */
const GRIP = 140;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`The page has no #${id}.`);
  return found;
}

async function bytesOf(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function textOf(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
  return response.text();
}

/** A typed failure of the bus or the Player, or anything else, as lines of text. */
function describe(reason: unknown): string {
  if (typeof reason === 'object' && reason !== null && 'code' in reason) {
    const { code, message, details } = reason as {
      code: unknown;
      message?: unknown;
      details?: unknown;
    };
    const lines = Array.isArray(details) ? details.map(String) : [];
    return [`${String(code)}: ${typeof message === 'string' ? message : ''}`, ...lines].join('\n');
  }
  return reason instanceof Error ? reason.message : String(reason);
}

function report(reason: unknown): void {
  console.error(reason);
  element('errors').textContent = describe(reason);
}

function clearErrors(): void {
  element('errors').textContent = '';
}

function button(parent: HTMLElement, label: string, action: () => unknown): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = label;
  control.addEventListener('click', () => {
    void Promise.resolve()
      .then(action)
      .catch((reason: unknown) => {
        report(reason);
      });
  });
  parent.append(control);
  return control;
}

/** One document on screen: its bus, the drag editor over it, and the node the grip drags. */
interface Session {
  readonly bus: CommandBus;
  readonly label: string;
  editor: Editor | null;
  nodeId: string | null;
}

async function main(): Promise<void> {
  const [bytes, manifest] = await Promise.all([
    bytesOf(RUNTIME),
    fetch(MANIFEST).then((response) => response.json() as Promise<{ contentHash: string }>),
  ]);
  const elements = { stage: element('stage'), overlay: element('overlay'), grip: element('grip') };
  const viewport = element('viewport');
  const timeline = element('timeline') as HTMLInputElement;
  const dragSelect = element('drag-node') as HTMLSelectElement;
  const source = element('source') as HTMLTextAreaElement;
  const toolCall = element('tool-call') as HTMLTextAreaElement;
  const current = element('current');

  const sizeViewport = (size: { width: number; height: number }): void => {
    viewport.style.width = `${String(Math.round(size.width * SCALE))}px`;
    viewport.style.height = `${String(Math.round(size.height * SCALE))}px`;
  };

  // Before the Player: the render frame needs a stage that already has a height (D30.10).
  sizeViewport(referenceComposition as { width: number; height: number });
  sizeCanvas(elements, referenceComposition as { width: number; height: number });
  const player: Player = await createPlayer(elements.stage, {
    runtime: { bytes, contentHash: manifest.contentHash },
  });
  const assets = new Map(generateReferenceAssets().map((asset) => [asset.id, asset]));
  // A lookup by ID and nothing else: an unknown ID is the Player's asset-missing (D32.2).
  const resolve = ({ id }: { id: string }) => assets.get(id) ?? null;

  let session: Session | null = null;

  /** Re-renders the current document, keeping the time the preview showed. */
  const rerender = async (): Promise<void> => {
    if (session === null) return;
    if (session.editor !== null) {
      await session.editor.show();
      return;
    }
    const at = player.getState().timeUs ?? 0;
    await player.load(session.bus.getDocument(), resolve);
    if (at !== 0) await player.seek(at);
  };

  /** Puts the grip on a node of the current document, or hides it. */
  const attachGrip = (nodeId: string | null): void => {
    if (session === null) return;
    session.editor?.detach();
    session.editor = null;
    session.nodeId = nodeId;
    elements.grip.hidden = nodeId === null;
    if (nodeId === null) return;
    session.editor = wireEditor({
      bus: session.bus,
      player,
      elements,
      resolve,
      nodeId,
      gripSize: GRIP,
      onError: report,
    });
  };

  const exampleCall = (bus: CommandBus, nodeId: string | null): unknown => {
    if (nodeId === null) {
      return {
        name: setNodePositionTool.name,
        arguments: { nodeId: '', position: { x: 0, y: 0 } },
      };
    }
    const { x, y } = positionOf(bus, nodeId);
    return { name: setNodePositionTool.name, arguments: { nodeId, position: { x: x + 100, y } } };
  };

  /**
   * Opens a document: parse, bus (full validation), then the Player. A document
   * that does not parse or validate leaves the one on screen as it was; one the
   * Player refuses (a missing asset, say) is shown with its error (D32.2, D32.3).
   */
  const open = async (text: string, label: string, showcase: Showcase | null): Promise<void> => {
    clearErrors();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (reason: unknown) {
      report(new Error(`The JSON does not parse: ${describe(reason)}`));
      return;
    }
    const bus = busFor(parsed);
    const composition = bus.getDocument();
    session?.editor?.detach();
    session = { bus, label, editor: null, nodeId: null };
    elements.grip.hidden = true;
    timeline.max = String(frameCount(composition.durationUs, composition.fps) - 1);
    timeline.value = '0';
    element('tool-result').textContent = '';
    current.hidden = true;
    // Before load: the stage must have the new size when the frame is laid out (D32.3).
    sizeViewport(composition);
    sizeCanvas(elements, composition);
    await player.load(composition, resolve);

    const candidates = draggableNodes(composition);
    const wanted = showcase?.dragNodeId ?? null;
    const nodeId =
      wanted !== null && candidates.includes(wanted) ? wanted : (candidates[0] ?? null);
    dragSelect.replaceChildren(
      ...candidates.map((id) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        return option;
      }),
    );
    dragSelect.value = nodeId ?? '';
    attachGrip(nodeId);
    toolCall.value = JSON.stringify(showcase?.toolCall ?? exampleCall(bus, nodeId), null, 2);
  };

  const selectShowcase = async (showcase: Showcase): Promise<void> => {
    for (const control of element('showcases').querySelectorAll('button')) {
      control.setAttribute('aria-pressed', String(control.dataset['id'] === showcase.id));
    }
    const about = element('about');
    about.replaceChildren();
    const description = document.createElement('p');
    description.textContent = showcase.description;
    const tags = document.createElement('div');
    tags.className = 'tags';
    tags.textContent = `Shows: ${showcase.features.join(', ')}`;
    about.append(description, tags);
    element('source-info').textContent =
      `Source: ${showcase.sourceFile} (served as ${showcase.url}). Edit it here and press "Load this JSON" to try a variant.`;
    const text = await textOf(showcase.url);
    source.value = text;
    await open(text, `showcase ${showcase.id}`, showcase);
  };

  // Showcases.
  for (const showcase of SHOWCASES) {
    const control = button(element('showcases'), showcase.title, () => {
      // A new hash opens the showcase through `hashchange`; the same one reloads it here.
      if (window.location.hash.slice(1) !== showcase.id) {
        window.location.hash = showcase.id;
        return undefined;
      }
      return selectShowcase(showcase);
    });
    control.dataset['id'] = showcase.id;
  }

  // Playback and history.
  const controls = element('controls');
  button(controls, 'Play', () => {
    player.play();
  });
  button(controls, 'Pause', () => {
    player.pause();
  });
  button(controls, 'Undo', async () => {
    if (session === null) return;
    if (session.editor !== null) return session.editor.undo();
    session.bus.undo();
    await rerender();
  });
  button(controls, 'Redo', async () => {
    if (session === null) return;
    if (session.editor !== null) return session.editor.redo();
    session.bus.redo();
    await rerender();
  });
  timeline.addEventListener('input', () => {
    if (session === null) return;
    const { fps } = session.bus.getDocument();
    player.seek(frameToTimeUs(Number(timeline.value), fps)).catch((reason: unknown) => {
      // A newer seek replacing this one is the normal case while the slider moves.
      if ((reason as { code?: unknown }).code !== 'superseded') report(reason);
    });
  });
  dragSelect.addEventListener('change', () => {
    attachGrip(dragSelect.value === '' ? null : dragSelect.value);
  });

  // Documents of the user's own (D32.2).
  element('load-json').addEventListener('click', () => {
    for (const control of element('showcases').querySelectorAll('button')) {
      control.setAttribute('aria-pressed', 'false');
    }
    element('source-info').textContent = 'Source: the JSON in this editor.';
    open(source.value, 'custom JSON', null).catch(report);
  });
  element('load-file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file === undefined) return;
    file
      .text()
      .then((text) => {
        source.value = text;
        element('source-info').textContent = `Source: the file ${file.name}.`;
        return open(text, `file ${file.name}`, null);
      })
      .catch(report);
  });
  element('show-current').addEventListener('click', () => {
    if (session === null) return;
    current.hidden = false;
    current.textContent = JSON.stringify(session.bus.getDocument(), null, 2);
  });

  // The AI tool of D31 on the page's bus (D32.5).
  element('run-tool').addEventListener('click', () => {
    const result = element('tool-result');
    result.textContent = '';
    if (session === null) return;
    const { bus } = session;
    try {
      const call = JSON.parse(toolCall.value) as unknown;
      if (
        typeof call !== 'object' ||
        call === null ||
        !('name' in call) ||
        !('arguments' in call)
      ) {
        throw new Error('A tool call is an object with "name" and "arguments".');
      }
      const { name, arguments: args } = call;
      if (name !== setNodePositionTool.name) {
        throw new Error(
          `This page offers one tool, ${setNodePositionTool.name}, not ${String(name)}.`,
        );
      }
      // The one capability the tool needs, and nothing else (D31.5).
      const outcome = executeSetNodePosition(
        Object.freeze({ dispatch: (command: unknown) => bus.dispatch(command) }),
        args,
      );
      result.textContent =
        outcome.inverse === null
          ? 'No change: the node already has that position.'
          : `Applied. Undo would dispatch:\n${JSON.stringify(outcome.inverse, null, 2)}`;
      rerender().catch(report);
    } catch (reason: unknown) {
      result.textContent = `Refused: ${describe(reason)}`;
    }
  });

  // What a document can use (D32.2): the IDs, types, and hashes of the generated bytes.
  const declared = (
    referenceComposition as { assets: { id: string; type: string; contentHash: string }[] }
  ).assets;
  element('assets').textContent = [
    ...declared.map(
      (asset) =>
        `${asset.id.padEnd(12)} ${asset.type.padEnd(6)} ${asset.contentHash}  (${assets.get(asset.id)?.mediaType ?? '?'})`,
    ),
    '',
    `Glyphs of the generated font: "${Object.keys(FONT_GLYPHS).join('')}"`,
    'Any other asset ID is refused by the Player as asset-missing; a changed hash as asset-hash-mismatch.',
  ].join('\n');

  // The status line, from the Player and the bus only.
  const showState = (): void => {
    const state = player.getState();
    const lines = [
      `document ${session?.label ?? '-'}`,
      `status   ${state.status}`,
      `timeUs   ${String(state.timeUs)}`,
      // Integrity, not identity: the manifest also supplied the expected hash (D25.5).
      `runtime  ${state.runtimeHash === manifest.contentHash ? 'verified against its manifest' : 'MISMATCH'}`,
    ];
    if (session !== null) {
      const { bus, nodeId } = session;
      if (nodeId !== null) {
        const { x, y } = positionOf(bus, nodeId);
        lines.push(`${nodeId}  x ${String(x)}, y ${String(y)}`);
      }
      lines.push(`history  ${bus.canUndo() ? 'undo' : '-'} / ${bus.canRedo() ? 'redo' : '-'}`);
      if (state.timeUs !== null && document.activeElement !== timeline) {
        timeline.value = String(timeUsToFrame(state.timeUs, bus.getDocument().fps));
      }
    }
    lines.push(
      `error    ${state.error === null ? '-' : `${state.error.code}: ${state.error.message}`}`,
    );
    element('status').textContent = lines.join('\n');
    requestAnimationFrame(showState);
  };
  showState();

  // A link to `#<id>` opens that showcase, also when only the hash changes.
  window.addEventListener('hashchange', () => {
    const chosen = SHOWCASES.find((showcase) => showcase.id === window.location.hash.slice(1));
    if (chosen !== undefined) selectShowcase(chosen).catch(report);
  });

  const initial =
    SHOWCASES.find((showcase) => showcase.id === window.location.hash.slice(1)) ?? SHOWCASES[0];
  if (initial !== undefined) await selectShowcase(initial);
}

main().catch((reason: unknown) => {
  element('status').textContent = `failed: ${describe(reason)}`;
});
