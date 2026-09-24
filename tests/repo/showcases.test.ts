/**
 * The showcases of the playground stay current (D32.8). Every entry of the
 * manifest must be a valid composition that the page can render with the
 * assets it generates and the glyphs of the generated font, must name a node
 * the grip may drag (D32.4), and must carry a tool call the AI tool accepts
 * (D31) — so a schema change, a new rule, or a renamed node forces the
 * showcases to follow instead of letting them rot.
 */
import { executeSetNodePosition, setNodePositionTool } from '@kadrion/ai-sdk';
import { createCommandBus } from '@kadrion/editor-sdk';
import { validateComposition } from '@kadrion/schema';
import { FONT_GLYPHS, referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import { draggableNodes } from '../../apps/playground/src/app.js';
import { SHOWCASES } from '../../apps/playground/src/showcases.js';

import { listFiles, readText } from './repo.js';

interface Node {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly children?: readonly Node[];
}

interface Document {
  readonly assets: readonly { id: string; type: string; contentHash: string }[];
  readonly scenes: readonly { nodes: readonly Node[] }[];
}

const sourceOf = (file: string): unknown => JSON.parse(readText(...file.split('/'))) as unknown;

/** The assets the page generates, as the reference composition declares them (D32.2). */
const PROVIDED = new Map(
  (referenceComposition as Document).assets.map((asset) => [asset.id, asset] as const),
);

function textsOf(document: Document): string[] {
  return document.scenes
    .flatMap((scene) => scene.nodes.flatMap((node) => [node, ...(node.children ?? [])]))
    .filter((node) => node.type === 'text')
    .map((node) => node.text ?? '');
}

describe('the showcase manifest (D32.1)', () => {
  it('has unique IDs and a built URL for every source', () => {
    const ids = SHOWCASES.map((showcase) => showcase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const showcase of SHOWCASES) {
      if (showcase.sourceFile.startsWith('apps/playground/src/showcases/')) {
        const name = showcase.sourceFile.slice('apps/playground/src/showcases/'.length);
        expect(showcase.url, showcase.id).toBe(`/app/showcases/${name}`);
      } else {
        // Only the reference fixture is shown from where the tests already keep it.
        expect(showcase.sourceFile).toBe('packages/test-fixtures/src/compositions/reference.json');
        expect(showcase.url).toBe('/pkg/test-fixtures/compositions/reference.json');
      }
    }
  });

  it('lists every JSON in the showcase directory, and no file that does not exist', () => {
    const files = listFiles('apps', 'playground', 'src', 'showcases').filter((file) =>
      file.endsWith('.json'),
    );
    const listed = SHOWCASES.map((showcase) => showcase.sourceFile).filter((file) =>
      file.startsWith('apps/'),
    );
    expect([...listed].sort()).toEqual([...files].sort());
  });
});

describe.each(SHOWCASES)('the showcase $id (D32.8)', (showcase) => {
  const source = sourceOf(showcase.sourceFile);

  it('is a valid composition', () => {
    const result = validateComposition(source);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it('uses only the assets the page generates, with their hashes', () => {
    for (const asset of (source as Document).assets) {
      expect(PROVIDED.get(asset.id), asset.id).toEqual(asset);
    }
  });

  it('writes its texts with glyphs the generated font has', () => {
    for (const text of textsOf(source as Document)) {
      const missing: string[] = [];
      // Code points, one per glyph of the generated font.
      for (const glyph of text) if (!(glyph in FONT_GLYPHS)) missing.push(glyph);
      expect(missing, text).toEqual([]);
    }
  });

  it('names a node the grip may drag (D32.4)', () => {
    if (showcase.dragNodeId !== null) {
      expect(draggableNodes(source)).toContain(showcase.dragNodeId);
    }
  });

  it('carries a tool call the AI tool accepts and applies (D31, D32.5)', () => {
    expect(Object.keys(showcase.toolCall).sort()).toEqual(['arguments', 'name']);
    expect(showcase.toolCall.name).toBe(setNodePositionTool.name);
    const bus = createCommandBus(source);
    const before = JSON.stringify(bus.getDocument());
    const result = executeSetNodePosition(
      Object.freeze({ dispatch: (command: unknown) => bus.dispatch(command) }),
      showcase.toolCall.arguments,
    );
    expect(result.inverse).not.toBeNull();
    expect(JSON.stringify(bus.getDocument())).not.toBe(before);
  });
});

describe('draggableNodes (D32.4)', () => {
  it('offers top-level nodes with a position and no position animation', () => {
    // The reference: the group and the image inside it move by animation or are
    // children; the background has no position.
    expect(draggableNodes(referenceComposition)).toEqual(['node-title', 'node-custom-html']);
  });

  it('refuses a group child and a node with a position animation', () => {
    const keyframes = sourceOf('apps/playground/src/showcases/keyframes.json');
    expect(draggableNodes(keyframes)).not.toContain('node-position');
    const group = sourceOf('apps/playground/src/showcases/group.json');
    expect(draggableNodes(group)).not.toContain('node-card-caption');
    expect(draggableNodes(group)).not.toContain('node-card-image');
  });
});
