/**
 * Document types, derived from the JSON Schema so that they cannot drift (D17).
 * All of them are deeply read-only: a document is a value, and an edit produces
 * a new document. Names avoid the DOM globals `Node` and `Animation`.
 */
import type {
  animationSchema,
  assetSchema,
  audioClipSchema,
  backgroundNodeSchema,
  compositionSchema,
  customHtmlNodeSchema,
  groupNodeSchema,
  imageNodeSchema,
  sceneNodeSchema,
  sceneSchema,
  textNodeSchema,
} from './composition-schema.js';
import type { Infer } from './json-schema.js';

export type Composition = Infer<typeof compositionSchema>;

/**
 * Marks a composition that `validateComposition` has accepted (specification
 * Q17). The brand exists in the type system only and emits no code.
 *
 * It is a declared class with a private member rather than a unique-symbol
 * property on purpose: a private member does not survive an object spread, so
 * `{ ...composition, durationUs: 1 }` is a plain `Composition` again and has to
 * be validated again. `Readonly<>` and `Object.freeze` strip the brand as well,
 * which fails closed. The guarantee is static only: a type assertion or a type
 * predicate could forge it, so ESLint rejects both outside `validate.ts`.
 */
declare class ValidatedBrand {
  private readonly validated: true;
}

/** A composition accepted by `validateComposition`; the only document type the runtime accepts. */
export type ValidatedComposition = Composition & ValidatedBrand;

export type Asset = Infer<typeof assetSchema>;
export type Scene = Infer<typeof sceneSchema>;
export type SceneNode = Infer<typeof sceneNodeSchema>;
export type BackgroundNode = Infer<typeof backgroundNodeSchema>;
export type GroupNode = Infer<typeof groupNodeSchema>;
export type ImageNode = Infer<typeof imageNodeSchema>;
export type TextNode = Infer<typeof textNodeSchema>;
export type CustomHtmlNode = Infer<typeof customHtmlNodeSchema>;
export type NodeAnimation = Infer<typeof animationSchema>;
export type AudioClip = Infer<typeof audioClipSchema>;
