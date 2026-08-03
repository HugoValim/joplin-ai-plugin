jest.mock("api/types", () => ({
  ContentScriptType: { CodeMirrorPlugin: "codeMirrorPlugin" },
}));

import {
  MarkdownSelectionLineRangeQuery,
  registerSelectionLineRangeScript,
} from "../../src/plugin/editorSelectionRange";

interface RecordedRegistration {
  readonly type: unknown;
  readonly id: string;
  readonly scriptPath: string;
}

class RecordingContentScriptRegistry {
  public readonly registrations: RecordedRegistration[] = [];

  public async register(
    type: unknown,
    id: string,
    scriptPath: string,
  ): Promise<void> {
    this.registrations.push({ type, id, scriptPath });
  }
}

class FakeEditorCommandPort {
  public readonly calls: unknown[][] = [];

  public constructor(private readonly result: unknown) {}

  public async execute(
    commandName: string,
    ...args: unknown[]
  ): Promise<unknown> {
    this.calls.push([commandName, ...args]);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe("registerSelectionLineRangeScript", () => {
  test("registers the CodeMirror content script by built path", async () => {
    const contentScripts = new RecordingContentScriptRegistry();

    await registerSelectionLineRangeScript(contentScripts);

    expect(contentScripts.registrations).toEqual([
      {
        type: "codeMirrorPlugin",
        id: "joplinAiAgent.selectionLineRange",
        scriptPath: "./contentScripts/selectionLineRange.js",
      },
    ]);
  });
});

describe("MarkdownSelectionLineRangeQuery", () => {
  test("returns the editor line range for a Markdown selection", async () => {
    const commands = new FakeEditorCommandPort({
      selection: "alpha\nbeta",
      startLine: 7,
      endLine: 25,
    });

    const range = await new MarkdownSelectionLineRangeQuery(
      commands,
    ).lineRange();

    expect(range).toEqual({
      selection: "alpha\nbeta",
      startLine: 7,
      endLine: 25,
    });
    expect(commands.calls[0]).toEqual([
      "editor.execCommand",
      { name: "joplinAiAgent.selectionLineRange", args: [] },
    ]);
  });

  test("returns null when the Rich Text editor rejects the command", async () => {
    const commands = new FakeEditorCommandPort(
      new Error('Unknown command "joplinAiAgent.selectionLineRange"'),
    );

    expect(
      await new MarkdownSelectionLineRangeQuery(commands).lineRange(),
    ).toBeNull();
  });

  test("returns null when nothing is selected in the Markdown editor", async () => {
    const commands = new FakeEditorCommandPort({
      selection: "   ",
      startLine: 3,
      endLine: 3,
    });

    expect(
      await new MarkdownSelectionLineRangeQuery(commands).lineRange(),
    ).toBeNull();
  });

  test("returns null when the command result has no usable line numbers", async () => {
    const commands = new FakeEditorCommandPort({ selection: "alpha" });

    expect(
      await new MarkdownSelectionLineRangeQuery(commands).lineRange(),
    ).toBeNull();
  });
});
