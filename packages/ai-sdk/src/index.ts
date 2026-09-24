/**
 * @kadrion/ai-sdk — AI tool contracts built on editor-sdk commands.
 *
 * One tool, `set_node_position`, built on the `SetNodePosition` command of
 * `@kadrion/editor-sdk` (D09, D31). The package is a pure adapter: it keeps no
 * document and no history, and every edit is a `dispatch` on the bus the host
 * passes in, the same path a drag on the canvas takes. No model is called
 * here. D31 was accepted by the project owner on 2026-09-23.
 */
export { executeSetNodePosition, setNodePositionTool } from './set-node-position.js';
export type { ToolDefinition } from './set-node-position.js';
