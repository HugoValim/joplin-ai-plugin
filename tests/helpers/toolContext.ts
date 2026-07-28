import type { ToolExecutionContext } from "../../src/tools/toolRegistry";

/**
 * Builds a default tool execution context for tests.
 *
 * @example toolContext({ vault: false, readableNoteIds: new Set(["note-1"]) })
 */
export function toolContext(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    chatId: "chat-1",
    runId: "run-1",
    hasFileWorkspace: false,
    vault: false,
    readableNoteIds: new Set<string>(),
    secretNotebookIds: new Set<string>(),
    agentPlan: { plan: null },
    ...overrides,
  };
}
