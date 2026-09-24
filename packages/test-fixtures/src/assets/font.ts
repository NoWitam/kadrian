/**
 * The font asset: a TrueType font built here, glyph by glyph, so that no font
 * file enters the repository and its licence is this repository's own (D10).
 * Every glyph is drawn on a pixel grid of 100 font units; each run of set
 * pixels in a row is one rectangular contour. It covers exactly the characters
 * listed in `FONT_GLYPHS`, which are the characters of the reference texts; a
 * character outside it would make the browser fall back to another font.
 */
import { ByteWriter } from './bytes.js';

export const FONT_FAMILY_NAME = 'Kadrion Fixture';
export const FONT_UNITS_PER_EM = 1000;
const CELL = 100;
const ADVANCE = 600;
const ASCENDER = 800;
const DESCENDER = -200;

/**
 * Glyph bitmaps, top row first. Seven rows sit on or above the baseline, and
 * glyphs with a descender have two more rows below it.
 */
export const FONT_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  ' ': [],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#....', '#....', '#...#', '.###.'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  g: ['.....', '.....', '.####', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
  n: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  t: ['..#..', '..#..', '#####', '..#..', '..#..', '..#..', '...##'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
};

interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface Glyph {
  readonly rects: readonly Rect[];
}

/** One rectangle per horizontal run of `#`; row 6 ends on the baseline. */
function rectsOf(rows: readonly string[]): Rect[] {
  const rects: Rect[] = [];
  rows.forEach((row, rowIndex) => {
    const top = (7 - rowIndex) * CELL;
    let start = -1;
    for (let column = 0; column <= row.length; column += 1) {
      const set = row[column] === '#';
      if (set && start < 0) start = column;
      if (!set && start >= 0) {
        rects.push({
          x0: (start + 0.5) * CELL,
          y0: top - CELL,
          x1: (column + 0.5) * CELL,
          y1: top,
        });
        start = -1;
      }
    }
  });
  return rects;
}

/** The `.notdef` glyph: a hollow box. */
const NOTDEF: Glyph = {
  rects: [
    { x0: 50, y0: 0, x1: 550, y1: 100 },
    { x0: 50, y0: 600, x1: 550, y1: 700 },
    { x0: 50, y0: 100, x1: 150, y1: 600 },
    { x0: 450, y0: 100, x1: 550, y1: 600 },
  ],
};

function glyphBytes(glyph: Glyph): Uint8Array {
  if (glyph.rects.length === 0) return new Uint8Array(0);
  const xs = glyph.rects.flatMap((rect) => [rect.x0, rect.x1]);
  const ys = glyph.rects.flatMap((rect) => [rect.y0, rect.y1]);
  const out = new ByteWriter()
    .u16be(glyph.rects.length)
    .u16be(Math.min(...xs) & 0xffff)
    .u16be(Math.min(...ys) & 0xffff)
    .u16be(Math.max(...xs) & 0xffff)
    .u16be(Math.max(...ys) & 0xffff);
  glyph.rects.forEach((_, index) => out.u16be(index * 4 + 3));
  out.u16be(0); // no instructions
  const points = glyph.rects.flatMap((rect) => [
    // Clockwise in a y-up space, the direction of an outer TrueType contour.
    [rect.x0, rect.y0],
    [rect.x0, rect.y1],
    [rect.x1, rect.y1],
    [rect.x1, rect.y0],
  ]);
  for (let index = 0; index < points.length; index += 1) out.u8(0x01); // on-curve, 16-bit deltas
  let previous = 0;
  for (const [x] of points) {
    out.u16be(((x ?? 0) - previous) & 0xffff);
    previous = x ?? 0;
  }
  previous = 0;
  for (const [, y] of points) {
    out.u16be(((y ?? 0) - previous) & 0xffff);
    previous = y ?? 0;
  }
  return out.pad(2).toBytes();
}

function utf16be(text: string): Uint8Array {
  const out = new ByteWriter();
  for (let index = 0; index < text.length; index += 1) out.u16be(text.charCodeAt(index));
  return out.toBytes();
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const word =
      ((bytes[index] ?? 0) << 24) |
      ((bytes[index + 1] ?? 0) << 16) |
      ((bytes[index + 2] ?? 0) << 8) |
      (bytes[index + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

export function generateFont(): Uint8Array {
  const characters = Object.keys(FONT_GLYPHS).sort();
  const glyphs: Glyph[] = [
    NOTDEF,
    ...characters.map((c) => ({ rects: rectsOf(FONT_GLYPHS[c] ?? []) })),
  ];
  const numGlyphs = glyphs.length;
  const glyphData = glyphs.map(glyphBytes);
  const all = glyphs.flatMap((glyph) => glyph.rects);
  const xMin = Math.min(...all.map((rect) => rect.x0));
  const yMin = Math.min(...all.map((rect) => rect.y0));
  const xMax = Math.max(...all.map((rect) => rect.x1));
  const yMax = Math.max(...all.map((rect) => rect.y1));
  const maxPoints = Math.max(...glyphs.map((glyph) => glyph.rects.length * 4));
  const maxContours = Math.max(...glyphs.map((glyph) => glyph.rects.length));
  const codes = characters.map((c) => c.charCodeAt(0));

  const glyf = new ByteWriter();
  const loca = new ByteWriter();
  for (const data of glyphData) {
    loca.u16be(glyf.length / 2);
    glyf.append(data);
  }
  loca.u16be(glyf.length / 2);

  const head = new ByteWriter()
    .u32be(0x00010000) // version
    .u32be(0x00010000) // fontRevision 1.0
    .u32be(0) // checkSumAdjustment, set below
    .u32be(0x5f0f3cf5) // magic
    .u16be(0x0003) // baseline at y=0, left sidebearing at x=0
    .u16be(FONT_UNITS_PER_EM)
    .u32be(0)
    .u32be(0) // created: 1904-01-01, fixed so the bytes never change
    .u32be(0)
    .u32be(0) // modified
    .u16be(xMin & 0xffff)
    .u16be(yMin & 0xffff)
    .u16be(xMax & 0xffff)
    .u16be(yMax & 0xffff)
    .u16be(0) // macStyle
    .u16be(8) // lowestRecPPEM
    .u16be(2) // fontDirectionHint
    .u16be(0) // indexToLocFormat: short
    .u16be(0); // glyphDataFormat

  const hhea = new ByteWriter()
    .u32be(0x00010000)
    .u16be(ASCENDER)
    .u16be(DESCENDER & 0xffff)
    .u16be(0) // lineGap
    .u16be(ADVANCE) // advanceWidthMax
    .u16be(0) // minLeftSideBearing
    .u16be(0) // minRightSideBearing
    .u16be(xMax) // xMaxExtent
    .u16be(1) // caretSlopeRise
    .u16be(0) // caretSlopeRun
    .u16be(0) // caretOffset
    .u16be(0)
    .u16be(0)
    .u16be(0)
    .u16be(0) // reserved
    .u16be(0) // metricDataFormat
    .u16be(numGlyphs);

  const hmtx = new ByteWriter();
  for (const glyph of glyphs) {
    const lsb = glyph.rects.length === 0 ? 0 : Math.min(...glyph.rects.map((rect) => rect.x0));
    hmtx.u16be(ADVANCE).u16be(lsb);
  }

  const maxp = new ByteWriter()
    .u32be(0x00010000)
    .u16be(numGlyphs)
    .u16be(maxPoints)
    .u16be(maxContours)
    .u16be(0) // maxCompositePoints
    .u16be(0) // maxCompositeContours
    .u16be(2) // maxZones
    .u16be(0)
    .u16be(0)
    .u16be(0)
    .u16be(0)
    .u16be(0)
    .u16be(0)
    .u16be(0)
    .u16be(0)
    .u16be(0);

  const os2 = new ByteWriter()
    .u16be(4) // version
    .u16be(ADVANCE) // xAvgCharWidth
    .u16be(400) // usWeightClass
    .u16be(5) // usWidthClass
    .u16be(0) // fsType: installable
    .u16be(650)
    .u16be(600)
    .u16be(0)
    .u16be(75) // subscript
    .u16be(650)
    .u16be(600)
    .u16be(0)
    .u16be(350) // superscript
    .u16be(50) // yStrikeoutSize
    .u16be(300) // yStrikeoutPosition
    .u16be(0) // sFamilyClass
    .append(new Uint8Array(10)) // panose
    .u32be(1) // ulUnicodeRange1: Basic Latin
    .u32be(0)
    .u32be(0)
    .u32be(0)
    .ascii('NONE') // achVendID
    .u16be(0x00c0) // fsSelection: REGULAR | USE_TYPO_METRICS
    .u16be(Math.min(...codes))
    .u16be(Math.max(...codes))
    .u16be(ASCENDER)
    .u16be(DESCENDER & 0xffff)
    .u16be(0) // sTypoLineGap
    .u16be(ASCENDER) // usWinAscent
    .u16be(-DESCENDER) // usWinDescent
    .u32be(1) // ulCodePageRange1: Latin 1
    .u32be(0)
    .u16be(500) // sxHeight
    .u16be(700) // sCapHeight
    .u16be(0) // usDefaultChar
    .u16be(32) // usBreakChar
    .u16be(1); // usMaxContext

  // cmap: one format 4 subtable for Windows Unicode BMP, one segment per character.
  const segCount = codes.length + 1;
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  const subtable = new ByteWriter()
    .u16be(4)
    .u16be(16 + segCount * 8)
    .u16be(0) // language
    .u16be(segCount * 2)
    .u16be(searchRange)
    .u16be(Math.log2(searchRange / 2))
    .u16be(segCount * 2 - searchRange);
  for (const code of codes) subtable.u16be(code);
  subtable.u16be(0xffff).u16be(0); // endCode[], reservedPad
  for (const code of codes) subtable.u16be(code);
  subtable.u16be(0xffff); // startCode[]
  codes.forEach((code, index) => subtable.u16be((index + 1 - code) & 0xffff));
  subtable.u16be(1); // idDelta[]
  for (let index = 0; index < segCount; index += 1) subtable.u16be(0); // idRangeOffset[]
  const cmap = new ByteWriter()
    .u16be(0)
    .u16be(1)
    .u16be(3)
    .u16be(1)
    .u32be(12)
    .append(subtable.toBytes());

  const names: readonly (readonly [number, string])[] = [
    [1, FONT_FAMILY_NAME],
    [2, 'Regular'],
    [3, `${FONT_FAMILY_NAME} Regular 1.000`],
    [4, `${FONT_FAMILY_NAME} Regular`],
    [5, 'Version 1.000'],
    [6, 'KadrionFixture-Regular'],
  ];
  const strings = new ByteWriter();
  const name = new ByteWriter()
    .u16be(0)
    .u16be(names.length)
    .u16be(6 + names.length * 12);
  for (const [id, text] of names) {
    const encoded = utf16be(text);
    name.u16be(3).u16be(1).u16be(0x0409).u16be(id).u16be(encoded.length).u16be(strings.length);
    strings.append(encoded);
  }
  name.append(strings.toBytes());

  const post = new ByteWriter()
    .u32be(0x00030000)
    .u32be(0) // italicAngle
    .u16be(-100 & 0xffff) // underlinePosition
    .u16be(50) // underlineThickness
    .u32be(1) // isFixedPitch
    .u32be(0)
    .u32be(0)
    .u32be(0)
    .u32be(0);

  const tables: [string, Uint8Array][] = (
    [
      ['OS/2', os2],
      ['cmap', cmap],
      ['glyf', glyf],
      ['head', head],
      ['hhea', hhea],
      ['hmtx', hmtx],
      ['loca', loca],
      ['maxp', maxp],
      ['name', name],
      ['post', post],
    ] as const
  ).map(([tag, writer]) => [tag, writer.toBytes()]);

  const numTables = tables.length;
  const tableSearch = 16 * 2 ** Math.floor(Math.log2(numTables));
  const out = new ByteWriter()
    .u32be(0x00010000)
    .u16be(numTables)
    .u16be(tableSearch)
    .u16be(Math.log2(tableSearch / 16))
    .u16be(numTables * 16 - tableSearch);
  let offset = 12 + numTables * 16;
  let headOffset = 0;
  for (const [tag, data] of tables) {
    out.ascii(tag).u32be(checksum(data)).u32be(offset).u32be(data.length);
    if (tag === 'head') headOffset = offset;
    offset += Math.ceil(data.length / 4) * 4;
  }
  for (const [, data] of tables) out.append(data).pad(4);
  const font = out.toBytes();
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  font[headOffset + 8] = adjustment >>> 24;
  font[headOffset + 9] = (adjustment >>> 16) & 0xff;
  font[headOffset + 10] = (adjustment >>> 8) & 0xff;
  font[headOffset + 11] = adjustment & 0xff;
  return font;
}
