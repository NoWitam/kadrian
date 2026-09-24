/**
 * The Producer (D28): renders frame times of a document to PNG in the pinned
 * Chromium. A render is one fresh page, one load, and then the requested frames
 * in the requested order (D28.4). The page embeds the renderer's render page as
 * the Player does (D28.1), and every frame is captured only after it was ready
 * and painted (D28.5). Every problem is a typed `ProducerError` before the
 * first frame is delivered.
 */
import {
  RENDER_PAGE_FRAME_STYLE,
  RENDER_PAGE_SANDBOX,
  RenderError,
  fontFamily,
  renderPageDocument,
  resolveAssets,
  type AssetResolver,
  type VerifiedAsset,
} from '@kadrion/renderer-dom';
import {
  frameCount,
  frameToTimeUs,
  timeUsToFrame,
  validateComposition,
  type ValidatedComposition,
} from '@kadrion/schema';
import type { Frame, Page, Request } from 'playwright-core';

import { PRODUCER_AGENT_SCRIPT } from './agent.js';
import {
  awaitPresented,
  captureFrame,
  customHtmlDocuments,
  documentsProblem,
  presentationSessions,
  type FrameDocument,
} from './capture.js';
import {
  CHROMIUM_CHANNEL,
  CHROMIUM_REVISION,
  CHROMIUM_VERSION,
  CHROMIUM_ARGS,
  PLAYWRIGHT_CORE_VERSION,
  contextOptions,
  environmentManifest,
  hostNetworkInterfaces,
  launchChromium,
  type LaunchedChromium,
} from './environment.js';
import { asProducerError, ProducerError, producerCode } from './errors.js';
import { canonicalJson, MANIFEST_VERSION, sha256, type RenderManifest } from './manifest.js';
import { loadRuntimeBuild, type RuntimeBuild } from './runtime.js';

export interface RenderTimeouts {
  /** How long the page waits for a Custom HTML acknowledgement (D23.4). */
  readonly ackTimeoutMs?: number;
  /** How long the Producer waits for the page to answer one call. */
  readonly pageTimeoutMs?: number;
  /** How long the Producer waits for every frame of the page to present (D28.5). */
  readonly presentationTimeoutMs?: number;
}

export interface RenderSessionOptions extends RenderTimeouts {
  readonly chromium: LaunchedChromium;
  readonly width: number;
  readonly height: number;
  /**
   * How many Custom HTML nodes the document has (`customHtmlNodes` of the
   * composition): the Producer refuses a page that holds another number of
   * them, so that a frame it cannot see cannot pass unchecked (D29.7).
   */
  readonly customHtmlNodes: number;
  /** The runtime build; the one of `@kadrion/renderer-dom` unless a test passes another. */
  readonly runtime?: RuntimeBuild;
}

/** What the page reports for a call of its agent. */
interface Outcome {
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string | null;
  readonly details: readonly string[];
}

interface AgentWindow {
  readonly kadrionProducer: {
    load(json: string, assets: unknown): Promise<Outcome>;
    frame(timeUs: number, requestId: number, ackTimeoutMs: number): Promise<Outcome>;
    stats(): { loads: number; frames: number };
  };
}

/** One page of the Producer, open between `openRenderSession` and `close` (D28.1). */
export interface RenderSession {
  readonly page: Page;
  /** The sandboxed frame that holds the render page. */
  readonly renderFrame: Frame;
  /**
   * Requests of the host document or the render page, each aborted; one fails the
   * render with `network-request`, because the runtime loads nothing (D28.1).
   */
  readonly requests: readonly string[];
  /**
   * Requests that a Custom HTML frame attempted: blocked by the page policy,
   * aborted as well, and recorded without failing the render, as in the Player (D28.1).
   */
  readonly blockedRequests: readonly string[];
  readonly runtime: RuntimeBuild;
  /** Loads the document with its verified assets into the render page (D27.1). */
  load(documentJson: string, assets: readonly VerifiedAsset[]): Promise<void>;
  /** Renders, waits until painted, and captures one frame (D28.4, D28.5). */
  frame(index: number, timeUs: number): Promise<Uint8Array>;
  /** How often the agent was asked to load and to render, for the tests of D28.4. */
  stats(): Promise<{ loads: number; frames: number }>;
  /** How many frames of the page run in a process of their own (measured, D28). */
  outOfProcessFrames(): Promise<number>;
  close(): Promise<void>;
}

function escapeAttribute(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/** The host document of D28.1: one sandboxed frame with the render page, at 0,0. */
export function hostDocument(runtimeScript: string, width: number, height: number): string {
  let srcdoc: string;
  try {
    srcdoc = renderPageDocument([runtimeScript, PRODUCER_AGENT_SCRIPT]);
  } catch (reason) {
    throw new ProducerError(
      'runtime-unsafe',
      reason instanceof Error ? reason.message : String(reason),
    );
  }
  const style = Object.entries({
    ...RENDER_PAGE_FRAME_STYLE,
    width: `${String(width)}px`,
    height: `${String(height)}px`,
  })
    .map(([name, value]) => `${name}: ${value}`)
    .join('; ');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;padding:0;overflow:hidden}</style>',
    `</head><body><iframe sandbox="${RENDER_PAGE_SANDBOX}" style="${style}" srcdoc="${escapeAttribute(srcdoc)}"></iframe>`,
    '</body></html>',
  ].join('');
}

async function within<T>(work: Promise<T>, milliseconds: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProducerError('page-timeout', `The render page did not ${what} in time.`));
    }, milliseconds);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function checked(outcome: Outcome): void {
  if (outcome.ok) return;
  const details = outcome.details.length > 0 ? ` ${outcome.details.join('; ')}` : '';
  throw new ProducerError(producerCode(outcome.code), `${outcome.message ?? 'Failed.'}${details}`);
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Opens a fresh page in the pinned context with the render page and its agent (D28.1). */
export async function openRenderSession(options: RenderSessionOptions): Promise<RenderSession> {
  const runtime = options.runtime ?? loadRuntimeBuild();
  const html = hostDocument(runtime.script, options.width, options.height);
  const ackTimeoutMs = options.ackTimeoutMs ?? 2_000;
  const pageTimeoutMs = options.pageTimeoutMs ?? 30_000;
  const presentationTimeoutMs = options.presentationTimeoutMs ?? 5_000;
  const context = await options.chromium.browser.newContext(
    contextOptions(options.width, options.height),
  );
  const attempts: { readonly url: string; readonly frame: Frame | null }[] = [];
  const seen = new Set<Request>();
  const record = (request: Request): void => {
    if (seen.has(request)) return;
    seen.add(request);
    let frame: Frame | null = null;
    try {
      frame = request.frame();
    } catch {
      // A request of a worker has no frame; it counts as the page's own.
    }
    attempts.push({ url: request.url(), frame });
  };
  let loaded = false;
  /** The documents of the Custom HTML frames at the first frame (D29.7). */
  let baseline: ReadonlyMap<string, FrameDocument> | null = null;
  const close = async (): Promise<void> => {
    await context.close();
  };
  try {
    await context.route('**/*', (route) => {
      record(route.request());
      return route.abort('blockedbyclient');
    });
    context.on('request', record);
    const page = await context.newPage();
    page.on('websocket', (socket) => attempts.push({ url: socket.url(), frame: null }));
    await within(page.setContent(html, { waitUntil: 'load' }), pageTimeoutMs, 'start');
    const renderFrame = page.mainFrame().childFrames()[0];
    if (renderFrame === undefined)
      throw new ProducerError('page-error', 'The page has no render frame.');
    await within(
      renderFrame.waitForFunction(() => 'kadrionProducer' in window, undefined, {
        timeout: pageTimeoutMs,
      }),
      pageTimeoutMs,
      'start',
    );
    /** A frame below the render page: a Custom HTML element or something it opened. */
    const inElement = (frame: Frame | null): boolean => {
      for (
        let current = frame?.parentFrame() ?? null;
        current !== null;
        current = current.parentFrame()
      ) {
        if (current === renderFrame) return true;
      }
      return false;
    };
    /**
     * Every Custom HTML frame still holds the document it held at the first
     * frame, and that document is its shell (D23.9, D29.7).
     */
    const sameDocuments = async (): Promise<void> => {
      const now = await customHtmlDocuments(page);
      const problem = documentsProblem(options.customHtmlNodes, baseline, now);
      if (problem !== null) {
        throw new ProducerError('custom-html-navigated', `Custom HTML: ${problem} (D23.9).`);
      }
      baseline ??= now;
    };
    const requests: string[] = [];
    const blockedRequests: string[] = [];
    const noRequests = (): void => {
      for (const { url, frame } of attempts.splice(0)) {
        (inElement(frame) ? blockedRequests : requests).push(url);
      }
      if (requests.length > 0) {
        throw new ProducerError(
          'network-request',
          `The page tried to load ${requests.join(', ')}.`,
        );
      }
    };
    return {
      page,
      renderFrame,
      requests,
      blockedRequests,
      runtime,
      async load(documentJson, assets) {
        const messages = assets.map(({ id, mediaType, bytes }) => ({
          id,
          mediaType,
          base64: base64Of(bytes),
        }));
        const outcome = await within(
          renderFrame.evaluate(
            ([json, given]) => (window as unknown as AgentWindow).kadrionProducer.load(json, given),
            [documentJson, messages] as const,
          ),
          pageTimeoutMs,
          'load',
        );
        checked(outcome);
        noRequests();
        loaded = true;
      },
      async frame(index, timeUs) {
        if (!loaded) throw new ProducerError('page-error', 'No document is loaded.');
        const outcome = await within(
          renderFrame.evaluate(
            ([time, requestId, ack]) =>
              (window as unknown as AgentWindow).kadrionProducer.frame(time, requestId, ack),
            [timeUs, index, ackTimeoutMs] as const,
          ),
          pageTimeoutMs,
          'render a frame',
        );
        checked(outcome);
        await sameDocuments();
        await awaitPresented(page, presentationTimeoutMs);
        const png = await captureFrame(page, options.width, options.height);
        await sameDocuments();
        noRequests();
        return png;
      },
      stats() {
        return renderFrame.evaluate(() =>
          (window as unknown as AgentWindow).kadrionProducer.stats(),
        );
      },
      async outOfProcessFrames() {
        const sessions = await presentationSessions(page);
        await sessions.detach();
        return sessions.outOfProcessFrames;
      },
      close,
    };
  } catch (reason) {
    await close();
    throw asProducerError(reason);
  }
}

export interface RenderRequest extends RenderTimeouts {
  readonly document: unknown;
  readonly resolveAsset: AssetResolver;
  /** Frame times of the composition, rendered in this order (D28.4). */
  readonly timesUs: readonly number[];
  /** A browser from `launchChromium` to reuse; otherwise one is launched and closed. */
  readonly chromium?: LaunchedChromium;
  readonly runtime?: RuntimeBuild;
}

export interface RenderedFrame {
  readonly index: number;
  readonly timeUs: number;
  readonly png: Uint8Array;
}

export interface RenderResult {
  readonly frames: readonly RenderedFrame[];
  readonly manifest: RenderManifest;
}

export function validated(document: unknown): ValidatedComposition {
  const result = validateComposition(document);
  if (!result.ok) {
    const details = result.errors.map(({ path, message }) => `${path}: ${message}`).join('; ');
    throw new ProducerError('invalid-document', `The document is not valid: ${details}`);
  }
  return result.composition;
}

/** The frame index of a grid time, or `frame-out-of-range` (D13.2, D28.4). */
export function frameIndexOf(composition: ValidatedComposition, timeUs: number): number {
  const { fps, durationUs } = composition;
  if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs >= durationUs) {
    throw new ProducerError(
      'frame-out-of-range',
      `timeUs must be an integer in [0, ${String(durationUs)}), got ${String(timeUs)}.`,
    );
  }
  const index = timeUsToFrame(timeUs, fps);
  if (frameToTimeUs(index, fps) !== timeUs) {
    throw new ProducerError(
      'frame-out-of-range',
      `${String(timeUs)} is not a frame time at ${String(fps)} fps; frame ${String(index)} is at ${String(frameToTimeUs(index, fps))}.`,
    );
  }
  return index;
}

export async function verifiedAssets(
  composition: ValidatedComposition,
  resolveAsset: AssetResolver,
): Promise<VerifiedAsset[]> {
  try {
    return await resolveAssets(composition, resolveAsset, (bytes) =>
      Promise.resolve(sha256(bytes)),
    );
  } catch (reason) {
    if (reason instanceof RenderError)
      throw new ProducerError(producerCode(reason.code), reason.message);
    throw asProducerError(reason);
  }
}

/** Everything a render needs that can be checked before a page opens (D28, D29.3). */
export interface PreparedRender {
  readonly composition: ValidatedComposition;
  readonly assets: readonly VerifiedAsset[];
  readonly runtime: RuntimeBuild;
}

/** How many Custom HTML nodes a composition has, groups included (D29.7). */
export function customHtmlNodes(composition: ValidatedComposition): number {
  const count = (
    nodes: readonly { readonly type: string; readonly children?: readonly unknown[] }[],
  ): number =>
    nodes.reduce(
      (total, node) =>
        total +
        (node.type === 'custom-html' ? 1 : 0) +
        count(
          (node.children ?? []) as readonly {
            readonly type: string;
            readonly children?: readonly unknown[];
          }[],
        ),
      0,
    );
  return composition.scenes.reduce((total, scene) => total + count(scene.nodes), 0);
}

/** A frame of the grid: its index and its time (D13.2). */
export interface GridFrame {
  readonly index: number;
  readonly timeUs: number;
}

/** What a frame loop reports besides its frames (D28.1). */
export interface SequenceOutcome {
  readonly blockedRequests: readonly string[];
}

/**
 * The frame loop of D28.4, shared by `renderFrames` and `exportMp4` (D29.3): one
 * page, one `load`, and then each frame in the given order, rendered, painted,
 * and captured by `RenderSession.frame`, and handed to `deliver` before the
 * next one is rendered. The frames are pulled from `frames` one at a time, so
 * a caller that streams keeps none of them.
 */
export type FrameSequence = (
  prepared: PreparedRender,
  frames: Iterable<GridFrame>,
  deliver: (frame: RenderedFrame) => Promise<void>,
) => Promise<SequenceOutcome>;

/** The frame sequence of a browser from `launchChromium`. */
export function chromiumSequence(
  chromium: LaunchedChromium,
  timeouts: RenderTimeouts,
): FrameSequence {
  return async (prepared, frames, deliver) => {
    const { composition, assets, runtime } = prepared;
    const session = await openRenderSession({
      ...timeouts,
      chromium,
      width: composition.width,
      height: composition.height,
      customHtmlNodes: customHtmlNodes(composition),
      runtime,
    });
    try {
      await session.load(JSON.stringify(composition), assets);
      for (const { index, timeUs } of frames) {
        await deliver({ index, timeUs, png: await session.frame(index, timeUs) });
      }
      return { blockedRequests: [...session.blockedRequests] };
    } catch (reason) {
      throw asProducerError(reason);
    } finally {
      await session.close();
    }
  };
}

/**
 * The part of the render manifest that describes the run, not its output
 * (D28.7). `networkInterfaces` are the host's (`hostNetworkInterfaces`) in a
 * render or an export, and a fixed list in their unit tests (D28.9).
 */
export function manifestBase(
  prepared: PreparedRender,
  chromium: LaunchedChromium,
  networkInterfaces: readonly string[],
): Omit<RenderManifest, 'preset' | 'frames' | 'blockedRequests' | 'ffmpeg'> {
  const { composition, assets, runtime } = prepared;
  return {
    manifestVersion: MANIFEST_VERSION,
    compositionHash: sha256(canonicalJson(composition)),
    schemaVersion: composition.schemaVersion,
    runtime: {
      contentHash: runtime.contentHash,
      bundler: runtime.bundler,
      compiler: runtime.compiler,
    },
    chromium: {
      playwrightCore: PLAYWRIGHT_CORE_VERSION,
      revision: CHROMIUM_REVISION,
      expectedVersion: CHROMIUM_VERSION,
      reportedVersion: chromium.reportedVersion,
      channel: CHROMIUM_CHANNEL,
      args: CHROMIUM_ARGS,
    },
    environment: environmentManifest(chromium.reportedVersion, composition, { networkInterfaces }),
    assets: assets.map(({ id, type, mediaType, contentHash }) => ({
      id,
      type,
      mediaType,
      contentHash,
      ...(type === 'font' ? { family: fontFamily(id) } : {}),
    })),
    durationUs: composition.durationUs,
    frameCount: frameCount(composition.durationUs, composition.fps),
  };
}

/**
 * Renders `timesUs` of `document` to PNG frames and returns them with the
 * render manifest of D28.7. Everything that can be checked before the page
 * opens is checked first: the document, the times, the assets, and the runtime.
 */
export async function renderFrames(request: RenderRequest): Promise<RenderResult> {
  const composition = validated(request.document);
  const grid = request.timesUs.map((timeUs) => ({
    index: frameIndexOf(composition, timeUs),
    timeUs,
  }));
  const assets = await verifiedAssets(composition, request.resolveAsset);
  const prepared: PreparedRender = {
    composition,
    assets,
    runtime: request.runtime ?? loadRuntimeBuild(),
  };
  const chromium = request.chromium ?? (await launchChromium());
  try {
    const frames: RenderedFrame[] = [];
    const { blockedRequests } = await chromiumSequence(chromium, request)(
      prepared,
      grid,
      (frame) => {
        frames.push(frame);
        return Promise.resolve();
      },
    );
    const manifest: RenderManifest = {
      ...manifestBase(prepared, chromium, hostNetworkInterfaces()),
      preset: {
        name: 'frames-png',
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        deviceScaleFactor: 1,
      },
      frames: frames.map(({ index, timeUs, png }) => ({ index, timeUs, sha256: sha256(png) })),
      blockedRequests,
      ffmpeg: null,
    };
    return { frames, manifest };
  } finally {
    if (request.chromium === undefined) await chromium.browser.close();
  }
}
