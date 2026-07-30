import {
  PROTOCOL_VERSION,
  parsePanelRequest,
  parsePluginEvent,
  type PanelRequest,
} from "../../src/shared/protocol";

describe("panel protocol", () => {
  test("accepts a versioned chat submission", () => {
    const request: PanelRequest = {
      version: PROTOCOL_VERSION,
      messageId: "message-1",
      chatId: "chat-1",
      runId: "run-1",
      type: "chat.submit",
      payload: { text: "Summarise the active note." },
    };

    expect(parsePanelRequest(request)).toEqual(request);
  });

  test("accepts a sidebar-ready message without a run", () => {
    const request = {
      version: PROTOCOL_VERSION,
      messageId: "message-2",
      chatId: "bootstrap",
      type: "panel.ready",
      payload: {},
    };

    expect(parsePanelRequest(request)).toEqual(request);
  });

  test.each([
    ["chat.create", {}],
    ["chat.select", {}],
    ["chat.clear", {}],
    ["chat.delete", {}],
    [
      "assistant.action",
      { messageId: "assistant-1", action: "insert-at-cursor" },
    ],
    ["run.cancel", {}],
    [
      "context.update",
      {
        activeNote: true,
        vault: false,
        autoApply: false,
        interactionMode: "agent",
        attachedNoteIds: ["note-1"],
      },
    ],
    ["folder.select", {}],
    [
      "changes.apply",
      {
        changeSetId: "changes-1",
        acceptedIds: ["change-1"],
        applyToken: "a".repeat(64),
      },
    ],
    ["changes.discard", { changeSetId: "changes-1" }],
    ["review.open", { changeSetId: "changes-1" }],
    ["run.undo", { targetRunId: "run-old" }],
    ["note.open", { noteId: "note-1" }],
    ["link.open", { url: "https://example.test/doc" }],
    ["secrets.mark", { notebookId: "nb-1" }],
    ["secrets.unmark", { notebookId: "nb-1" }],
  ])("accepts %s requests", (type, payload) => {
    const runId =
      type.startsWith("run.") ||
      type.startsWith("changes.") ||
      type === "review.open" ||
      type === "assistant.action"
        ? "run-1"
        : null;
    const request = {
      version: PROTOCOL_VERSION,
      messageId: `message-${type}`,
      chatId: "chat-1",
      ...(runId ? { runId } : {}),
      type,
      payload,
    };

    expect(parsePanelRequest(request)).toEqual(request);
  });

  test("rejects another protocol version", () => {
    const request = {
      version: 1,
      messageId: "message-3",
      chatId: "bootstrap",
      type: "panel.ready",
      payload: {},
    };

    expect(() => parsePanelRequest(request)).toThrow(
      "expected a protocol v2 panel request",
    );
  });
});

describe("plugin protocol", () => {
  test("accepts a notebook organization proposal", () => {
    const event = {
      version: PROTOCOL_VERSION,
      messageId: "message-notebook-change",
      chatId: "chat-1",
      runId: "run-1",
      type: "changes.proposed",
      payload: {
        changeSetId: "changes-1",
        runId: "run-1",
        applyToken: "e".repeat(64),
        changes: [
          {
            id: "change-1",
            kind: "notebook",
            operation: "rename",
            targetId: "folder-1",
            targetLabel: "Projects",
            before: "Title: Projects",
            after: "Title: Active projects",
            diff: "notebook diff",
            status: "proposed",
          },
        ],
      },
    };

    expect(parsePluginEvent(event)).toEqual(event);
  });

  test.each([
    [
      "state.snapshot",
      {
        chats: [],
        activeChat: null,
        endpointStatus: "unconfigured",
        modelName: "",
        privacyNotice: "Context is opt-in.",
        secretNotebookIds: [],
        availableModels: [],
      },
    ],
    [
      "workspace.changed",
      {
        activeNote: {
          id: "note-1",
          title: "Project brief",
          parentNotebookId: "nb-1",
        },
      },
    ],
    ["composer.prefill", { text: "selected note text" }],
    ["run.started", { startedAt: 1 }],
    ["assistant.delta", { delta: "Hello" }],
    ["tool.started", { toolCallId: "tool-1", name: "read_note" }],
    [
      "tool.completed",
      { toolCallId: "tool-1", name: "read_note", ok: true, summary: "Read" },
    ],
    [
      "changes.proposed",
      { changeSetId: "changes-1", applyToken: "f".repeat(64), changes: [] },
    ],
    ["run.progress", { current: 1, total: 2, label: "Reviewing" }],
    [
      "run.plan",
      {
        items: [
          { id: "1", content: "Improve FWS notes", status: "pending" },
          { id: "2", content: "Tighten roadmap", status: "completed" },
        ],
      },
    ],
    ["run.failed", { code: "PROVIDER", message: "Provider failed." }],
    ["run.completed", { summary: "Done" }],
  ])("accepts %s events", (type, payload) => {
    const hasRun = ![
      "state.snapshot",
      "workspace.changed",
      "composer.prefill",
    ].includes(type);
    const event = {
      version: PROTOCOL_VERSION,
      messageId: `message-${type}`,
      chatId: "chat-1",
      ...(hasRun ? { runId: "run-1" } : {}),
      type,
      payload,
    };

    expect(parsePluginEvent(event)).toEqual(event);
  });

  test("rejects protocol v1 plugin events", () => {
    expect(() =>
      parsePluginEvent({
        version: 1,
        messageId: "message-v1",
        chatId: "chat-1",
        type: "workspace.changed",
        payload: { activeNote: null },
      }),
    ).toThrow("expected a protocol v2 plugin event");
  });

  test("rejects oversized composer selection", () => {
    expect(() =>
      parsePluginEvent({
        version: PROTOCOL_VERSION,
        messageId: "selection-oversized",
        chatId: "bootstrap",
        type: "composer.prefill",
        payload: { text: "x".repeat(20_001) },
      }),
    ).toThrow("expected a protocol v2 plugin event");
  });
});
