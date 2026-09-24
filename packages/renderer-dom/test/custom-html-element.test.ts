/**
 * The Custom HTML time contract with real element scripts (D23.3): the fixture's
 * conforming element, and an attacker element next to it. The elements run in
 * jsdom; `messaging.ts` models how a browser delivers their messages, and PR-06
 * repeats the two-element case in pinned Chromium.
 */
import { evaluateComposition } from '@kadrion/runtime';
import type { ValidatedComposition } from '@kadrion/schema';
import { referenceExpectedRender } from '@kadrion/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { mountComposition, renderState, synchronizeCustomHtml } from '../src/index.js';
import { frameFor, hostDouble } from './elements.js';
import { installMessaging, loadSrcdoc, type Delivery, type Messaging } from './messaging.js';
import { createRoot, createWindow, derived, reference, referenceUrls } from './support.js';

const VICTIM = 'node-custom-html';
const ATTACKER = 'node-attacker';

/**
 * An element that answers its own time correctly and, while doing so, reaches
 * its sibling through `parent.frames` to retime it, and answers in its name.
 */
const attackerHtml = [
  '<script>',
  "addEventListener('message', function (event) {",
  '  if (event.source !== window.parent) return;',
  '  var d = event.data;',
  '  var sibling = window.parent.frames[1];',
  "  sibling.postMessage({ type: 'kadrion:time', version: 1, instanceId: '" +
    VICTIM +
    "', requestId: d.requestId, timeUs: 9900000 }, '*');",
  "  window.parent.postMessage({ type: 'kadrion:time-ack', version: 1, instanceId: '" +
    VICTIM +
    "', requestId: d.requestId, timeUs: d.timeUs }, '*');",
  "  window.parent.postMessage({ type: 'kadrion:time-ack', version: 1, instanceId: d.instanceId, requestId: d.requestId, timeUs: d.timeUs }, '*');",
  '});',
  '</script>',
].join('\n');

/** The reference composition with the attacker placed before the victim, so it is frames[0]. */
const withAttacker: ValidatedComposition = derived((draft) => {
  const scene = draft.scenes[0];
  const victim = scene?.nodes.find((node) => node.id === VICTIM);
  if (scene === undefined || victim?.type !== 'custom-html') throw new Error('no element');
  scene.nodes.splice(scene.nodes.indexOf(victim), 0, {
    ...structuredClone(victim),
    id: ATTACKER,
    html: attackerHtml,
  });
});

let messaging: Messaging | undefined;
afterEach(() => {
  messaging?.restore();
  messaging = undefined;
});

function mounted(composition: ValidatedComposition, load: readonly string[]) {
  const window = createWindow('dangerously');
  const root = createRoot(window);
  mountComposition(root, composition, referenceUrls);
  const views = new Map(load.map((id) => [id, loadSrcdoc(frameFor(root, id))]));
  const frames = [...root.querySelectorAll('iframe')].map((frame) => {
    const view = frame.contentWindow;
    if (view === null) throw new Error('detached frame');
    return view;
  });
  messaging = installMessaging(window, frames);
  return { window, root, views, messaging };
}

const barOf = (view: Window | undefined): string =>
  view?.document.getElementById('bar')?.style.width ?? 'no bar';

describe('the conforming element of the fixture (D23.3)', () => {
  it.each(referenceExpectedRender.golden)(
    'applies $timeUs, answers exactly the hand-derived acknowledgement, and only then resolves',
    async ({ timeUs, customHtml }) => {
      const { window, root, views, messaging: log } = mounted(reference, [VICTIM]);
      const [exchange] = customHtml;
      const host = hostDouble(window, { requestId: exchange?.post.requestId ?? -1 });
      const state = evaluateComposition(reference, timeUs);
      renderState(root, state);
      await synchronizeCustomHtml(root, state, host.host);
      expect(barOf(views.get(VICTIM))).toBe(`${String(timeUs / 100_000)}%`);
      const [post] = log.log;
      expect(post?.data).toEqual(exchange?.post);
      expect(post?.posted.map(({ data }) => data)).toEqual([exchange?.acknowledgement]);
      expect(post?.posted[0]?.source).toBe(views.get(VICTIM));
    },
  );

  it('ignores a time message whose source is not its parent', async () => {
    const { window, root, views } = mounted(reference, [VICTIM]);
    const view = views.get(VICTIM);
    // The top window posting on its own behalf is the parent; a message whose
    // source is the frame itself is not.
    view?.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'kadrion:time',
          version: 1,
          instanceId: VICTIM,
          requestId: 1,
          timeUs: 5_000_000,
        },
        source: view as unknown as MessageEventSource,
      }),
    );
    expect(barOf(view)).toBe('');
    const host = hostDouble(window, { requestId: 1 });
    const pending = synchronizeCustomHtml(root, evaluateComposition(reference, 0), host.host);
    await pending;
    expect(barOf(view)).toBe('0%');
  });

  it.each([
    ['another version', { version: 2 }],
    ['another instance', { instanceId: 'node-title' }],
    ['a negative request', { requestId: -1 }],
    ['a fractional time', { timeUs: 0.5 }],
    ['an extra key', { frame: 0 }],
    ['the acknowledgement type', { type: 'kadrion:time-ack' }],
  ])('rejects a parent message with %s: no change, no answer', (_, change) => {
    const { root, views, messaging: log } = mounted(reference, [VICTIM]);
    const view = views.get(VICTIM);
    const valid = {
      type: 'kadrion:time',
      version: 1,
      instanceId: VICTIM,
      requestId: 1,
      timeUs: 5_000_000,
    };
    frameFor(root, VICTIM).contentWindow?.postMessage({ ...valid, ...change }, '*');
    expect(barOf(view)).toBe('');
    expect(log.log).toHaveLength(1);
    expect(log.log[0]?.posted).toEqual([]);
    frameFor(root, VICTIM).contentWindow?.postMessage(valid, '*');
    expect(barOf(view)).toBe('50%');
  });
});

describe('an attacker element next to the fixture element (D23.3, D23.7)', () => {
  // The harness itself: a message posted by the attacker's script carries the
  // attacker's window as its source, not the parent's.
  it('premise: the attacker reaches its sibling through parent.frames, as its own source', async () => {
    const { window, root, views, messaging: log } = mounted(withAttacker, [ATTACKER, VICTIM]);
    const host = hostDouble(window, { requestId: 75 });
    const state = evaluateComposition(withAttacker, 2_500_000);
    await synchronizeCustomHtml(root, state, host.host);
    const forged = log.log.find(
      (delivery) =>
        delivery.target === views.get(VICTIM) &&
        (delivery.data as { timeUs?: number }).timeUs === 9_900_000,
    );
    expect(forged?.source).toBe(views.get(ATTACKER));
    expect(views.get(ATTACKER)?.parent.frames[1]).toBe(views.get(VICTIM));
  });

  it('keeps the victim on the host time: the forged time is ignored and not answered', async () => {
    const { window, root, views, messaging: log } = mounted(withAttacker, [ATTACKER, VICTIM]);
    const host = hostDouble(window, { requestId: 75 });
    const state = evaluateComposition(withAttacker, 2_500_000);
    renderState(root, state);
    await synchronizeCustomHtml(root, state, host.host);
    const victim = views.get(VICTIM);
    const toVictim = log.log.filter((delivery) => delivery.target === victim);
    // First the forgery from the attacker, then the host's own message.
    expect(toVictim.map(({ source }) => (source === victim?.parent ? 'parent' : 'other'))).toEqual([
      'other',
      'parent',
    ]);
    const [forgery, genuine] = toVictim as [Delivery, Delivery];
    expect(forgery.posted).toEqual([]);
    expect(genuine.posted.map(({ data }) => data)).toEqual([
      {
        type: 'kadrion:time-ack',
        version: 1,
        instanceId: VICTIM,
        requestId: 75,
        timeUs: 2_500_000,
      },
    ]);
    expect(barOf(victim)).toBe('25%');
  });

  it("does not accept the attacker's acknowledgement in the victim's name", async () => {
    // The victim's frame stays empty and never answers; only the attacker speaks.
    const { window, root } = mounted(withAttacker, [ATTACKER]);
    const host = hostDouble(window, { requestId: 75 });
    const pending = synchronizeCustomHtml(
      root,
      evaluateComposition(withAttacker, 2_500_000),
      host.host,
    );
    host.expire();
    const error: unknown = await pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'custom-html-timeout' });
    expect((error as Error).message).toContain(`"${VICTIM}"`);
    expect((error as Error).message).not.toContain(`"${ATTACKER}"`);
  });
});
