/**
 * Rules that JSON Schema cannot express (D16, D17). Runs only on a structurally
 * valid document. Errors are ordered by rule and then by position; the order
 * never depends on the key order of the input.
 */
import { pointer, type ValidationError } from './errors.js';
import type { Asset, Composition, NodeAnimation } from './types.js';

/**
 * Generic on purpose: every `id` anywhere in the document takes part, so a new
 * kind of entity cannot be forgotten. Keys are visited in sorted order.
 */
function checkUniqueIds(
  value: unknown,
  path: string,
  seen: Set<string>,
  errors: ValidationError[],
): void {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    items.forEach((item, index) => {
      checkUniqueIds(item, pointer(path, index), seen, errors);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, child] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (name !== 'id' || typeof child !== 'string') {
        checkUniqueIds(child, pointer(path, name), seen, errors);
      } else if (seen.has(child)) {
        const message = `ID "${child}" is already used in this document.`;
        errors.push({ code: 'duplicate-id', path: pointer(path, name), message });
      } else {
        seen.add(child);
      }
    }
  }
}

function checkAnimations(
  animations: readonly NodeAnimation[],
  path: string,
  errors: ValidationError[],
): void {
  const animated = new Set<string>();
  animations.forEach((animation, index) => {
    const animationPath = pointer(path, index);
    if (animated.has(animation.property)) {
      const message = `Property "${animation.property}" of this node is already animated.`;
      errors.push({
        code: 'duplicate-animation-target',
        path: pointer(animationPath, 'property'),
        message,
      });
    }
    animated.add(animation.property);
    animation.keyframes.forEach((keyframe, keyframeIndex) => {
      const previous = animation.keyframes[keyframeIndex - 1];
      if (previous !== undefined && keyframe.timeUs <= previous.timeUs) {
        const keyframePath = pointer(pointer(animationPath, 'keyframes'), keyframeIndex);
        const message = 'Keyframe times must ascend strictly.';
        errors.push({
          code: 'keyframes-not-ascending',
          path: pointer(keyframePath, 'timeUs'),
          message,
        });
      }
    });
  });
}

export function validateSemantics(composition: Composition): ValidationError[] {
  const errors: ValidationError[] = [];
  checkUniqueIds(composition, '', new Set(), errors);

  const assets = new Map(composition.assets.map((asset) => [asset.id, asset]));
  const checkReference = (assetId: string, type: Asset['type'], path: string): void => {
    const asset = assets.get(assetId);
    if (asset === undefined) {
      const message = `No asset has the ID "${assetId}".`;
      errors.push({ code: 'unresolved-asset-reference', path, message });
    } else if (asset.type !== type) {
      const message = `Asset "${assetId}" is of type ${asset.type}, expected ${type}.`;
      errors.push({ code: 'asset-type-mismatch', path, message });
    }
  };
  const animationErrors: ValidationError[] = [];

  composition.scenes.forEach((scene, sceneIndex) => {
    const nodesPath = pointer(pointer(pointer('', 'scenes'), sceneIndex), 'nodes');
    scene.nodes.forEach((node, nodeIndex) => {
      const nodePath = pointer(nodesPath, nodeIndex);
      const members =
        node.type === 'group'
          ? node.children.map((child, childIndex) => ({
              node: child,
              path: pointer(pointer(nodePath, 'children'), childIndex),
            }))
          : [];
      for (const member of [{ node, path: nodePath }, ...members]) {
        if (member.node.type === 'image') {
          checkReference(member.node.assetId, 'image', pointer(member.path, 'assetId'));
        } else if (member.node.type === 'text') {
          checkReference(member.node.fontAssetId, 'font', pointer(member.path, 'fontAssetId'));
        }
        if (member.node.type !== 'background') {
          const animationsPath = pointer(member.path, 'animations');
          checkAnimations(member.node.animations, animationsPath, animationErrors);
        }
      }
    });
  });
  composition.clips.forEach((clip, clipIndex) => {
    const clipPath = pointer(pointer('', 'clips'), clipIndex);
    checkReference(clip.assetId, 'audio', pointer(clipPath, 'assetId'));
  });

  return [...errors, ...animationErrors];
}
