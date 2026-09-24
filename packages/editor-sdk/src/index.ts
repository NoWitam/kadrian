/**
 * @kadrion/editor-sdk — typed commands, patches, transactions, undo/redo.
 *
 * The one command bus that UI and AI share (`AGENTS.md`, D09, D30). A command
 * is a plain JSON value; applying one yields a new validated document and the
 * inverse command that undo needs. The package depends on `@kadrion/schema`
 * only and works without a renderer (D12). The AI tool contract of `@kadrion/ai-sdk`
 * wraps the argument schema exported here (D31). The bus is a frozen facade (D30.13).
 */
export { applyCommand } from './apply.js';
export type { CommandResult } from './apply.js';
export { createCommandBus } from './bus.js';
export type { CommandBus } from './bus.js';
export { COMMAND_TYPES, parseCommand, setNodePositionArgumentsSchema } from './commands.js';
export type {
  ArgumentSchema,
  ClosedObjectSchema,
  Command,
  CommandPosition,
  SetNodePositionArguments,
  SetNodePositionArgumentsSchema,
  SetNodePositionCommand,
} from './commands.js';
export { EditorError } from './errors.js';
export type { EditorErrorCode } from './errors.js';
