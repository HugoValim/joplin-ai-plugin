import type { MarkdownEditorContentScriptModule } from "../../api/types";
import {
  SELECTION_LINE_RANGE_COMMAND,
  type EditorSelectionLineRange,
} from "../shared/editorSelectionRange";

const MAX_SELECTION_CHARS = 20_000;

/**
 * Minimal CM6 `EditorView` surface needed to read the selected line range.
 *
 * Declared locally because `CodeMirrorControl.editor` is untyped in the Joplin
 * plugin API, and importing `@codemirror/view` would bundle a second copy.
 */
interface CodeMirrorSelectionView {
  readonly state: {
    readonly selection: {
      readonly main: { readonly from: number; readonly to: number };
    };
    readonly doc: { lineAt(position: number): { readonly number: number } };
    sliceDoc(from: number, to: number): string;
  };
}

/**
 * Markdown-editor content script exposing the live selection as a line range.
 *
 * Registers a query-only command; it deliberately installs no keymap so the
 * Tools menu accelerators stay the single trigger for the AI shortcuts.
 */
export default (): MarkdownEditorContentScriptModule => ({
  plugin: (editorControl): void => {
    if (!editorControl.cm6) return;
    editorControl.registerCommand(SELECTION_LINE_RANGE_COMMAND, () =>
      // Read `editor` per call: Joplin may swap the view when notes change.
      selectionLineRange(asSelectionView(editorControl.editor)),
    );
  },
});

function asSelectionView(editor: unknown): CodeMirrorSelectionView {
  return editor as CodeMirrorSelectionView;
}

function selectionLineRange(
  view: CodeMirrorSelectionView,
): EditorSelectionLineRange {
  const { from, to } = view.state.selection.main;
  const lastSelectedPosition = to > from ? to - 1 : from;
  return {
    selection: view.state.sliceDoc(from, to).slice(0, MAX_SELECTION_CHARS),
    startLine: view.state.doc.lineAt(from).number,
    endLine: view.state.doc.lineAt(lastSelectedPosition).number,
  };
}
