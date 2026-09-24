/**
 * @vitest-environment jsdom
 *
 * P4: a fixture tool call with the parameters of the P3 drag produces a
 * document whose serialised JSON is byte-identical to the P3 result (D31).
 *
 * The UI side is the playground's own `wireEditor`, driven by a pointer
 * gesture, with only the Player stubbed, exactly as in
 * `playground-drag.test.ts`; the document compared is the one the Player was
 * handed. The AI side is the committed fixture tool call, parsed from JSON and
 * run through `@kadrion/ai-sdk` on a bus of its own. The fixture is checked
 * against the payload the gesture really dispatched, so the two sides speak of
 * the same parameters rather than of two numbers that happen to match.
 */
import { readFileSync } from 'node:fs';
// jsdom replaces the global URL, whose instances node:fs does not accept.
import { URL as NodeUrl } from 'node:url';

import { busFor, wireEditor, type PreviewPlayer } from '../../apps/playground/src/app.js';
import { executeSetNodePosition, setNodePositionTool } from '@kadrion/ai-sdk';
import { createCommandBus, type CommandBus } from '@kadrion/editor-sdk';
import { referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

const NODE_ID = 'node-title';
/** 378 client pixels show 1080 composition pixels: the 0.35 of the stylesheet. */
const VIEW = { width: 378, height: 672 };

interface ToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

const fixtureCall = JSON.parse(
  readFileSync(new NodeUrl('fixtures/set-node-position.tool-call.json', import.meta.url), 'utf8'),
) as ToolCall;

function pointer(type: string, clientX: number, clientY: number): MouseEvent {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  return event;
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

interface Gesture {
  /** Every payload the UI handed to `dispatch`. */
  readonly payloads: unknown[];
  /** Every document the Player was asked to render. */
  readonly loaded: unknown[];
}

/** Drags the title on the playground's canvas by a client delta, over `document`. */
async function drag(start: unknown, dx: number, dy: number): Promise<Gesture> {
  document.body.innerHTML =
    '<div id="viewport"><div id="stage"></div><div id="overlay"><div id="grip"></div></div></div>';
  const stage = document.getElementById('stage') as HTMLElement;
  const overlay = document.getElementById('overlay') as HTMLElement;
  const grip = document.getElementById('grip') as HTMLElement;
  // jsdom lays nothing out, so the surface's box is stated here (D30.10).
  overlay.getBoundingClientRect = () => ({ ...VIEW, x: 0, y: 0, top: 0, left: 0 }) as DOMRect;

  const inner = busFor(start);
  const payloads: unknown[] = [];
  const bus: CommandBus = {
    ...inner,
    dispatch(command) {
      payloads.push(command);
      return inner.dispatch(command);
    },
  };
  const loaded: unknown[] = [];
  const player: PreviewPlayer = {
    load(next) {
      loaded.push(next);
      return Promise.resolve();
    },
    seek: () => Promise.resolve(),
    getState: () => ({ timeUs: 0 }),
  };
  const errors: unknown[] = [];
  wireEditor({
    bus,
    player,
    elements: { stage, overlay, grip },
    resolve: () => null,
    nodeId: NODE_ID,
    gripSize: 140,
    onError: (reason) => errors.push(reason),
  });
  grip.dispatchEvent(pointer('pointerdown', 100, 100));
  grip.dispatchEvent(pointer('pointermove', 100 + dx, 100 + dy));
  grip.dispatchEvent(pointer('pointerup', 100 + dx, 100 + dy));
  await settle();
  expect(errors).toEqual([]);
  return { payloads, loaded };
}

/** The arguments of a tool call for the payload a gesture dispatched: the payload minus `type`. */
function argumentsOf(payload: unknown): unknown {
  const { type, ...args } = payload as { type: unknown };
  expect(type).toBe('SetNodePosition');
  return args;
}

/** A copy of the reference composition whose title spells its position `y` before `x`. */
function yBeforeX(): unknown {
  const draft = structuredClone(referenceComposition) as {
    scenes: { nodes: { id: string; position?: unknown }[] }[];
  };
  const title = draft.scenes[0]?.nodes.find((node) => node.id === NODE_ID);
  if (title === undefined) throw new Error('The fixture has no title node.');
  title.position = { y: 160, x: 90 };
  return draft;
}

describe('an AI tool call and a canvas drag give one document (P4, D31)', () => {
  it('uses a fixture tool call with the parameters the P3 drag dispatches', async () => {
    // 35 and 70 client pixels at 0.35 are 100 and 200 composition pixels from (90, 160).
    const gesture = await drag(referenceComposition, 35, 70);
    expect(gesture.payloads).toHaveLength(1);
    expect(fixtureCall.name).toBe(setNodePositionTool.name);
    expect(fixtureCall.arguments).toEqual(argumentsOf(gesture.payloads[0]));
  });

  it('produces the document the Player received from the drag, byte for byte', async () => {
    const gesture = await drag(referenceComposition, 35, 70);
    expect(gesture.loaded).toHaveLength(1);
    const ai = executeSetNodePosition(
      createCommandBus(referenceComposition),
      fixtureCall.arguments,
    );
    expect(JSON.stringify(ai.document)).toBe(JSON.stringify(gesture.loaded[0]));
    expect(JSON.stringify(ai.document)).toContain('"position":{"x":190,"y":360}');
  });

  it('matches a drag whose parameters are fractions, which only the bus rounds', async () => {
    // 36 client pixels are 102.857… composition pixels; the UI sends the fraction.
    const gesture = await drag(referenceComposition, 36, 1);
    const [payload] = gesture.payloads;
    const args = argumentsOf(payload) as { position: { x: number; y: number } };
    expect(Number.isInteger(args.position.x)).toBe(false);
    const call = JSON.parse(
      JSON.stringify({ name: 'set_node_position', arguments: args }),
    ) as ToolCall;
    const ai = executeSetNodePosition(createCommandBus(referenceComposition), call.arguments);
    expect(JSON.stringify(ai.document)).toBe(JSON.stringify(gesture.loaded[0]));
  });

  it('matches a drag over a document that spells position as y before x', async () => {
    const gesture = await drag(yBeforeX(), 35, 70);
    const ai = executeSetNodePosition(createCommandBus(yBeforeX()), fixtureCall.arguments);
    expect(JSON.stringify(gesture.loaded[0])).toContain('"position":{"y":360,"x":190}');
    expect(JSON.stringify(ai.document)).toBe(JSON.stringify(gesture.loaded[0]));
  });
});
