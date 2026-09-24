/**
 * CSS text of evaluated and static values (D22). The one rule for numbers is
 * ECMAScript `Number::toString`: exactly specified and the shortest decimal that
 * reads back as the same double, so every engine writes the same text for the
 * same bits. Nothing is rounded or fixed to a number of digits.
 */
import type { TransformState } from '@kadrion/runtime';

/** `-0` becomes `"0"`; below 1e-6 the text has an exponent, a valid CSS number token. */
export function cssNumber(value: number): string {
  return String(value);
}

export function cssPixels(value: number): string {
  return `${cssNumber(value)}px`;
}

/**
 * Translate, then scale about the node's own top-left corner (D15): CSS applies
 * the list from the right, and the element's origin is `0px 0px`.
 */
export function cssTransform({ position, scale }: TransformState): string {
  const translate = `translate(${cssPixels(position.x)}, ${cssPixels(position.y)})`;
  return `${translate} scale(${cssNumber(scale.x)}, ${cssNumber(scale.y)})`;
}

/** A schema colour `#rrggbb` as the CSS Object Model serialises it: `rgb(r, g, b)`. */
export function cssColor(hex: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `rgb(${channels.join(', ')})`;
}

/** The font family a text node names (D22.6); asset IDs are valid CSS identifier characters. */
export function fontFamily(fontAssetId: string): string {
  return `kadrion-font-${fontAssetId}`;
}
