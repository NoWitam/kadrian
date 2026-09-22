/**
 * The document types are derived from the JSON Schema (D17). These assertions
 * pin the result against hand-written expectations, so a bug in `Infer` or an
 * unintended schema change fails `tsc -b`; the runtime part is a no-op.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type {
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
  ValidationResult,
} from '../src/index.js';

interface Vec2 {
  readonly x: number;
  readonly y: number;
}

interface ExpectedAnimation<Property extends string, Value> {
  readonly id: string;
  readonly property: Property;
  readonly interpolation: 'linear';
  readonly keyframes: readonly { readonly timeUs: number; readonly value: Value }[];
}

type ExpectedNodeAnimation =
  | ExpectedAnimation<'opacity', number>
  | ExpectedAnimation<'position', Vec2>
  | ExpectedAnimation<'scale', Vec2>;

interface ExpectedTransform {
  readonly position: Vec2;
  readonly scale: Vec2;
  readonly opacity: number;
  readonly animations: readonly ExpectedNodeAnimation[];
}

interface ExpectedBackgroundNode {
  readonly id: string;
  readonly type: 'background';
  readonly color: string;
}

interface ExpectedImageNode extends ExpectedTransform {
  readonly id: string;
  readonly type: 'image';
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
}

interface ExpectedTextNode extends ExpectedTransform {
  readonly id: string;
  readonly type: 'text';
  readonly text: string;
  readonly fontAssetId: string;
  readonly fontSize: number;
  readonly color: string;
}

interface ExpectedCustomHtmlNode extends ExpectedTransform {
  readonly id: string;
  readonly type: 'custom-html';
  readonly width: number;
  readonly height: number;
  readonly html: string;
}

interface ExpectedGroupNode extends ExpectedTransform {
  readonly id: string;
  readonly type: 'group';
  readonly children: readonly (ExpectedImageNode | ExpectedTextNode)[];
}

type ExpectedSceneNode =
  | ExpectedBackgroundNode
  | ExpectedGroupNode
  | ExpectedImageNode
  | ExpectedTextNode
  | ExpectedCustomHtmlNode;

interface ExpectedScene {
  readonly id: string;
  readonly nodes: readonly ExpectedSceneNode[];
}

interface ExpectedAsset {
  readonly id: string;
  readonly type: 'image' | 'audio' | 'font';
  readonly contentHash: string;
}

interface ExpectedAudioClip {
  readonly id: string;
  readonly type: 'audio';
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
}

interface ExpectedComposition {
  readonly schemaVersion: '0.1';
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationUs: number;
  readonly assets: readonly ExpectedAsset[];
  readonly scenes: readonly ExpectedScene[];
  readonly clips: readonly ExpectedAudioClip[];
}

describe('types derived from the JSON Schema', () => {
  it('equal the hand-written expectations', () => {
    expectTypeOf<Composition>().toEqualTypeOf<ExpectedComposition>();
    expectTypeOf<Asset>().toEqualTypeOf<ExpectedAsset>();
    expectTypeOf<Scene>().toEqualTypeOf<ExpectedScene>();
    expectTypeOf<SceneNode>().toEqualTypeOf<ExpectedSceneNode>();
    expectTypeOf<BackgroundNode>().toEqualTypeOf<ExpectedBackgroundNode>();
    expectTypeOf<GroupNode>().toEqualTypeOf<ExpectedGroupNode>();
    expectTypeOf<ImageNode>().toEqualTypeOf<ExpectedImageNode>();
    expectTypeOf<TextNode>().toEqualTypeOf<ExpectedTextNode>();
    expectTypeOf<CustomHtmlNode>().toEqualTypeOf<ExpectedCustomHtmlNode>();
    expectTypeOf<NodeAnimation>().toEqualTypeOf<ExpectedNodeAnimation>();
    expectTypeOf<AudioClip>().toEqualTypeOf<ExpectedAudioClip>();
  });

  it('narrow by their discriminators', () => {
    expectTypeOf<Extract<SceneNode, { type: 'text' }>>().toEqualTypeOf<TextNode>();
    expectTypeOf<
      Extract<NodeAnimation, { property: 'opacity' }>['keyframes'][number]['value']
    >().toBeNumber();
  });

  it('are neither any nor never', () => {
    expectTypeOf<Composition>().not.toBeAny();
    expectTypeOf<Composition>().not.toBeNever();
    expectTypeOf<SceneNode>().not.toBeNever();
    expectTypeOf<ValidatedComposition>().not.toBeAny();
    expectTypeOf<ValidatedComposition>().not.toBeNever();
  });
});

describe('the brand of a validated composition (specification Q17)', () => {
  it('is what validateComposition returns', () => {
    type Accepted = Extract<ValidationResult, { ok: true }>['composition'];
    expectTypeOf<Accepted>().toEqualTypeOf<ValidatedComposition>();
  });

  it('can be read as a plain composition, but a plain composition is not validated', () => {
    expectTypeOf<ValidatedComposition>().toExtend<Composition>();
    expectTypeOf<Composition>().not.toExtend<ValidatedComposition>();
  });

  it('does not survive an edited copy, which has to be validated again', () => {
    // What a command does to a document: a spread copy with one field replaced.
    // `no-misused-spread` flags the spread of a branded value, which is a welcome
    // second warning for real code; here the spread is the subject of the test.
    const editedCopy = (composition: ValidatedComposition) => ({
      // eslint-disable-next-line @typescript-eslint/no-misused-spread
      ...composition,
      durationUs: 1,
    });
    expectTypeOf(editedCopy).returns.toExtend<Composition>();
    expectTypeOf(editedCopy).returns.not.toExtend<ValidatedComposition>();
  });

  it('fails closed under Readonly and Object.freeze', () => {
    expectTypeOf<Readonly<ValidatedComposition>>().not.toExtend<ValidatedComposition>();
  });
});
