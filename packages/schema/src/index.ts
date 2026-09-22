/**
 * @kadrion/schema — JSON Schema, TypeScript types, validation, migrations.
 *
 * Schema 0.1, as decided by D13–D17. There is no migration framework yet,
 * because 0.1 is the first version.
 */
export { compositionSchema, SCHEMA_VERSION } from './composition-schema.js';
export type { ValidationError, ValidationErrorCode, ValidationResult } from './errors.js';
export { frameCount, frameToTimeUs, timeUsToFrame } from './frame-grid.js';
export type {
  Asset,
  AudioClip,
  BackgroundNode,
  Composition,
  CustomHtmlNode,
  GroupNode,
  ImageNode,
  NodeAnimation,
  Scene,
  SceneNode,
  TextNode,
  ValidatedComposition,
} from './types.js';
export { validateComposition } from './validate.js';
