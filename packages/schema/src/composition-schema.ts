/**
 * Composition schema 0.1: the persistent data contract, as JSON Schema draft
 * 2020-12 authored in TypeScript so that document types can be derived from it
 * (D17). `JSON.stringify(compositionSchema)` is the schema in its standard form.
 *
 * It accepts the reference composition and nothing beyond it (D16): no optional
 * fields, no defaults, no unknown fields.
 */
import {
  closedObject,
  type ArraySchema,
  type JsonSchema,
  type NumberSchema,
  type StringSchema,
  type UnionSchema,
} from './json-schema.js';

export const SCHEMA_VERSION = '0.1';

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

const id = {
  type: 'string',
  description: 'Stable ID, unique across the whole document whatever the kind of entity (D16).',
  pattern: '^[A-Za-z0-9_-]+$',
} as const satisfies StringSchema;

const assetReference = {
  type: 'string',
  description: 'ID of an asset of the type that the referring entity expects (D14).',
  pattern: '^[A-Za-z0-9_-]+$',
} as const satisfies StringSchema;

const timeUs = {
  type: 'integer',
  description: 'Composition time in integer microseconds (D04).',
  minimum: 0,
  maximum: MAX_SAFE_INTEGER,
} as const satisfies NumberSchema;

const durationUs = {
  type: 'integer',
  description: 'Duration in integer microseconds (D04).',
  minimum: 1,
  maximum: MAX_SAFE_INTEGER,
} as const satisfies NumberSchema;

const canvasLength = {
  type: 'integer',
  description: 'Canvas side in composition pixels (D15).',
  minimum: 1,
  maximum: 1920,
} as const satisfies NumberSchema;

const coordinate = {
  type: 'integer',
  description: 'Coordinate or offset in composition pixels; x grows right, y grows down (D15).',
  minimum: -1_000_000,
  maximum: 1_000_000,
} as const satisfies NumberSchema;

const length = {
  type: 'integer',
  description: 'Length in composition pixels (D15).',
  minimum: 1,
  maximum: 1_000_000,
} as const satisfies NumberSchema;

const opacity = {
  type: 'number',
  description: 'Opacity from 0 (transparent) to 1 (opaque). A group is composited first (D15).',
  minimum: 0,
  maximum: 1,
} as const satisfies NumberSchema;

const scaleFactor = {
  type: 'number',
  description: 'Scale factor (D15).',
  minimum: 0,
  maximum: 1000,
} as const satisfies NumberSchema;

const color = {
  type: 'string',
  description: 'Lowercase #rrggbb sRGB colour (D15).',
  pattern: '^#[0-9a-f]{6}$',
} as const satisfies StringSchema;

const position = closedObject(
  "Offset of the node's origin, the top-left corner of its box, from its parent's origin (D15).",
  { x: coordinate, y: coordinate },
);

const scale = closedObject("Scale about the node's own origin, applied after the translation.", {
  x: scaleFactor,
  y: scaleFactor,
});

const interpolation = {
  type: 'string',
  description: 'How values between two keyframes are computed. Schema 0.1 knows linear only.',
  enum: ['linear'],
} as const satisfies StringSchema;

/** Keyframe times ascend strictly; outside the keyframes the nearest value holds (D16). */
function animation<const N extends string, const V extends JsonSchema>(
  property: N,
  description: string,
  value: V,
) {
  return closedObject(description, {
    id,
    property: { type: 'string', const: property },
    interpolation,
    keyframes: {
      type: 'array',
      minItems: 2,
      items: closedObject('Value of the animation at one instant.', { timeUs, value }),
    },
  });
}

export const opacityAnimationSchema = animation(
  'opacity',
  "Factors multiplied with the node's opacity (D16).",
  opacity,
);

export const positionAnimationSchema = animation(
  'position',
  "Offsets added to the node's position (D16).",
  position,
);

export const scaleAnimationSchema = animation(
  'scale',
  "Factors multiplied with the node's scale (D16).",
  scale,
);

export const animationSchema = {
  description: 'An animation modifies the base value of one property of the node that owns it.',
  oneOf: [opacityAnimationSchema, positionAnimationSchema, scaleAnimationSchema],
} as const satisfies UnionSchema;

const animations = {
  type: 'array',
  description: 'At most one animation per property.',
  items: animationSchema,
} as const satisfies ArraySchema;

const transform = { position, scale, opacity, animations } as const;

export const backgroundNodeSchema = closedObject('Solid fill that covers the whole canvas.', {
  id,
  type: { type: 'string', const: 'background' },
  color,
});

export const imageNodeSchema = closedObject('An image asset stretched to the box of the node.', {
  id,
  type: { type: 'string', const: 'image' },
  ...transform,
  assetId: assetReference,
  width: length,
  height: length,
});

export const textNodeSchema = closedObject('One run of text; line breaks are preserved.', {
  id,
  type: { type: 'string', const: 'text' },
  ...transform,
  text: { type: 'string' },
  fontAssetId: assetReference,
  fontSize: length,
  color,
});

export const customHtmlNodeSchema = closedObject(
  'Isolated, capability-limited HTML element (D05). Schema 0.1 defines no capability.',
  {
    id,
    type: { type: 'string', const: 'custom-html' },
    ...transform,
    width: length,
    height: length,
    html: { type: 'string', description: 'Inline document shown inside the sandbox.' },
  },
);

export const groupNodeSchema = closedObject(
  "Children follow the group's transform. Groups do not nest in schema 0.1 (D16).",
  {
    id,
    type: { type: 'string', const: 'group' },
    ...transform,
    children: {
      type: 'array',
      description: 'Array order is the z-order; the first child is at the bottom.',
      items: { oneOf: [imageNodeSchema, textNodeSchema] },
    },
  },
);

export const sceneNodeSchema = {
  oneOf: [
    backgroundNodeSchema,
    groupNodeSchema,
    imageNodeSchema,
    textNodeSchema,
    customHtmlNodeSchema,
  ],
} as const satisfies UnionSchema;

export const sceneSchema = closedObject('The single scene spans the whole composition (D16).', {
  id,
  nodes: {
    type: 'array',
    description: 'Array order is the z-order; the first node is at the bottom.',
    items: sceneNodeSchema,
  },
});

export const assetSchema = closedObject(
  'Pinned by content hash; the host resolves the bytes and the engine verifies them (D14).',
  {
    id,
    type: { type: 'string', enum: ['image', 'audio', 'font'] },
    contentHash: {
      type: 'string',
      description: 'Algorithm, a colon, and the lowercase hex digest of the exact bytes.',
      pattern: '^sha256:[0-9a-f]{64}$',
    },
  },
);

export const audioClipSchema = closedObject(
  'Plays an audio asset from its beginning; whatever lies past the composition end is cut.',
  {
    id,
    type: { type: 'string', const: 'audio' },
    assetId: assetReference,
    startUs: timeUs,
    durationUs,
  },
);

/**
 * Freezes a schema and everything reachable from it. `validate-structure.ts`
 * remembers which schema objects it has checked; a frozen schema cannot change
 * after that check, so the memo can never change a verdict (D24.2).
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const compositionSchema = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Kadrion composition 0.1',
  ...closedObject('A video composition: the only source of rendering truth.', {
    schemaVersion: { type: 'string', const: SCHEMA_VERSION },
    width: canvasLength,
    height: canvasLength,
    fps: {
      type: 'integer',
      description: 'Integer frame rate; the frame grid follows D13.',
      minimum: 1,
      maximum: 120,
    },
    durationUs,
    assets: { type: 'array', items: assetSchema },
    scenes: { type: 'array', minItems: 1, maxItems: 1, items: sceneSchema },
    clips: {
      type: 'array',
      description: 'At most one audio clip, because mixing is undefined in schema 0.1 (D16).',
      maxItems: 1,
      items: audioClipSchema,
    },
  }),
} as const satisfies JsonSchema);
