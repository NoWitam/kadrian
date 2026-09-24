/**
 * The assets of the reference composition, generated from code (D27.5): no
 * binary asset is committed, and the bytes are the same on every platform
 * because every generator uses integer arithmetic and no platform API.
 * `reference.json` pins their SHA-256; `tests/repo/fixture-assets.test.ts`
 * fails when a generator and a hash drift apart.
 */
import { generateAudio } from './audio.js';
import { generateFont } from './font.js';
import { generateImage } from './image.js';

export { AUDIO_SAMPLE_RATE, AUDIO_SECONDS } from './audio.js';
export { FONT_FAMILY_NAME, FONT_GLYPHS, FONT_UNITS_PER_EM } from './font.js';
export { IMAGE_SIZE } from './image.js';

/** The bytes of one asset of the reference composition and the media type a host serves them with. */
export interface FixtureAsset {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** Fresh bytes on every call, so that no consumer can change what another one sees. */
export function generateReferenceAssets(): readonly FixtureAsset[] {
  return [
    { id: 'asset-image', mediaType: 'image/png', bytes: generateImage() },
    { id: 'asset-audio', mediaType: 'audio/wav', bytes: generateAudio() },
    { id: 'asset-font', mediaType: 'font/ttf', bytes: generateFont() },
  ];
}
