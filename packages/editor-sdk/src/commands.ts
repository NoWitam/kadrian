/**
 * The command union of schema 0.1 and its one parser (D30.1, D30.3). A command
 * is a plain JSON value, so it survives the transport between a host, the UI,
 * and an AI tool call; `parseCommand` is the only way one comes into existence,
 * which is what makes the UI and the AI tool of D31 normalise identically.
 * The JSON Schema of the arguments lives here too, next to the parser it must
 * agree with, so the AI tool contract wraps it instead of restating it (D31.2).
 */
import { EditorError } from './errors.js';

export interface CommandPosition {
  readonly x: number;
  readonly y: number;
}

/** What a caller states for `SetNodePosition`; the command adds its discriminator (D31.2). */
export interface SetNodePositionArguments {
  readonly nodeId: string;
  readonly position: CommandPosition;
}

/** Replaces the node's base position with an absolute one, in composition pixels (D15, D30.1). */
export interface SetNodePositionCommand extends SetNodePositionArguments {
  readonly type: 'SetNodePosition';
}

export type Command = SetNodePositionCommand;

/**
 * Every command type this build knows. Schema 0.1 needs exactly one (§9). The
 * list is frozen: a caller that pushed a name onto it would make `parseCommand`
 * accept a type the build does not know (D31.8).
 */
export const COMMAND_TYPES: readonly Command['type'][] = Object.freeze([
  'SetNodePosition',
] as const);

/** A JSON Schema of one property of a command's arguments. */
export type ArgumentSchema =
  | { readonly type: 'string'; readonly description: string; readonly minLength: number }
  | { readonly type: 'number'; readonly description: string }
  | ClosedObjectSchema<string>;

/** A JSON Schema of a JSON object with exactly the fields `K`, all of them required. */
export interface ClosedObjectSchema<K extends string> {
  readonly type: 'object';
  readonly description: string;
  readonly properties: { readonly [P in K]: ArgumentSchema };
  readonly required: readonly K[];
  readonly additionalProperties: false;
}

/** The argument schema of `SetNodePosition`, typed by the fields of its arguments. */
export interface SetNodePositionArgumentsSchema extends ClosedObjectSchema<
  keyof SetNodePositionArguments
> {
  readonly properties: {
    readonly nodeId: ArgumentSchema;
    readonly position: ClosedObjectSchema<keyof CommandPosition>;
  };
}

/** Freezes a JSON value and everything in it, so no caller can edit a shared schema. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

const COORDINATE =
  'composition pixels. A fraction is rounded to an integer, halves towards +Infinity (2.5 becomes 3, -2.5 becomes -2), and -0 becomes 0.';

/**
 * The JSON Schema (draft 2020-12) of the arguments of `SetNodePosition`, which
 * the AI tool contract passes on as it is (D31.2). `x` and `y` are numbers, not
 * integers: `parseCommand` accepts a fraction and rounds it, so `integer` would
 * describe the document after normalisation, not this input. The bounds of a
 * coordinate are the document's (D15); a position the document cannot hold is
 * refused as `invalid-result` (D30.6), not restated here. A test feeds one
 * corpus to this schema and to `parseCommand` and demands the same verdict.
 */
export const setNodePositionArgumentsSchema: SetNodePositionArgumentsSchema = deepFreeze({
  type: 'object',
  description: 'Moves one node to an absolute base position.',
  properties: {
    nodeId: {
      type: 'string',
      description:
        'The stable ID of the node to move. A node without a position, such as the background, is refused.',
      minLength: 1,
    },
    position: {
      type: 'object',
      description:
        "The node's new base position, absolute, in composition pixels. A position animation adds its offsets on top of it.",
      properties: {
        x: { type: 'number', description: `Distance from the left edge, in ${COORDINATE}` },
        y: { type: 'number', description: `Distance from the top edge, in ${COORDINATE}` },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  required: ['nodeId', 'position'],
  additionalProperties: false,
});

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects anything that is not an object with exactly `fields` as its own keys. */
function fieldsOf(
  value: unknown,
  fields: readonly string[],
  what: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw new EditorError('invalid-argument', `${what} is not an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, at) => key !== expected[at])) {
    throw new EditorError(
      'invalid-argument',
      `${what} must have exactly the fields ${expected.join(', ')}, not ${actual.join(', ') || '(none)'}.`,
    );
  }
  return value;
}

/**
 * One coordinate as the document stores it: an integer number of composition
 * pixels (D15, D30.3). `Math.round` rounds halves towards +Infinity, so -2.5
 * becomes -2; a resulting -0 is normalised to 0, because -0 and 0 are the same
 * text after JSON.stringify but differ under Object.is, which would otherwise
 * make a no-op look like a change. Rounding is not clamping: a coordinate
 * outside the canvas stays as it is and the schema has the last word (D30.6).
 */
function integerPixels(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EditorError(
      'invalid-argument',
      `${what} must be a finite number, not ${typeof value === 'number' ? String(value) : typeof value}.`,
    );
  }
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

function parsePosition(value: unknown, what: string): CommandPosition {
  const fields = fieldsOf(value, ['x', 'y'], what);
  return Object.freeze({
    x: integerPixels(fields['x'], `${what}.x`),
    y: integerPixels(fields['y'], `${what}.y`),
  });
}

/**
 * The single entry into a typed command (D30.3). Rejects a payload that is not
 * a closed object of the command's fields, a type it does not know, and a
 * coordinate that is not finite; normalises the coordinates and freezes the
 * result, so a caller that keeps the object cannot reach into the history
 * afterwards. Parsing an already-parsed command returns an equal command.
 */
export function parseCommand(value: unknown): Command {
  if (!isPlainObject(value)) {
    throw new EditorError('invalid-argument', 'A command is not an object.');
  }
  const type: unknown = value['type'];
  if (typeof type !== 'string') {
    throw new EditorError('invalid-argument', 'A command has no string `type`.');
  }
  if (!COMMAND_TYPES.includes(type as Command['type'])) {
    throw new EditorError('unknown-command', `This build knows no command \`${type}\`.`);
  }
  const fields = fieldsOf(value, ['type', 'nodeId', 'position'], `The command \`${type}\``);
  const nodeId: unknown = fields['nodeId'];
  if (typeof nodeId !== 'string' || nodeId === '') {
    throw new EditorError('invalid-argument', '`nodeId` must be a non-empty string.');
  }
  return Object.freeze({
    type: 'SetNodePosition',
    nodeId,
    position: parsePosition(fields['position'], '`position`'),
  });
}
