/**
 * Painted, then captured (D28.5). A frame counts as painted when every frame of
 * the page — the host document, the render page, and every Custom HTML frame, on
 * whichever renderer process runs it — has produced two animation frames after
 * the runtime reported the frame ready. The wait runs in an isolated world that
 * the Producer creates in each frame through CDP: its globals are its own, so
 * neither code of an element nor a test that replaces the page's clocks can
 * answer in its place. Capture is `Page.captureScreenshot` on the page's own
 * target, which composites the out-of-process frames; Playwright's
 * `page.screenshot` is not used, because it injects a style sheet into every
 * frame. The Player's browser test measures through the same two functions.
 */
import type { CDPSession, Page } from 'playwright-core';

import { ProducerError } from './errors.js';

const WORLD = 'kadrion-presentation';
const TWO_FRAMES =
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';

interface FrameTree {
  readonly frame: { readonly id: string };
  readonly childFrames?: readonly FrameTree[];
}

function frameIds(tree: FrameTree): string[] {
  return [tree.frame.id, ...(tree.childFrames ?? []).flatMap(frameIds)];
}

/** The CDP sessions of a page: its own target, and one per out-of-process frame. */
export interface PresentationSessions {
  readonly page: CDPSession;
  readonly all: readonly CDPSession[];
  /** How many frames of the page run in a process of their own (measured, D28). */
  readonly outOfProcessFrames: number;
  detach(): Promise<void>;
}

export async function presentationSessions(page: Page): Promise<PresentationSessions> {
  const context = page.context();
  const own = await context.newCDPSession(page);
  const others: CDPSession[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      others.push(await context.newCDPSession(frame));
    } catch {
      // An in-process frame has no target of its own; its parent's session reaches it.
    }
  }
  const all = [own, ...others];
  return {
    page: own,
    all,
    outOfProcessFrames: others.length,
    async detach() {
      await Promise.all(all.map((session) => session.detach().catch(() => undefined)));
    },
  };
}

/** Waits for two animation frames in an isolated world of every frame the session reaches. */
async function presentIn(session: CDPSession, waited: Set<string>): Promise<void> {
  const { frameTree } = (await session.send('Page.getFrameTree')) as { frameTree: FrameTree };
  await Promise.all(
    frameIds(frameTree).map(async (frameId) => {
      let contextId: number;
      try {
        ({ executionContextId: contextId } = await session.send('Page.createIsolatedWorld', {
          frameId,
          worldName: WORLD,
        }));
      } catch {
        // A frame of another process: the session of that process waits for it.
        return;
      }
      const result = await session.send('Runtime.evaluate', {
        contextId,
        expression: TWO_FRAMES,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new ProducerError('presentation-timeout', 'A frame could not wait for its paint.');
      }
      waited.add(frameId);
    }),
  );
}

/**
 * Resolves with the number of frames that waited, once every frame of the page
 * has presented twice. The sessions are built again for every call, so a frame
 * that appeared since the last one is waited for too, and the call fails unless
 * it waited for exactly as many distinct frames as the page has: a frame that no
 * session reached is never captured unpainted. Rejects with
 * `presentation-timeout` after `timeoutMs`.
 */
export async function awaitPresented(page: Page, timeoutMs: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProducerError('presentation-timeout', 'The page did not present in time.'));
    }, timeoutMs);
  });
  const sessions = await presentationSessions(page);
  try {
    const waited = new Set<string>();
    await Promise.race([
      Promise.all(sessions.all.map((session) => presentIn(session, waited))),
      timeout,
    ]);
    const expected = page.frames().length;
    if (waited.size !== expected) {
      throw new ProducerError(
        'presentation-timeout',
        `Waited for ${String(waited.size)} of the ${String(expected)} frames of the page.`,
      );
    }
    return waited.size;
  } finally {
    clearTimeout(timer);
    await sessions.detach();
  }
}

/** The composition's area of the page as PNG bytes, at scale 1 (D28.5). */
export async function captureFrame(page: Page, width: number, height: number): Promise<Uint8Array> {
  const session = await page.context().newCDPSession(page);
  try {
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return new Uint8Array(Buffer.from(data, 'base64'));
  } finally {
    await session.detach().catch(() => undefined);
  }
}

interface IdentifiedFrameTree {
  readonly frame: {
    readonly id: string;
    readonly parentId?: string;
    readonly loaderId: string;
    readonly url: string;
  };
  readonly childFrames?: readonly IdentifiedFrameTree[];
}

/** The document a frame of the page holds: CDP's loader ID and its URL (D29.7). */
export interface FrameDocument {
  readonly loaderId: string;
  readonly url: string;
}

/**
 * What is wrong with the documents of the Custom HTML frames, or `null` (D29.7):
 * there must be exactly as many as the composition has Custom HTML nodes, each
 * must still hold its `srcdoc` shell, and each must hold the same document as at
 * the first frame. An empty tree is a problem, not an empty check: a frame the
 * Producer cannot see is a frame it cannot vouch for.
 */
export function documentsProblem(
  expected: number,
  baseline: ReadonlyMap<string, FrameDocument> | null,
  now: ReadonlyMap<string, FrameDocument>,
): string | null {
  if (now.size !== expected) {
    return `the page holds ${String(now.size)} Custom HTML frames, not the ${String(expected)} of the composition`;
  }
  for (const [id, { url }] of now) {
    if (url !== 'about:srcdoc') return `the frame ${id} shows ${url} instead of its shell`;
  }
  if (baseline === null) return null;
  for (const [id, { loaderId }] of baseline) {
    const current = now.get(id);
    if (current === undefined) return `the frame ${id} of the first frame is gone`;
    if (current.loaderId !== loaderId) return `the frame ${id} loaded another document`;
  }
  return null;
}

/**
 * The documents of the frames two levels below the page's main frame — the
 * frames of the Custom HTML elements inside the render page — keyed by frame ID
 * (D29.7). Every target of the page reports its own tree; a frame that runs in
 * a process of its own is taken from the tree whose root it is, because that
 * target knows its document first-hand.
 */
export async function customHtmlDocuments(page: Page): Promise<ReadonlyMap<string, FrameDocument>> {
  const sessions = await presentationSessions(page);
  try {
    const entries = new Map<
      string,
      { parentId: string | null; document: FrameDocument; root: boolean }
    >();
    for (const session of sessions.all) {
      const { frameTree } = (await session.send('Page.getFrameTree')) as {
        frameTree: IdentifiedFrameTree;
      };
      const walk = (tree: IdentifiedFrameTree, root: boolean): void => {
        const { id, parentId, loaderId, url } = tree.frame;
        const known = entries.get(id);
        // The root of an out-of-process target may not name its parent; its parent's tree does.
        const parent = parentId ?? known?.parentId ?? null;
        if (known === undefined || (root && !known.root)) {
          entries.set(id, { parentId: parent, document: { loaderId, url }, root });
        } else {
          entries.set(id, { ...known, parentId: parent });
        }
        for (const child of tree.childFrames ?? []) walk(child, false);
      };
      walk(frameTree, true);
    }
    const depth = (id: string): number => {
      let levels = 0;
      for (
        let current = entries.get(id);
        current?.parentId != null;
        current = entries.get(current.parentId)
      ) {
        levels += 1;
      }
      return levels;
    };
    const documents = new Map<string, FrameDocument>();
    for (const [id, entry] of entries) if (depth(id) === 2) documents.set(id, entry.document);
    return documents;
  } finally {
    await sessions.detach();
  }
}
