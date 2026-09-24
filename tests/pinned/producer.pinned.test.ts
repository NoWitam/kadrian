/**
 * P2 in Chromium (D26, D28): the Producer renders the five golden timestamps of
 * the reference composition to PNG. Repeatability, order independence, and
 * clock independence (§6.1), the typed errors before the first frame, the
 * rendered tree and the fonts, and pixel checks that need no golden file.
 * Golden frames are compared only in the pinned environment (D26.2); anywhere
 * else this file proves nothing about P2 and says so.
 */
import { rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import {
  awaitPresented,
  captureFrame,
  launchChromium,
  networkFacts,
  openRenderSession,
  PINNED_IMAGE,
  PINNED_IMAGE_VARIABLE,
  renderFrames,
  sha256,
  type LaunchedChromium,
  type RenderResult,
} from '@kadrion/producer';
import { resolveAssets } from '@kadrion/renderer-dom';
import { goldenTimestamps, referenceComposition } from '@kadrion/test-fixtures';
import { validateComposition } from '@kadrion/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  customHtmlNode,
  decodePng,
  difference,
  expectedBar,
  expectedTree,
  fontsUsed,
  frameSession,
  goldenFileName,
  HEIGHT,
  imageBox,
  inSinglePrecision,
  measuredBar,
  pinnedRun,
  pixel,
  readGoldens,
  observingResolver,
  OUTPUT_DIRECTORY,
  referenceResolver,
  pixelReport,
  samePixels,
  shownTree,
  variant,
  WIDTH,
  writeReport,
} from './support.js';

const times = goldenTimestamps.map(({ timeUs }) => timeUs);
let chromium: LaunchedChromium;
let baseline: RenderResult;

const observed = observingResolver();
const render = (timesUs: readonly number[], document: unknown = referenceComposition) =>
  renderFrames({ document, resolveAsset: observed.resolve, timesUs, chromium });

const frameAt = (result: RenderResult, timeUs: number): Uint8Array => {
  const found = result.frames.find((frame) => frame.timeUs === timeUs);
  if (found === undefined) throw new Error(`No frame at ${String(timeUs)}.`);
  return found.png;
};

beforeAll(async () => {
  chromium = await launchChromium();
  baseline = await render(times);
});

afterAll(async () => {
  await chromium.browser.close();
});

describe('the pinned Chromium (D26.3)', () => {
  it('records the network interfaces this host reports, not assumed ones (D28.9)', () => {
    expect(baseline.manifest.environment.network).toEqual(
      networkFacts(Object.keys(networkInterfaces())),
    );
  });

  it('reports the expected build', () => {
    expect(chromium.reportedVersion).toBe('153.0.8010.12');
    expect(baseline.manifest.chromium).toMatchObject({
      playwrightCore: '1.63.0',
      revision: '1243',
      expectedVersion: '153.0.8010.12',
      reportedVersion: '153.0.8010.12',
      channel: 'chromium',
    });
  });
});

describe('P2: the five golden timestamps (D28.4, D28.7)', () => {
  it('are rendered as 1080 x 1920 PNG frames, with their frame indices and hashes', () => {
    expect(baseline.frames.map(({ index, timeUs }) => [index, timeUs])).toEqual(
      goldenTimestamps.map(({ frame, timeUs }) => [frame, timeUs]),
    );
    for (const frame of baseline.frames) {
      const image = decodePng(frame.png);
      expect([image.width, image.height]).toEqual([WIDTH, HEIGHT]);
    }
    expect(baseline.manifest.frames.map(({ sha256: hash }) => hash)).toEqual(
      baseline.frames.map(({ png }) => sha256(png)),
    );
  });

  it('record the render manifest of §8', () => {
    const { manifest } = baseline;
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      schemaVersion: '0.1',
      preset: { name: 'frames-png', width: 1080, height: 1920, fps: 30, deviceScaleFactor: 1 },
      durationUs: 10_000_000,
      frameCount: 300,
      ffmpeg: null,
    });
    expect(manifest.compositionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.assets).toEqual([
      expect.objectContaining({ id: 'asset-image', type: 'image', mediaType: 'image/png' }),
      expect.objectContaining({ id: 'asset-audio', type: 'audio', mediaType: 'audio/wav' }),
      expect.objectContaining({
        id: 'asset-font',
        type: 'font',
        mediaType: 'font/ttf',
        family: 'kadrion-font-asset-font',
      }),
    ]);
    expect(Object.keys(manifest).join()).not.toMatch(/time(stamp)?At|date|elapsed/i);
  });

  it('show the Custom HTML bar at the width of each time (D23, D28.5)', () => {
    for (const timeUs of times) {
      expect(measuredBar(decodePng(frameAt(baseline, timeUs))), String(timeUs)).toBe(
        expectedBar(timeUs),
      );
    }
  });

  it('place the scaled image inside its group at the box of the expected tree (D22)', () => {
    for (const timeUs of times) {
      const image = decodePng(frameAt(baseline, timeUs));
      const box = imageBox(timeUs);
      const inside = (x: number, y: number) => pixel(image, Math.round(x), Math.round(y));
      // The generated image has a white border; the background is #0b1020.
      expect(inside(box.x0 + 3, box.y0 + 3), `${String(timeUs)} top-left`).toEqual([255, 255, 255]);
      expect(inside(box.x1 - 4, box.y1 - 4), `${String(timeUs)} bottom-right`).toEqual([
        255, 255, 255,
      ]);
      expect(inside(box.x0 - 3, box.y0 - 3), `${String(timeUs)} outside`).toEqual([11, 16, 32]);
      expect(inside(box.x1 + 3, box.y1 + 3), `${String(timeUs)} outside`).toEqual([11, 16, 32]);
    }
  });

  it('are compared with the golden frames in the pinned environment only (D26.5)', () => {
    const environment = pinnedRun(chromium);
    const goldens = readGoldens();
    const report = times.map((timeUs) => {
      const golden = goldens?.frames.get(timeUs);
      return {
        timeUs,
        file: goldenFileName(timeUs),
        difference:
          golden === undefined
            ? null
            : difference(decodePng(golden), decodePng(frameAt(baseline, timeUs))),
      };
    });
    // A run that claims the pinned image never falls back to a report: CI (Q14,
    // criterion 8) and the reference run set the variable (D26.2).
    const claimed = process.env[PINNED_IMAGE_VARIABLE];
    // A comparison that fails its gate is kept for diagnosis, but never under the
    // name of a good one, which CI publishes and Q14 evidence requires.
    const failed =
      (claimed !== undefined && (claimed !== PINNED_IMAGE || !environment.pinned)) ||
      (environment.pinned &&
        (goldens?.manifest.environment.pinned !== true ||
          report.some(
            (row) =>
              row.difference?.differingPixels !== 0 || row.difference.maxChannelDifference !== 0,
          )));
    for (const name of ['golden-comparison.json', 'golden-comparison.failed.json']) {
      rmSync(join(OUTPUT_DIRECTORY, name), { force: true });
    }
    writeReport(failed ? 'golden-comparison.failed.json' : 'golden-comparison.json', {
      environment,
      goldens: goldens !== null,
      report,
      assetsServed: [...observed.served]
        .map(([id, hash]) => ({ id, sha256: hash }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    });
    if (claimed !== undefined) {
      expect(claimed, `${PINNED_IMAGE_VARIABLE} names another image`).toBe(PINNED_IMAGE);
      expect(environment.pinned, 'a run that claims the pinned image is not pinned').toBe(true);
    }
    if (!environment.pinned) {
      // Informative only (§5 P2): nothing is asserted against goldens outside the container.
      console.info(
        `Not the pinned environment (${environment.os}/${environment.arch}, image ${String(environment.image)}): golden frames are not asserted. P2 is not proven by this run.`,
      );
      return;
    }
    expect(
      goldens,
      'Run "node --run goldens:update" in the pinned container first.',
    ).not.toBeNull();
    expect(goldens?.manifest.environment.pinned).toBe(true);
    for (const { timeUs, difference: found } of report) {
      expect(found?.differingPixels, String(timeUs)).toBe(0);
    }
  });
});

describe('determinism of the reference output (§6.1)', () => {
  it('repeats: three renders, each in a fresh page, give identical pixels', async () => {
    const renders = [baseline, await render(times), await render(times)];
    for (const timeUs of times) {
      const [first, ...rest] = renders.map((result) => frameAt(result, timeUs));
      for (const other of rest)
        expect(
          samePixels(first ?? new Uint8Array(0), other),
          pixelReport(`repeat of ${String(timeUs)}`, first ?? new Uint8Array(0), other),
        ).toBe(true);
    }
  });

  it.each([
    ['descending', [...times].reverse()],
    ['shuffled', [times[2], times[0], times[4], times[1], times[3]]],
  ])('is independent of order: %s in one page gives the same frames', async (_, order) => {
    const result = await render(order as number[]);
    for (const timeUs of times) {
      expect(
        samePixels(frameAt(baseline, timeUs), frameAt(result, timeUs)),
        pixelReport(String(timeUs), frameAt(baseline, timeUs), frameAt(result, timeUs)),
      ).toBe(true);
    }
  });

  it('loads once per render and renders every frame in the same page (D28.4)', async () => {
    const composition = validateComposition(referenceComposition);
    if (!composition.ok) throw new Error('invalid');
    const session = await openRenderSession({
      chromium,
      width: WIDTH,
      height: HEIGHT,
      customHtmlNodes: 1,
    });
    try {
      const assets = await resolveAssets(composition.composition, referenceResolver, (bytes) =>
        Promise.resolve(sha256(bytes)),
      );
      await session.load(JSON.stringify(composition.composition), assets);
      await session.frame(0, 0);
      await session.frame(297, 9_900_000);
      await expect(session.stats()).resolves.toEqual({ loads: 1, frames: 2 });
    } finally {
      await session.close();
    }
  });

  it('does not depend on the clocks of the page: they throw, and the frames are the same', async () => {
    const composition = validateComposition(referenceComposition);
    if (!composition.ok) throw new Error('invalid');
    const session = await openRenderSession({
      chromium,
      width: WIDTH,
      height: HEIGHT,
      customHtmlNodes: 1,
    });
    try {
      // After the agent captured its timer and font constructor, and before anything renders.
      const poisoned = await session.renderFrame.evaluate(() => {
        const fail = (name: string) => () => {
          throw new Error(`${name} is poisoned`);
        };
        const view = window as unknown as Record<string, unknown>;
        for (const name of [
          'setTimeout',
          'setInterval',
          'requestAnimationFrame',
          'requestIdleCallback',
          'queueMicrotask',
          'FontFace',
        ]) {
          view[name] = fail(name);
        }
        Date.now = fail('Date.now');
        view.Date = fail('Date');
        Object.defineProperty(performance, 'now', { value: fail('performance.now') });
        Math.random = fail('Math.random');
        const probes: Record<string, string> = {};
        for (const [name, call] of Object.entries({
          'Date.now': () => Date.now(),
          'performance.now': () => performance.now(),
          setTimeout: () => setTimeout(() => undefined, 0),
          requestAnimationFrame: () => requestAnimationFrame(() => undefined),
          'Math.random': () => Math.random(),
        })) {
          try {
            call();
            probes[name] = 'ran';
          } catch {
            probes[name] = 'threw';
          }
        }
        return probes;
      });
      // Premise: the page's clocks really throw now.
      expect(Object.values(poisoned)).toEqual(['threw', 'threw', 'threw', 'threw', 'threw']);
      const assets = await resolveAssets(composition.composition, referenceResolver, (bytes) =>
        Promise.resolve(sha256(bytes)),
      );
      await session.load(JSON.stringify(composition.composition), assets);
      for (const { frame, timeUs } of goldenTimestamps) {
        const png = await session.frame(frame, timeUs);
        expect(
          samePixels(frameAt(baseline, timeUs), png),
          pixelReport(String(timeUs), frameAt(baseline, timeUs), png),
        ).toBe(true);
      }
    } finally {
      await session.close();
    }
  });
});

describe('the rendered page (D22, D27)', () => {
  it('holds the hand-derived tree at every golden timestamp, and loads nothing', async () => {
    const composition = validateComposition(referenceComposition);
    if (!composition.ok) throw new Error('invalid');
    const session = await openRenderSession({
      chromium,
      width: WIDTH,
      height: HEIGHT,
      customHtmlNodes: 1,
    });
    try {
      const assets = await resolveAssets(composition.composition, referenceResolver, (bytes) =>
        Promise.resolve(sha256(bytes)),
      );
      await session.load(JSON.stringify(composition.composition), assets);
      for (const { frame, timeUs } of goldenTimestamps) {
        await session.frame(frame, timeUs);
        const shown = await shownTree(session.renderFrame, expectedTree(timeUs));
        expect(inSinglePrecision(shown), String(timeUs)).toEqual(
          inSinglePrecision(expectedTree(timeUs)),
        );
      }
      const view = await session.renderFrame.evaluate(() => ({
        dpr: devicePixelRatio,
        origin: self.origin,
        width: innerWidth,
        height: innerHeight,
      }));
      expect(view).toEqual({ dpr: 1, origin: 'null', width: WIDTH, height: HEIGHT });
      // Every text node is drawn with the fixture font only: no system fallback (D27).
      const fonts = await fontsUsed(await frameSession(session.page, session.renderFrame));
      expect(fonts).toEqual({
        'node-title': [{ familyName: 'Kadrion Fixture', isCustomFont: true, glyphCount: 7 }],
        'node-caption': [{ familyName: 'Kadrion Fixture', isCustomFont: true, glyphCount: 23 }],
      });
      expect(session.requests).toEqual([]);
      writeReport('producer-processes.json', {
        outOfProcessFrames: await session.outOfProcessFrames(),
        note: 'Frames of the page with a CDP target of their own (D28.5); informative outside the pinned environment.',
      });
    } finally {
      await session.close();
    }
  });
});

describe('typed errors before the first frame (D28.6)', () => {
  const silent = variant((draft) => {
    customHtmlNode(draft).html = '<p>no answer</p>';
  });
  const corruptImage = variant(() => undefined, {
    'asset-image': Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13),
  });
  const corruptFont = variant(() => undefined, { 'asset-font': Uint8Array.of(0, 1, 0, 0, 0, 0) });

  it.each([
    ['a Custom HTML element that never answers', silent, 'custom-html-timeout'],
    ['an image that does not decode', corruptImage, 'asset-decode-failed'],
    ['a font that does not load', corruptFont, 'font-load-failed'],
    [
      'a missing asset',
      { document: referenceComposition, resolveAsset: () => null },
      'asset-missing',
    ],
    [
      'bytes of another hash',
      {
        document: referenceComposition,
        resolveAsset: () => ({ bytes: Uint8Array.of(1), mediaType: 'image/png' }),
      },
      'asset-hash-mismatch',
    ],
  ])('reports %s and delivers no frame', async (_, { document, resolveAsset }, code) => {
    await expect(
      renderFrames({ document, resolveAsset, timesUs: [0], chromium, ackTimeoutMs: 300 }),
    ).rejects.toMatchObject({ name: 'ProducerError', code });
  });

  // D28.1: the runtime loads nothing, so a request of the render page itself fails
  // the render; a Custom HTML element's attempt does not (custom-html.pinned.test.ts).
  it('fails with network-request when the render page itself requests something', async () => {
    const composition = validateComposition(referenceComposition);
    if (!composition.ok) throw new Error('invalid');
    const session = await openRenderSession({
      chromium,
      width: WIDTH,
      height: HEIGHT,
      customHtmlNodes: 1,
    });
    try {
      const assets = await resolveAssets(composition.composition, referenceResolver, (bytes) =>
        Promise.resolve(sha256(bytes)),
      );
      await session.load(JSON.stringify(composition.composition), assets);
      await session.renderFrame.evaluate(() => {
        const image = new Image();
        image.src = 'https://kadrion-probe.invalid/from-the-render-page.png';
      });
      await expect(session.frame(0, 0)).rejects.toMatchObject({ code: 'network-request' });
      expect(session.blockedRequests).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe('the presentation barrier (D25, D28.5)', () => {
  /** An element that adds a nested frame of its own after its first acknowledgement. */
  const nesting = variant((draft) => {
    customHtmlNode(draft).html = [
      "<!doctype html><meta charset='utf-8'><div id='bar'></div><script>(function(){var added=false;",
      "var id=document.querySelector('meta[name=kadrion-instance]').getAttribute('content');",
      "addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.type!=='kadrion:time')return;",
      "window.parent.postMessage({type:'kadrion:time-ack',version:1,instanceId:id,requestId:d.requestId,timeUs:d.timeUs},'*');",
      "if(!added){added=true;var f=document.createElement('iframe');f.setAttribute('srcdoc','<p>nested</p>');document.body.appendChild(f)}})})()",
      '</script>',
    ].join('');
  });

  it('waits for every frame of the page, including one that appeared after the load', async () => {
    const composition = validateComposition(nesting.document);
    if (!composition.ok) throw new Error('invalid');
    const session = await openRenderSession({
      chromium,
      width: WIDTH,
      height: HEIGHT,
      customHtmlNodes: 1,
    });
    try {
      const assets = await resolveAssets(composition.composition, nesting.resolveAsset, (bytes) =>
        Promise.resolve(sha256(bytes)),
      );
      await session.load(JSON.stringify(composition.composition), assets);
      await session.frame(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const frames = session.page.frames().length;
      // Premise: host, render page, element, and the element's own frame.
      expect(frames).toBe(4);
      await expect(awaitPresented(session.page, 5_000)).resolves.toBe(frames);
      await session.frame(75, 2_500_000);
    } finally {
      await session.close();
    }
  });

  /**
   * An element that replaces its own `requestAnimationFrame` so that it answers
   * at once, acknowledges the time, and applies it only in the next real
   * animation frame: a barrier in the page's realm would be fooled.
   */
  const late = variant((draft) => {
    customHtmlNode(draft).html = [
      "<!doctype html><meta charset='utf-8'><style>html,body{margin:0;height:100%;background:#1d2939}#bar{width:0;height:100%;background:#f79009}</style><div id='bar'></div><script>",
      '(function(){var real=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){cb(0);return 0};',
      "var id=document.querySelector('meta[name=kadrion-instance]').getAttribute('content');",
      "addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.type!=='kadrion:time')return;",
      "window.parent.postMessage({type:'kadrion:time-ack',version:1,instanceId:id,requestId:d.requestId,timeUs:d.timeUs},'*');",
      "real(function(){document.getElementById('bar').style.width=d.timeUs/100000+'%'})})})()",
      '</script>',
    ].join('');
  });

  it('captures an element that paints one frame after its acknowledgement with its new state', async () => {
    const order = [9_900_000, 0, 7_500_000, 2_500_000, 5_000_000, 0];
    const result = await renderFrames({ ...late, timesUs: order, chromium });
    result.frames.forEach(({ timeUs, png }) => {
      expect(measuredBar(decodePng(png)), String(timeUs)).toBe(expectedBar(timeUs));
    });
  });

  it('is measured: captures without it, right after ready, are reported', async () => {
    const composition = validateComposition(late.document);
    if (!composition.ok) throw new Error('invalid');
    const session = await openRenderSession({
      chromium,
      width: WIDTH,
      height: HEIGHT,
      customHtmlNodes: 1,
    });
    const rows: {
      timeUs: number;
      withoutBarrier: number;
      withBarrier: number;
      expected: number;
    }[] = [];
    try {
      const assets = await resolveAssets(composition.composition, late.resolveAsset, (bytes) =>
        Promise.resolve(sha256(bytes)),
      );
      await session.load(JSON.stringify(composition.composition), assets);
      for (let round = 0; round < 6; round += 1) {
        const timeUs = round % 2 === 0 ? 9_900_000 : 0;
        const outcome = await session.renderFrame.evaluate(
          ([time, id]) =>
            (
              window as unknown as {
                kadrionProducer: {
                  frame(t: number, r: number, a: number): Promise<{ ok: boolean }>;
                };
              }
            ).kadrionProducer.frame(time, id, 2_000),
          [timeUs, 1_000 + round] as const,
        );
        expect(outcome.ok).toBe(true);
        const immediate = measuredBar(decodePng(await captureFrame(session.page, WIDTH, HEIGHT)));
        await awaitPresented(session.page, 5_000);
        const presented = measuredBar(decodePng(await captureFrame(session.page, WIDTH, HEIGHT)));
        rows.push({
          timeUs,
          withoutBarrier: immediate,
          withBarrier: presented,
          expected: expectedBar(timeUs),
        });
      }
    } finally {
      await session.close();
    }
    const stale = rows.filter((row) => row.withoutBarrier !== row.expected).length;
    writeReport('presentation-barrier.json', {
      rows,
      staleWithoutBarrier: stale,
      note: 'Informative outside the pinned environment (D28).',
    });
    console.info(
      `Presentation barrier: ${String(stale)} of ${String(rows.length)} captures without it were stale.`,
    );
    for (const row of rows) expect(row.withBarrier).toBe(row.expected);
  });
});
