import { ContentScriptType } from "api/types";
import {
  SELECTION_LINE_RANGE_COMMAND,
  parseEditorSelectionLineRange,
  type EditorSelectionLineRange,
} from "../shared/editorSelectionRange";

const CONTENT_SCRIPT_ID = "joplinAiAgent.selectionLineRange";
const CONTENT_SCRIPT_PATH = "./contentScripts/selectionLineRange.js";

interface ContentScriptRegistry {
  register(
    type: ContentScriptType,
    id: string,
    scriptPath: string,
  ): Promise<void>;
}

interface EditorCommandPort {
  execute(commandName: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * Queries the live editor selection with real line numbers.
 */
export interface EditorSelectionQuery {
  lineRange(): Promise<EditorSelectionLineRange | null>;
}

/**
 * Registers the Markdown-editor content script that answers line-range queries.
 *
 * @example await registerSelectionLineRangeScript(joplin.contentScripts)
 */
export async function registerSelectionLineRangeScript(
  contentScripts: ContentScriptRegistry,
): Promise<void> {
  await contentScripts.register(
    ContentScriptType.CodeMirrorPlugin,
    CONTENT_SCRIPT_ID,
    CONTENT_SCRIPT_PATH,
  );
}

/**
 * Reads the Markdown editor selection through `editor.execCommand`.
 *
 * Returns null when the Rich Text editor is active (the command is unknown
 * there) or when nothing is selected, so callers can fall back to matching
 * `selectedText` against the note body.
 *
 * @example await new MarkdownSelectionLineRangeQuery(commands).lineRange()
 */
export class MarkdownSelectionLineRangeQuery implements EditorSelectionQuery {
  public constructor(private readonly commands: EditorCommandPort) {}

  public async lineRange(): Promise<EditorSelectionLineRange | null> {
    const range = parseEditorSelectionLineRange(await this.runEditorCommand());
    if (!range || !range.selection.trim()) return null;
    return range;
  }

  private async runEditorCommand(): Promise<unknown> {
    try {
      return await this.commands.execute("editor.execCommand", {
        name: SELECTION_LINE_RANGE_COMMAND,
        args: [],
      });
    } catch {
      return null;
    }
  }
}
