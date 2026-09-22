import { goldenTimestamps, referenceComposition } from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import {
  frameCount,
  validateComposition,
  type Composition,
  type NodeAnimation,
  type SceneNode,
} from '../src/index.js';

function validReference(): Composition {
  const result = validateComposition(referenceComposition);
  if (!result.ok) {
    const errors = JSON.stringify(result.errors, null, 2);
    throw new Error(`The reference composition does not validate against schema 0.1: ${errors}`);
  }
  return result.composition;
}

const composition = validReference();
const nodes: SceneNode[] = composition.scenes.flatMap((scene) =>
  scene.nodes.flatMap((node): SceneNode[] =>
    node.type === 'group' ? [node, ...node.children] : [node],
  ),
);
const animations: NodeAnimation[] = nodes.flatMap((node) =>
  node.type === 'background' ? [] : node.animations,
);
const nodeById = (id: string): SceneNode | undefined => nodes.find((node) => node.id === id);
const entry = (key: string, value: string): [string, string] => [key, value];

describe('reference composition', () => {
  it('validates against schema 0.1', () => {
    expect(validateComposition(referenceComposition)).toEqual({
      ok: true,
      composition: referenceComposition,
    });
  });

  it('has the fixed parameters of specification §3.1', () => {
    expect(composition).toMatchObject({
      schemaVersion: '0.1',
      width: 1080,
      height: 1920,
      fps: 30,
      durationUs: 10_000_000,
    });
    expect(frameCount(composition.durationUs, composition.fps)).toBe(300);
  });

  it('contains exactly the inventory of specification §3.2', () => {
    const inventory = Object.fromEntries([
      ...composition.scenes.map((scene) => entry(scene.id, 'scene')),
      ...nodes.map((node) => entry(node.id, `node:${node.type}`)),
      ...composition.clips.map((clip) => entry(clip.id, `clip:${clip.type}`)),
      ...animations.map((animation) => entry(animation.id, `animation:${animation.property}`)),
      ...composition.assets.map((asset) => entry(asset.id, `asset:${asset.type}`)),
    ]);
    expect(inventory).toEqual({
      'scene-main': 'scene',
      'node-background': 'node:background',
      'node-group': 'node:group',
      'node-image': 'node:image',
      'node-title': 'node:text',
      'node-caption': 'node:text',
      'node-custom-html': 'node:custom-html',
      'clip-audio': 'clip:audio',
      'anim-title-opacity': 'animation:opacity',
      'anim-group-position': 'animation:position',
      'anim-image-scale': 'animation:scale',
      'asset-image': 'asset:image',
      'asset-audio': 'asset:audio',
      'asset-font': 'asset:font',
    });
  });

  it('wires the inventory as specification §3.2 describes', () => {
    const group = nodeById('node-group');
    const children = group?.type === 'group' ? group.children.map((child) => child.id) : [];
    expect(children).toEqual(['node-image', 'node-caption']);

    const owners = Object.fromEntries(
      nodes.flatMap((node) =>
        node.type === 'background' ? [] : node.animations.map(({ id }) => entry(id, node.id)),
      ),
    );
    expect(owners).toEqual({
      'anim-title-opacity': 'node-title',
      'anim-group-position': 'node-group',
      'anim-image-scale': 'node-image',
    });

    expect(nodes.flatMap((node) => (node.type === 'text' ? [node.fontAssetId] : []))).toEqual([
      'asset-font',
      'asset-font',
    ]);
    expect(nodes.flatMap((node) => (node.type === 'image' ? [node.assetId] : []))).toEqual([
      'asset-image',
    ]);
    expect(composition.clips).toEqual([
      {
        id: 'clip-audio',
        type: 'audio',
        assetId: 'asset-audio',
        startUs: 0,
        durationUs: 10_000_000,
      },
    ]);
  });

  it('puts the background at the bottom of the z-order', () => {
    expect(composition.scenes[0]?.nodes[0]?.type).toBe('background');
  });

  it('samples holds before a first keyframe and after a last keyframe', () => {
    const times = goldenTimestamps.map((golden) => golden.timeUs);
    const first = (animation: NodeAnimation): number => animation.keyframes[0]?.timeUs ?? 0;
    const last = (animation: NodeAnimation): number => animation.keyframes.at(-1)?.timeUs ?? 0;
    expect(animations.some((animation) => times.some((t) => t < first(animation)))).toBe(true);
    expect(animations.some((animation) => times.some((t) => t > last(animation)))).toBe(true);
  });

  it('is deeply frozen, because every consumer shares the same module instance', () => {
    expect(Object.isFrozen(composition)).toBe(true);
    expect(nodes.every((node) => Object.isFrozen(node))).toBe(true);
    expect(animations.every((animation) => Object.isFrozen(animation.keyframes))).toBe(true);
  });
});

describe.each(animations)('keyframe placement of $id (specification §3.2)', (animation) => {
  const times = goldenTimestamps.map((golden) => golden.timeUs);
  const segments = animation.keyframes.slice(1).map((end, index) => {
    const start = animation.keyframes[index] ?? end;
    return { start, end };
  });

  it('has a golden timestamp exactly on a keyframe', () => {
    const keyframeTimes = animation.keyframes.map((keyframe) => keyframe.timeUs);
    expect(times.filter((timeUs) => keyframeTimes.includes(timeUs))).not.toEqual([]);
  });

  it('has a golden timestamp strictly inside a changing segment, away from its midpoint', () => {
    // At the midpoint, swapped endpoints and every symmetric easing equal linear interpolation.
    const proving = times.filter((timeUs) =>
      segments.some(
        ({ start, end }) =>
          JSON.stringify(start.value) !== JSON.stringify(end.value) &&
          start.timeUs < timeUs &&
          timeUs < end.timeUs &&
          2 * (timeUs - start.timeUs) !== end.timeUs - start.timeUs,
      ),
    );
    expect(proving).not.toEqual([]);
  });
});
