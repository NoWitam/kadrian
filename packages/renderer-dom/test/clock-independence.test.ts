/**
 * Clock independence of the renderer (specification §6.1, D20): mounting and
 * rendering succeed, with the hand-derived result, while every clock, timer,
 * frame callback, and random source throws — in the Node.js realm that runs the
 * renderer module and in the realm of the window that owns the DOM, which a
 * renderer could reach through `ownerDocument.defaultView`.
 */
import { evaluateComposition } from '@kadrion/runtime';
import { referenceExpectedRender } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { mountComposition, renderState } from '../src/index.js';
import { patchedDescriptors, withoutClocks } from './clocks.js';
import { createWindow, describeRoot, reference, referenceUrls } from './support.js';

describe('clock independence of the renderer', () => {
  const window = createWindow();
  const probes: readonly (readonly [name: string, probe: () => unknown])[] = [
    ['node Date.now', () => Date.now()],
    ['node Date', () => new Date()],
    ['node performance.now', () => performance.now()],
    ['node Math.random', () => Math.random()],
    ['node crypto.getRandomValues', () => crypto.getRandomValues(new Uint8Array(1))],
    ['node process.hrtime', () => process.hrtime()],
    ['node setTimeout', () => setTimeout(() => undefined, 0)],
    [
      'node queueMicrotask',
      () => {
        queueMicrotask(() => undefined);
      },
    ],
    ['window Date.now', () => window.eval('Date.now()')],
    ['window Date', () => window.eval('new Date()')],
    ['window performance.now', () => window.eval('performance.now()')],
    ['window Math.random', () => window.eval('Math.random()')],
    ['window setTimeout', () => window.eval('setTimeout(() => undefined, 0)')],
    ['window requestAnimationFrame', () => window.requestAnimationFrame(() => undefined)],
    [
      'window queueMicrotask',
      () => {
        window.queueMicrotask(() => undefined);
      },
    ],
  ];

  it.each(probes)('the harness really traps %s, and restores it', (name, probe) => {
    const before = patchedDescriptors([window]);
    expect(() => withoutClocks([window], probe)).toThrow(`${name} was called while rendering.`);
    expect(patchedDescriptors([window])).toEqual(before);
    expect(window.eval('Date.now()')).toBeTypeOf('number');
  });

  // Attaching a frame makes the environment create a browsing context, and jsdom,
  // like a browser, reads its own clock for the new window's time origin. That is
  // the host, not the renderer; the renderer's calls run on a detached root.
  it('premise: attaching a Custom HTML frame reads a clock of the environment', () => {
    const root = window.document.createElement('div');
    mountComposition(root, reference, referenceUrls);
    expect(() => {
      withoutClocks([window], () => {
        window.document.body.append(root);
      });
    }).toThrow('was called while rendering.');
  });

  it('mounts and renders the golden timestamps while every clock of both realms throws', () => {
    const root = window.document.createElement('div');
    const trees = withoutClocks([window], () => {
      mountComposition(root, reference, referenceUrls);
      return referenceExpectedRender.golden.map(({ timeUs }) => {
        renderState(root, evaluateComposition(reference, timeUs));
        return describeRoot(root);
      });
    });
    expect(trees).toStrictEqual(referenceExpectedRender.golden.map(({ tree }) => [tree]));
  });
});
