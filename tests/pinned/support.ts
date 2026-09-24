/**
 * Shared helpers of the browser tests (D26, D28). Both hosts are measured with
 * the launch, the presentation barrier, and the capture of `@kadrion/producer`,
 * so that the Player's and the Producer's frames are comparable (D28.5).
 * Nothing here is part of a package.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  environmentManifest,
  sha256,
  type EnvironmentManifest,
  type LaunchedChromium,
  type RenderManifest,
} from '@kadrion/producer';
import type { AssetResolver } from '@kadrion/renderer-dom';
import {
  generateReferenceAssets,
  referenceComposition,
  referenceExpectedRender,
  type ExpectedElement,
} from '@kadrion/test-fixtures';
import type { CDPSession, Frame, Page } from 'playwright-core';

import { decodePng, measure, type Pixels } from '../parity/parity.js';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const WIDTH = 1080;
export const HEIGHT = 1920;

/** Gitignored output of measurements and reports. */
export const OUTPUT_DIRECTORY = join(repoRoot, '.kadrion-out');

export function writeReport(name: string, value: unknown): string {
  const file = join(OUTPUT_DIRECTORY, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

// --- assets ---------------------------------------------------------------

const generated = Object.fromEntries(
  generateReferenceAssets().map(({ id, mediaType, bytes }) => [id, { mediaType, bytes }]),
);

/** The resolver of a host that stores the generated fixture assets (D27.5). */
export const referenceResolver: AssetResolver = ({ id }) => generated[id] ?? null;

/**
 * The same resolver, recording the SHA-256 of the bytes it serves for each
 * asset: the fonts of `ci-identity.json` compare what was served, not what a
 * fixture would generate (review of PR-13).
 */
export function observingResolver(): {
  readonly resolve: AssetResolver;
  readonly served: ReadonlyMap<string, string>;
} {
  const served = new Map<string, string>();
  return {
    served,
    resolve: (request) => {
      const found = generated[request.id] ?? null;
      if (found !== null) served.set(request.id, sha256(found.bytes));
      return found;
    },
  };
}

/** The reference composition with one edit, and its assets re-pinned to `bytes`. */
export function variant(
  edit: (draft: Draft) => void,
  bytes: Readonly<Record<string, Uint8Array>> = {},
): { document: unknown; resolveAsset: AssetResolver } {
  const draft = structuredClone(referenceComposition) as Draft;
  edit(draft);
  for (const asset of draft.assets) {
    const given = bytes[asset.id];
    if (given !== undefined) asset.contentHash = sha256(given);
  }
  return {
    document: draft,
    resolveAsset: (request) => {
      const given = bytes[request.id];
      const known = generated[request.id];
      if (given !== undefined)
        return { bytes: given, mediaType: known?.mediaType ?? 'application/octet-stream' };
      return known ?? null;
    },
  };
}

export interface DraftNode {
  id: string;
  type: string;
  html?: string;
  children?: DraftNode[];
  [key: string]: unknown;
}

export interface Draft {
  assets: { id: string; type: string; contentHash: string }[];
  scenes: { id: string; nodes: DraftNode[] }[];
  [key: string]: unknown;
}

export function customHtmlNode(draft: Draft): DraftNode {
  const node = draft.scenes[0]?.nodes.find((candidate) => candidate.type === 'custom-html');
  if (node === undefined) throw new Error('The reference composition has no Custom HTML node.');
  return node;
}

// --- PNG ------------------------------------------------------------------

// One decoder and one metric for every browser test: the strict ones of D33,
// which refuse a broken PNG and frames of different sizes instead of reporting
// black pixels or a difference of -1.
export { decodePng, type Pixels } from '../parity/parity.js';

export function pixel(image: Pixels, x: number, y: number): [number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? -1, image.data[at + 1] ?? -1, image.data[at + 2] ?? -1];
}

export interface Difference {
  readonly differingPixels: number;
  readonly totalPixels: number;
  readonly share: number;
  readonly maxChannelDifference: number;
}

/** The metric of specification §6.2 (D33.4), without the histogram. */
export function difference(a: Pixels, b: Pixels): Difference {
  const { differingPixels, totalPixels, share, maxChannelDifference } = measure(a, b);
  return { differingPixels, totalPixels, share, maxChannelDifference };
}

export function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  return difference(decodePng(a), decodePng(b)).differingPixels === 0;
}

/**
 * How two frames differ, as a message: a failing pixel gate says how far apart
 * the frames were, so that a flake and a broken render can be told apart.
 */
export function pixelReport(what: string, a: Uint8Array, b: Uint8Array): string {
  const { differingPixels, maxChannelDifference } = difference(decodePng(a), decodePng(b));
  return `${what}: ${String(differingPixels)} differing pixels, at most ${String(maxChannelDifference)} per channel`;
}

// --- the Custom HTML bar and the image corner -----------------------------

export const BAR = { x: 90, y: 1760, width: 900, height: 40 } as const;
const ORANGE: [number, number, number] = [247, 144, 9];
const TRACK: [number, number, number] = [29, 41, 57];

/** The width in pixels that the fixture element shows at `timeUs`: `timeUs / 100000` percent. */
export function expectedBar(timeUs: number): number {
  return (BAR.width * timeUs) / 10_000_000;
}

/** The orange run of the bar's middle row, measured from the frame. */
export function measuredBar(image: Pixels): number {
  const row = BAR.y + BAR.height / 2;
  let run = 0;
  for (let x = BAR.x; x < BAR.x + BAR.width; x += 1) {
    const [r, g, b] = pixel(image, x, row);
    const orange = Math.abs(r - ORANGE[0]) + Math.abs(g - ORANGE[1]) + Math.abs(b - ORANGE[2]) < 30;
    const track = Math.abs(r - TRACK[0]) + Math.abs(g - TRACK[1]) + Math.abs(b - TRACK[2]) < 30;
    if (orange) run += 1;
    else if (!track) return -1;
  }
  return run;
}

/** The image node's box at a golden timestamp, derived from the hand-written expected tree. */
export function imageBox(timeUs: number): { x0: number; y0: number; x1: number; y1: number } {
  const golden = referenceExpectedRender.golden.find((candidate) => candidate.timeUs === timeUs);
  const find = (element: ExpectedElement, id: string): ExpectedElement | undefined => {
    if (element.attributes['data-kadrion-node'] === id) return element;
    for (const child of element.children) {
      if ('tag' in child) {
        const found = find(child, id);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const numbers = (element: ExpectedElement | undefined): number[] =>
    [...(element?.style.transform ?? '').matchAll(/-?[\d.]+(?:e-?\d+)?/g)].map((match) =>
      Number(match[0]),
    );
  if (golden === undefined) throw new Error(`No golden ${String(timeUs)}.`);
  const [gx = 0, gy = 0] = numbers(find(golden.tree, 'node-group'));
  const [ix = 0, iy = 0, sx = 1, sy = 1] = numbers(find(golden.tree, 'node-image'));
  return { x0: gx + ix, y0: gy + iy, x1: gx + ix + 400 * sx, y1: gy + iy + 400 * sy };
}

// --- DOM and fonts of a render page ---------------------------------------

/**
 * The render root in the shape of `expected`, read inside the render page.
 * Chromium's CSS Object Model lists `white-space` and `overflow` as their
 * longhands, where jsdom lists the shorthand (measured in PR-06), so every
 * element reports the value of each declaration the expected tree names, read
 * with `getPropertyValue`, and, under `undeclared`, every longhand it carries
 * that none of those declarations expands to. A renderer that writes one style
 * more or less than D22.3 fails either way.
 */
export async function shownTree(renderFrame: Frame, expected: unknown): Promise<unknown> {
  return renderFrame.evaluate((want) => {
    interface Want {
      tag?: string;
      style?: Record<string, string>;
      children?: Want[];
    }
    const scratch = document.createElement('div');
    const longhandsOf = (name: string, value: string): string[] => {
      scratch.removeAttribute('style');
      scratch.style.setProperty(name, value);
      return Array.from({ length: scratch.style.length }, (_, index) => scratch.style.item(index));
    };
    const describe = (node: Node, like: Want | undefined): unknown => {
      if (node.nodeType === Node.TEXT_NODE) return { text: node.textContent ?? '' };
      const element = node as HTMLElement;
      const named = like?.style ?? {};
      const covered = new Set(
        Object.entries(named).flatMap(([name, value]) => longhandsOf(name, value)),
      );
      const present = Array.from({ length: element.style.length }, (_, index) =>
        element.style.item(index),
      );
      const undeclared = present.filter((name) => !covered.has(name));
      const children = [...element.childNodes];
      return {
        tag: element.localName,
        attributes: Object.fromEntries(
          [...element.attributes]
            .filter(({ name }) => name !== 'style')
            .map(({ name, value }) => [name, value]),
        ),
        style: Object.fromEntries(
          Object.keys(named).map((name) => [name, element.style.getPropertyValue(name)]),
        ),
        ...(undeclared.length > 0 ? { undeclared } : {}),
        children: children.map((child, index) => describe(child, like?.children?.[index])),
      };
    };
    const root = document.getElementById('kadrion-root');
    const wanted = want as Want[];
    return root === null
      ? null
      : [...root.childNodes].map((child, index) => describe(child, wanted[index]));
  }, expected);
}

/** The expected tree of a golden timestamp with the `data:` URL of the generated image. */
export function expectedTree(timeUs: number): unknown {
  const golden = referenceExpectedRender.golden.find((candidate) => candidate.timeUs === timeUs);
  const image = generated['asset-image']?.bytes ?? new Uint8Array(0);
  const url = `data:image/png;base64,${Buffer.from(image).toString('base64')}`;
  return [
    JSON.parse(JSON.stringify(golden?.tree).replace('https://assets.invalid/asset-image', url)),
  ];
}

/**
 * Chromium keeps `transform` and `opacity` in single precision and serialises
 * the shortest text of that value (1.7125000000000001 reads back as 1.7125, as
 * D22 anticipated). Both trees pass through this before they are compared in a
 * browser: every number of those two declarations becomes its float32 value.
 */
export function inSinglePrecision(tree: unknown): unknown {
  return JSON.parse(JSON.stringify(tree), (key, value: unknown) =>
    (key === 'transform' || key === 'opacity') && typeof value === 'string'
      ? value.replace(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g, (text) => String(Math.fround(Number(text))))
      : value,
  ) as unknown;
}

export interface PlatformFont {
  readonly familyName: string;
  readonly isCustomFont: boolean;
  readonly glyphCount: number;
}

interface DomNode {
  readonly nodeId: number;
  readonly attributes?: readonly string[];
  readonly children?: readonly DomNode[];
  readonly contentDocument?: DomNode;
}

/** A CDP session that reaches the document of `frame`: its own target if it runs out of process. */
export async function frameSession(page: Page, frame: Frame): Promise<CDPSession> {
  try {
    return await page.context().newCDPSession(frame);
  } catch {
    return page.context().newCDPSession(page);
  }
}

/** The platform fonts Chromium used for the text of every text node of the render page (D27). */
export async function fontsUsed(session: CDPSession): Promise<Record<string, PlatformFont[]>> {
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as {
    root: DomNode;
  };
  const found: Record<string, number> = {};
  const visit = (node: DomNode): void => {
    const attributes = node.attributes ?? [];
    const at = attributes.indexOf('data-kadrion-node');
    const id = at >= 0 ? attributes[at + 1] : undefined;
    if (id === 'node-title' || id === 'node-caption') found[id] = node.nodeId;
    for (const child of node.children ?? []) visit(child);
    if (node.contentDocument !== undefined) visit(node.contentDocument);
  };
  visit(root);
  const result: Record<string, PlatformFont[]> = {};
  for (const [id, nodeId] of Object.entries(found)) {
    const { fonts } = (await session.send('CSS.getPlatformFontsForNode', { nodeId })) as {
      fonts: PlatformFont[];
    };
    result[id] = fonts.map(({ familyName, isCustomFont, glyphCount }) => ({
      familyName,
      isCustomFont,
      glyphCount,
    }));
  }
  return result;
}

// --- golden frames (D26.5) ------------------------------------------------

export const GOLDEN_DIRECTORY = join(repoRoot, 'packages', 'test-fixtures', 'src', 'golden-frames');
export const GOLDEN_MANIFEST = join(GOLDEN_DIRECTORY, 'reference.golden-frames.json');

export interface GoldenFile {
  readonly render: RenderManifest;
  readonly environment: EnvironmentManifest;
  readonly frames: readonly { file: string; timeUs: number; index: number; sha256: string }[];
}

export function goldenFileName(timeUs: number): string {
  return `reference-${String(timeUs)}.png`;
}

/** The committed golden frames, or `null` when none exist yet. */
export function readGoldens(): { manifest: GoldenFile; frames: Map<number, Uint8Array> } | null {
  if (!existsSync(GOLDEN_MANIFEST)) return null;
  const manifest = JSON.parse(readFileSync(GOLDEN_MANIFEST, 'utf8')) as GoldenFile;
  const frames = new Map(
    manifest.frames.map(({ file, timeUs }) => [
      timeUs,
      new Uint8Array(readFileSync(join(GOLDEN_DIRECTORY, file))),
    ]),
  );
  return { manifest, frames };
}

export function writeGoldens(file: GoldenFile, frames: ReadonlyMap<number, Uint8Array>): void {
  mkdirSync(dirname(GOLDEN_MANIFEST), { recursive: true });
  for (const { file: name, timeUs } of file.frames) {
    const png = frames.get(timeUs);
    if (png === undefined) throw new Error(`No frame for ${String(timeUs)}.`);
    writeFileSync(join(GOLDEN_DIRECTORY, name), png);
  }
  writeFileSync(GOLDEN_MANIFEST, `${JSON.stringify(file, null, 2)}\n`);
}

/** Whether this run is the pinned environment of D26.2. */
export function pinnedRun(chromium: LaunchedChromium): EnvironmentManifest {
  return environmentManifest(chromium.reportedVersion, { width: WIDTH, height: HEIGHT });
}
