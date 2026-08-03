import selectionLineRangeContentScript from "../../src/contentScripts/selectionLineRange";
import { SELECTION_LINE_RANGE_COMMAND } from "../../src/shared/editorSelectionRange";

type EditorCommand = (...args: unknown[]) => unknown;

class FakeCodeMirrorControl {
  public readonly commands = new Map<string, EditorCommand>();
  public readonly extensions: unknown[] = [];
  public editor: unknown;

  public constructor(
    public readonly cm6: unknown,
    body: string,
    private readonly from: number,
    private readonly to: number,
  ) {
    this.editor = fakeEditorView(body, from, to);
  }

  public addExtension(extension: unknown): void {
    this.extensions.push(extension);
  }

  public registerCommand(name: string, callback: EditorCommand): void {
    this.commands.set(name, callback);
  }
}

function fakeEditorView(body: string, from: number, to: number): unknown {
  const lineNumberAt = (position: number): number =>
    body.slice(0, position).split("\n").length;
  return {
    state: {
      selection: { main: { from, to } },
      doc: {
        lineAt: (position: number) => ({ number: lineNumberAt(position) }),
      },
      sliceDoc: (start: number, end: number) => body.slice(start, end),
    },
  };
}

const body = "line1\nline2\nline3\nline4";

describe("selection line range content script", () => {
  test("registers a command returning the selected 1-based line range", () => {
    const control = new FakeCodeMirrorControl({}, body, 6, 17);

    selectionLineRangeContentScript().plugin(control as never);

    const command = control.commands.get(SELECTION_LINE_RANGE_COMMAND);
    if (!command) throw new Error("expected a registered selection command");
    expect(command()).toEqual({
      selection: "line2\nline3",
      startLine: 2,
      endLine: 3,
    });
  });

  test("installs no keymap so the Tools accelerator stays the only trigger", () => {
    const control = new FakeCodeMirrorControl({}, body, 6, 17);

    selectionLineRangeContentScript().plugin(control as never);

    expect(control.extensions).toEqual([]);
  });

  test("reports the caret line when the selection is empty", () => {
    const control = new FakeCodeMirrorControl({}, body, 13, 13);

    selectionLineRangeContentScript().plugin(control as never);

    expect(control.commands.get(SELECTION_LINE_RANGE_COMMAND)?.()).toEqual({
      selection: "",
      startLine: 3,
      endLine: 3,
    });
  });

  test("reads the current editor view on every call", () => {
    const control = new FakeCodeMirrorControl({}, body, 0, 5);
    selectionLineRangeContentScript().plugin(control as never);
    control.editor = fakeEditorView(body, 18, 23);

    expect(control.commands.get(SELECTION_LINE_RANGE_COMMAND)?.()).toEqual({
      selection: "line4",
      startLine: 4,
      endLine: 4,
    });
  });

  test("does nothing when the editor is not CodeMirror 6", () => {
    const control = new FakeCodeMirrorControl(undefined, body, 0, 5);

    selectionLineRangeContentScript().plugin(control as never);

    expect(control.commands.size).toBe(0);
  });
});
