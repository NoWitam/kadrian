/**
 * The AI tool contract of `SetNodePosition` (D31). The tool is data — a name, a
 * description, and the argument schema that `@kadrion/editor-sdk` owns — and
 * one function that turns the arguments into the command and dispatches it on
 * the host's bus. It adds the discriminator and nothing else: the parse, the
 * rounding, the lookup, and the full validation are the bus's, exactly as for
 * a drag on the canvas (P4).
 */
import {
  EditorError,
  setNodePositionArgumentsSchema,
  type ClosedObjectSchema,
  type CommandBus,
  type CommandResult,
} from '@kadrion/editor-sdk';

/** What a host hands to a model API; `inputSchema` is the name MCP uses (D31.1). */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ClosedObjectSchema<string>;
}

/**
 * The definition of `set_node_position`. Its `inputSchema` is the very object
 * `editor-sdk` exports, deep-frozen there, so nothing here can drift from the
 * command (D31.2).
 */
export const setNodePositionTool: ToolDefinition = Object.freeze({
  name: 'set_node_position',
  description:
    "Moves one node of the composition to an absolute base position, in composition pixels. The edit goes through the host's command bus, like a drag on the canvas: the result is validated in full and can be undone. Returns the edited document and the command that undoes the edit.",
  inputSchema: setNodePositionArgumentsSchema,
});

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The command the arguments ask for (D31.3). Anything that is not an object
 * goes to the bus unchanged, whose parser refuses it; an own `type` is refused
 * here, because the schema forbids it and either spread order would disagree
 * with the schema. The spread reads each field once, so the parser sees a
 * plain snapshot.
 */
function commandOf(args: unknown): unknown {
  if (!isObject(args)) return args;
  if (Object.hasOwn(args, 'type')) {
    throw new EditorError(
      'invalid-argument',
      'The arguments of `set_node_position` have no `type`; the tool supplies it.',
    );
  }
  return { type: 'SetNodePosition', ...args };
}

/**
 * Runs one `set_node_position` call on the host's bus: exactly one `dispatch`,
 * whose result is returned as it is — the validated document after the edit
 * and its inverse, or `null` when nothing changed (D31.4). The tool receives
 * the one capability it needs; it cannot undo, redo, or replace the document
 * (D31.5). Failures are the bus's own `EditorError`, not rewrapped (D31.6).
 */
export function executeSetNodePosition(
  bus: Pick<CommandBus, 'dispatch'>,
  args: unknown,
): CommandResult {
  return bus.dispatch(commandOf(args));
}
