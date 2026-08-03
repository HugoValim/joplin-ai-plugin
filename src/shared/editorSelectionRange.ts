/**
 * CodeMirror command registered by the Markdown-editor content script.
 *
 * Called from the plugin with `editor.execCommand` so shortcut handling has one
 * dispatch path instead of a keymap that races the Tools menu accelerator.
 */
export const SELECTION_LINE_RANGE_COMMAND = "joplinAiAgent.selectionLineRange";

/**
 * Live editor selection with its 1-based inclusive line range.
 */
export interface EditorSelectionLineRange {
  readonly selection: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Validates an `editor.execCommand` result as an editor selection line range.
 *
 * @example parseEditorSelectionLineRange({ selection: "a", startLine: 3, endLine: 3 })
 */
export function parseEditorSelectionLineRange(
  value: unknown,
): EditorSelectionLineRange | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<EditorSelectionLineRange>;
  const { selection, startLine, endLine } = candidate;
  if (typeof selection !== "string") return null;
  if (!isPositiveLine(startLine) || !isPositiveLine(endLine)) return null;
  if (startLine > endLine) return null;
  return { selection, startLine, endLine };
}

function isPositiveLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
