/**
 * The isolated Custom HTML element (D05, specification §7, D23): the sandboxed
 * frame that `mountComposition` builds, and the time contract of
 * `synchronizeCustomHtml`. jsdom does not load `srcdoc` and does not isolate a
 * frame, so what isolation really achieves — from inside the element — is
 * measured in Chromium by `tests/pinned` (PR-06, D28).
 */
import { evaluateComposition } from '@kadrion/runtime';
import { referenceExpectedRender } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { mountComposition, renderState, synchronizeCustomHtml } from '../src/index.js';
import { withoutClocks } from './clocks.js';
import {
  elementDouble,
  frameFor,
  hostDouble,
  REQUEST_ID,
  settledState,
  type AnswerOptions,
} from './elements.js';
import {
  createRoot,
  createWindow,
  deepFreeze,
  derived,
  describeRoot,
  reference,
  referenceUrls,
  shuffled,
} from './support.js';

const NODE = 'node-custom-html';
const goldenTimes = referenceExpectedRender.golden.map(({ timeUs }) => timeUs);
/** Protocol version 1 of D23.3, written out independently of synchronize.ts. */
const message = (type: string, timeUs: number, instanceId = NODE, requestId = REQUEST_ID) => ({
  type,
  version: 1,
  instanceId,
  requestId,
  timeUs,
});
const time = (timeUs: number, instanceId = NODE, requestId = REQUEST_ID) =>
  message('kadrion:time', timeUs, instanceId, requestId);
const ack = (timeUs: number, instanceId = NODE, requestId = REQUEST_ID) =>
  message('kadrion:time-ack', timeUs, instanceId, requestId);

/** Written out independently of `sandbox.ts` (D23.2). */
const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** A mounted reference composition in an attached root, and a double for its element. */
function mounted(composition = reference) {
  const window = createWindow();
  const root = createRoot(window);
  mountComposition(root, composition, referenceUrls);
  return { window, root };
}

/**
 * jsdom fires one `load` of its own for a mounted frame, on a later task (the
 * premise below). It takes the shell's place of D23.9, as the shell's `load`
 * does in a browser; a test that counts posts waits for it first.
 */
function ownLoad(root: Element): Promise<void> {
  const frame = frameFor(root, NODE);
  return new Promise((resolve) => {
    frame.addEventListener(
      'load',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

describe('the sandboxed frame (D23.1, D23.2)', () => {
  it('is the one child of the placeholder, with exactly sandbox, srcdoc, and style', () => {
    const { root } = mounted();
    const placeholder = root.querySelector(`[data-kadrion-node="${NODE}"]`);
    expect(placeholder?.childNodes).toHaveLength(1);
    const frame = frameFor(root, NODE);
    expect(frame.getAttributeNames()).toEqual(['sandbox', 'srcdoc', 'style']);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.hasAttribute('allow')).toBe(false);
    expect(root.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('puts the policy before every byte of the document html', () => {
    const { root } = mounted();
    const srcdoc = frameFor(root, NODE).getAttribute('srcdoc') ?? '';
    const custom = reference.scenes[0]?.nodes.find((node) => node.id === NODE);
    const html = custom?.type === 'custom-html' ? custom.html : '';
    expect(html).not.toBe('');
    expect(srcdoc.endsWith(html)).toBe(true);
    const shell = srcdoc.slice(0, srcdoc.length - html.length);
    expect(shell).toBe(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta name="kadrion-instance" content="node-custom-html"></head>`,
    );
  });

  // Sandbox flags take effect when a frame navigates: a frame that started to
  // load before `sandbox` was set would run unsandboxed in a browser, while jsdom
  // reads back the same attributes either way.
  it('gets sandbox before srcdoc, both while it is still detached', () => {
    const window = createWindow();
    const root = createRoot(window);
    const calls: (readonly [string, boolean])[] = [];
    const prototype = window.Element.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, 'setAttribute');
    Object.defineProperty(prototype, 'setAttribute', {
      configurable: true,
      value(this: Element, name: string, value: string) {
        if (this.localName === 'iframe') calls.push([name, this.isConnected]);
        (original?.value as (name: string, value: string) => void).call(this, name, value);
      },
    });
    try {
      mountComposition(root, reference, referenceUrls);
    } finally {
      if (original !== undefined) Object.defineProperty(prototype, 'setAttribute', original);
    }
    expect(calls).toEqual([
      ['sandbox', false],
      ['srcdoc', false],
    ]);
    expect(frameFor(root, NODE).isConnected).toBe(true);
  });

  it('is not written by renderState', () => {
    const { root } = mounted();
    const frame = frameFor(root, NODE);
    const before = frame.outerHTML;
    for (const timeUs of goldenTimes) renderState(root, evaluateComposition(reference, timeUs));
    expect(frame.outerHTML).toBe(before);
    expect(frameFor(root, NODE)).toBe(frame);
  });

  // If a jsdom upgrade starts loading srcdoc, the doubles below stop being the
  // only element, and these tests have to be revisited.
  it('premise: jsdom neither loads srcdoc nor runs its script', () => {
    const { root } = mounted();
    const frame = frameFor(root, NODE);
    expect(frame.contentWindow?.location.href).toBe('about:blank');
    expect(frame.contentDocument?.querySelector('#bar') ?? null).toBeNull();
  });

  it('premise: jsdom fires one load of its own for a mounted frame, on a later task, as the shell', async () => {
    const { root } = mounted();
    const frame = frameFor(root, NODE);
    const loads: boolean[] = [];
    frame.addEventListener('load', () => loads.push(frame.hasAttribute('data-kadrion-navigated')));
    expect(loads).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loads).toEqual([false]);
  });

  it('premise: the message the renderer posts reaches the frame through the real postMessage', async () => {
    const { window, root } = mounted();
    await ownLoad(root);
    const received: unknown[] = [];
    frameFor(root, NODE).contentWindow?.addEventListener('message', (event) => {
      received.push(event.data);
    });
    const host = hostDouble(window);
    const pending = synchronizeCustomHtml(
      root,
      evaluateComposition(reference, 2_500_000),
      host.host,
    );
    // jsdom delivers on a Node.js timer; wait for it, then let the host's timer expire.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual([time(2_500_000)]);
    host.expire();
    await expect(pending).rejects.toMatchObject({ code: 'custom-html-timeout' });
  });
});

describe('the time contract (D23.3, D23.4)', () => {
  it.each(referenceExpectedRender.golden)(
    'posts and accepts exactly the hand-derived messages at $timeUs',
    async ({ timeUs, customHtml }) => {
      const { window, root } = mounted();
      const element = elementDouble(window, root, NODE);
      const [exchange] = customHtml;
      const host = hostDouble(window, { requestId: exchange?.post.requestId ?? -1 });
      const state = evaluateComposition(reference, timeUs);
      renderState(root, state);
      const pending = synchronizeCustomHtml(root, state, host.host);
      expect(customHtml.map(({ nodeId }) => nodeId)).toEqual([NODE]);
      expect(element.posted).toEqual([{ message: exchange?.post, targetOrigin: '*' }]);
      expect(host.timersStarted()).toBe(1);
      expect(await settledState(pending)).toBe('pending');
      element.answer(structuredClone(exchange?.acknowledgement));
      await expect(pending).resolves.toBeUndefined();
      expect(host.listeners()).toBe(0);
      expect(host.timersCancelled()).toBe(1);
    },
  );

  it('rejects with a typed error, never resolves, when no acknowledgement arrives', async () => {
    const { window, root } = mounted();
    await ownLoad(root);
    const element = elementDouble(window, root, NODE);
    const host = hostDouble(window);
    const pending = synchronizeCustomHtml(
      root,
      evaluateComposition(reference, 5_000_000),
      host.host,
    );
    expect(await settledState(pending)).toBe('pending');
    host.expire();
    await expect(pending).rejects.toMatchObject({
      name: 'RenderError',
      code: 'custom-html-timeout',
      message: expect.stringContaining('"node-custom-html"') as unknown,
    });
    expect(host.listeners()).toBe(0);
    // A late answer after the error changes nothing and reaches no listener.
    element.answer(ack(5_000_000));
    expect(element.posted).toHaveLength(1);
  });

  const notAcknowledgements: readonly (readonly [string, unknown, AnswerOptions?])[] = [
    ['an earlier time', ack(2_500_000)],
    ['a later time', ack(7_500_000)],
    ['the time as a string', { ...ack(5_000_000), timeUs: '5000000' }],
    ['the time message itself', time(5_000_000)],
    ['another type', { ...ack(5_000_000), type: 'kadrion:time-acknowledged' }],
    ['another version', { ...ack(5_000_000), version: 2 }],
    ['another instance', ack(5_000_000, 'node-title')],
    ['another request', ack(5_000_000, NODE, REQUEST_ID + 1)],
    ['the request as a string', { ...ack(5_000_000), requestId: String(REQUEST_ID) }],
    ['an extra key', { ...ack(5_000_000), frame: 150 }],
    [
      'a missing time',
      { type: 'kadrion:time-ack', version: 1, instanceId: NODE, requestId: REQUEST_ID },
    ],
    [
      'a missing version',
      { type: 'kadrion:time-ack', instanceId: NODE, requestId: REQUEST_ID, timeUs: 5_000_000 },
    ],
    ['the protocol before D23 changed it', { type: 'kadrion:time-ack', timeUs: 5_000_000 }],
    ['an array', ['kadrion:time-ack', 5_000_000]],
    ['a string', 'kadrion:time-ack'],
    ['null', null],
    [
      'a getter',
      Object.defineProperty(
        { type: 'kadrion:time-ack', version: 1, instanceId: NODE, requestId: REQUEST_ID },
        'timeUs',
        {
          enumerable: true,
          get: () => 5_000_000,
        },
      ),
    ],
    ['a non-opaque origin', ack(5_000_000), { origin: 'https://kadrion.invalid' }],
    ['an empty origin', ack(5_000_000), { origin: '' }],
  ];

  it.each(notAcknowledgements)(
    'does not accept %s, and keeps waiting for the right answer',
    async (_, data, options) => {
      const { window, root } = mounted();
      const element = elementDouble(window, root, NODE);
      const host = hostDouble(window);
      const pending = synchronizeCustomHtml(
        root,
        evaluateComposition(reference, 5_000_000),
        host.host,
      );
      element.answer(data, options as AnswerOptions | undefined);
      expect(await settledState(pending)).toBe('pending');
      element.answer(ack(5_000_000));
      await expect(pending).resolves.toBeUndefined();
    },
  );

  it.each(notAcknowledgements)('fails when only %s arrives', async (_, data, options) => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    const host = hostDouble(window);
    const pending = synchronizeCustomHtml(
      root,
      evaluateComposition(reference, 5_000_000),
      host.host,
    );
    element.answer(data, options as AnswerOptions | undefined);
    host.expire();
    await expect(pending).rejects.toMatchObject({ code: 'custom-html-timeout' });
  });

  it('does not accept an answer from the host window or another frame', async () => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    const other = window.document.createElement('iframe');
    window.document.body.append(other);
    const host = hostDouble(window);
    const pending = synchronizeCustomHtml(root, evaluateComposition(reference, 0), host.host);
    element.answer(ack(0), { source: window });
    element.answer(ack(0), { source: other.contentWindow });
    element.answer(ack(0), { source: null });
    expect(await settledState(pending)).toBe('pending');
    host.expire();
    await expect(pending).rejects.toMatchObject({ code: 'custom-html-timeout' });
  });

  it('posts the time again when the frame loads during the wait, and not after', async () => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    const host = hostDouble(window);
    const frame = frameFor(root, NODE);
    const pending = synchronizeCustomHtml(
      root,
      evaluateComposition(reference, 7_500_000),
      host.host,
    );
    frame.dispatchEvent(new window.Event('load'));
    expect(element.posted.map(({ message }) => message)).toEqual([
      time(7_500_000),
      time(7_500_000),
    ]);
    element.answer(ack(7_500_000));
    await pending;
    frame.dispatchEvent(new window.Event('load'));
    expect(element.posted).toHaveLength(2);
  });

  it('waits for every element and names only those that did not answer', async () => {
    const twoElements = derived((draft) => {
      const scene = draft.scenes[0];
      const custom = scene?.nodes.find((node) => node.id === NODE);
      if (scene === undefined || custom?.type !== 'custom-html') throw new Error('no element');
      scene.nodes.push({ ...structuredClone(custom), id: 'node-second-html' });
    });
    const { window, root } = mounted(twoElements);
    const first = elementDouble(window, root, NODE);
    const second = elementDouble(window, root, 'node-second-html');
    const host = hostDouble(window);
    const state = evaluateComposition(twoElements, 0);
    const answered = synchronizeCustomHtml(root, state, host.host);
    expect(first.posted).toHaveLength(1);
    expect(second.posted).toHaveLength(1);
    expect(first.posted.map(({ message: posted }) => posted)).toEqual([time(0)]);
    expect(second.posted.map(({ message: posted }) => posted)).toEqual([
      time(0, 'node-second-html'),
    ]);
    first.answer(ack(0));
    // The first element answering twice, or answering in the second's name, does
    // not stand in for the second: the window it comes from decides (D23.3).
    first.answer(ack(0));
    first.answer(ack(0, 'node-second-html'));
    expect(await settledState(answered)).toBe('pending');
    second.answer(ack(0, 'node-second-html'));
    await expect(answered).resolves.toBeUndefined();

    const missing = synchronizeCustomHtml(root, state, host.host);
    second.answer(ack(0, 'node-second-html'));
    second.answer(ack(0));
    host.expire();
    const error: unknown = await missing.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'custom-html-timeout' });
    expect((error as Error).message).toContain('"node-custom-html"');
    expect((error as Error).message).not.toContain('"node-second-html"');
  });

  it('resolves at once, without a timer or a listener, when there is no element', async () => {
    const withoutElement = derived((draft) => {
      const scene = draft.scenes[0];
      if (scene !== undefined) scene.nodes = scene.nodes.filter((node) => node.id !== NODE);
    });
    const { window, root } = mounted(withoutElement);
    const host = hostDouble(window);
    await synchronizeCustomHtml(root, evaluateComposition(withoutElement, 0), host.host);
    expect(host.timersStarted()).toBe(0);
    expect(host.listeners()).toBe(0);
  });

  it('posts nothing when the host timer expires while it starts', async () => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    const host = hostDouble(window, { expireAtStart: true });
    const pending = synchronizeCustomHtml(root, evaluateComposition(reference, 0), host.host);
    await expect(pending).rejects.toMatchObject({ code: 'custom-html-timeout' });
    expect(element.posted).toEqual([]);
    expect(host.listeners()).toBe(0);
    expect(host.timersCancelled()).toBe(1);
  });
});

describe('a navigated element ends its session (D23.9)', () => {
  const NAVIGATED = 'data-kadrion-navigated';

  it('treats the first load as the shell and marks the frame on every later one, for good', () => {
    const { window, root } = mounted();
    const frame = frameFor(root, NODE);
    frame.dispatchEvent(new window.Event('load'));
    expect(frame.hasAttribute(NAVIGATED)).toBe(false);
    frame.dispatchEvent(new window.Event('load'));
    expect(frame.getAttribute(NAVIGATED)).toBe('');
    frame.dispatchEvent(new window.Event('load'));
    expect(frame.getAttribute(NAVIGATED)).toBe('');
  });

  it('rejects at once when the frame loads another document during the wait', async () => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    const host = hostDouble(window);
    const frame = frameFor(root, NODE);
    frame.dispatchEvent(new window.Event('load'));
    const pending = synchronizeCustomHtml(root, evaluateComposition(reference, 0), host.host);
    frame.dispatchEvent(new window.Event('load'));
    await expect(pending).rejects.toMatchObject({
      name: 'RenderError',
      code: 'custom-html-navigated',
      message: expect.stringContaining('"node-custom-html"') as unknown,
    });
    expect(host.listeners()).toBe(0);
    expect(host.timersCancelled()).toBe(1);
    // The new document's answer comes too late, and nothing is posted to it.
    element.answer(ack(0));
    expect(element.posted).toHaveLength(1);
  });

  it('accepts the shell loading during the wait and still ends on a navigation after it', async () => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    const host = hostDouble(window);
    const frame = frameFor(root, NODE);
    const pending = synchronizeCustomHtml(root, evaluateComposition(reference, 0), host.host);
    frame.dispatchEvent(new window.Event('load'));
    expect(element.posted).toHaveLength(2);
    frame.dispatchEvent(new window.Event('load'));
    await expect(pending).rejects.toMatchObject({ code: 'custom-html-navigated' });
    expect(element.posted).toHaveLength(2);
  });

  it('rejects a later synchronization before it posts, starts a timer, or listens', async () => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    const frame = frameFor(root, NODE);
    frame.dispatchEvent(new window.Event('load'));
    frame.dispatchEvent(new window.Event('load'));
    const host = hostDouble(window);
    await expect(
      synchronizeCustomHtml(root, evaluateComposition(reference, 2_500_000), host.host),
    ).rejects.toMatchObject({ code: 'custom-html-navigated' });
    expect(element.posted).toEqual([]);
    expect(host.timersStarted()).toBe(0);
    expect(host.listeners()).toBe(0);
  });
});

describe('checks before anything is posted (D23.4)', () => {
  const cases: readonly (readonly [string, string, (root: Element, frame: Element) => void])[] = [
    [
      'an empty root',
      'not-mounted',
      (root) => {
        root.replaceChildren();
      },
    ],
    [
      'a frame without sandbox',
      'not-mounted',
      (_, frame) => {
        frame.removeAttribute('sandbox');
      },
    ],
    [
      'a frame that may share the origin',
      'not-mounted',
      (_, frame) => {
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      },
    ],
    [
      'a frame with a src',
      'not-mounted',
      (_, frame) => {
        frame.setAttribute('src', 'https://example.invalid/');
      },
    ],
    [
      'a frame with allow',
      'not-mounted',
      (_, frame) => {
        frame.setAttribute('allow', 'camera');
      },
    ],
    [
      'a frame whose srcdoc lost the policy',
      'not-mounted',
      (_, frame) => {
        const srcdoc = frame.getAttribute('srcdoc') ?? '';
        frame.setAttribute(
          'srcdoc',
          srcdoc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
        );
      },
    ],
    [
      'a removed frame',
      'not-mounted',
      (_, frame) => {
        frame.remove();
      },
    ],
    [
      'a second child',
      'not-mounted',
      (_, frame) => frame.parentElement?.append(frame.ownerDocument.createElement('span')),
    ],
    [
      'a frame that is another element',
      'not-mounted',
      (_, frame) => {
        frame.replaceWith(frame.ownerDocument.createElement('div'));
      },
    ],
    [
      'a node in the wrong place',
      'state-mismatch',
      (root) => {
        const title = root.querySelector('[data-kadrion-node="node-title"]');
        if (title !== null) title.parentElement?.append(title);
      },
    ],
  ];

  it.each(cases)('rejects %s with %s', async (_, code, damage) => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    damage(root, frameFor(root, NODE));
    const host = hostDouble(window);
    await expect(
      synchronizeCustomHtml(root, evaluateComposition(reference, 0), host.host),
    ).rejects.toMatchObject({ name: 'RenderError', code });
    expect(element.posted).toEqual([]);
    expect(host.timersStarted()).toBe(0);
    expect(host.listeners()).toBe(0);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects the request ID %d with invalid-request',
    async (requestId) => {
      const { window, root } = mounted();
      const element = elementDouble(window, root, NODE);
      const host = hostDouble(window, { requestId });
      await expect(
        synchronizeCustomHtml(root, evaluateComposition(reference, 0), host.host),
      ).rejects.toMatchObject({ name: 'RenderError', code: 'invalid-request' });
      expect(element.posted).toEqual([]);
      expect(host.timersStarted()).toBe(0);
    },
  );
});

describe('order and repeatability on one mounted tree (specification §6.1)', () => {
  const orders = {
    ascending: goldenTimes,
    descending: [...goldenTimes].reverse(),
    shuffled: shuffled(goldenTimes, 2026_09_22),
    repeated: [...goldenTimes, ...goldenTimes],
  };

  it.each(Object.entries(orders))(
    'posts one message per instant and leaves the hand-derived tree, in %s order',
    async (_, order) => {
      const { window, root } = mounted();
      const element = elementDouble(window, root, NODE);
      const host = hostDouble(window);
      for (const timeUs of order) {
        const state = deepFreeze(evaluateComposition(reference, timeUs));
        renderState(root, state);
        const pending = synchronizeCustomHtml(root, state, host.host);
        element.answer(ack(timeUs));
        await pending;
        const expected = referenceExpectedRender.golden.find((golden) => golden.timeUs === timeUs);
        expect(describeRoot(root)).toStrictEqual([expected?.tree]);
      }
      expect(element.posted).toEqual(
        order.map((timeUs) => ({ message: time(timeUs), targetOrigin: '*' })),
      );
      expect(host.listeners()).toBe(0);
      expect(host.timersCancelled()).toBe(order.length);
    },
  );
});

describe('clock independence of the time contract (specification §6.1, D20.2)', () => {
  it('posts, accepts, and fails while every clock of both realms throws', async () => {
    const { window, root } = mounted();
    const element = elementDouble(window, root, NODE);
    const host = hostDouble(window);
    // Built outside: jsdom reads the clock when it constructs an event.
    const answers = goldenTimes.map((timeUs) => element.event(ack(timeUs)));
    const results = withoutClocks([window], () =>
      goldenTimes.map((timeUs, index) => {
        const state = evaluateComposition(reference, timeUs);
        renderState(root, state);
        const answered = synchronizeCustomHtml(root, state, host.host);
        const answer = answers[index];
        if (answer !== undefined) element.dispatch(answer);
        const expired = synchronizeCustomHtml(root, state, host.host);
        host.expire();
        return [answered, expired] as const;
      }),
    );
    for (const [answered, expired] of results) {
      await expect(answered).resolves.toBeUndefined();
      await expect(expired).rejects.toMatchObject({ code: 'custom-html-timeout' });
    }
    expect(element.posted).toHaveLength(2 * goldenTimes.length);
  });
});

// §7.6 and D23.7: what only a real browser can show. jsdom runs no script in the
// frame and enforces neither `sandbox` nor the policy, so a test here would
// prove nothing. Since PR-06 the probes run inside the element in Chromium, in
// `tests/pinned/custom-html.pinned.test.ts` and `tests/pinned/player.pinned.test.ts`
// (`node --run test:pinned`, D28).
