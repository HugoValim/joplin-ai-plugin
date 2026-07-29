/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { App } from "../../src/webview/App";
import {
  PROTOCOL_VERSION,
  type PanelRequest,
  type PluginEvent,
} from "../../src/shared/protocol";

type MessageListener = (message: unknown) => void;

class FakeWebviewApi implements JoplinWebviewApi {
  public readonly requests: object[] = [];
  public listener: MessageListener | null = null;

  public async postMessage(message: object): Promise<unknown> {
    this.requests.push(message);
    return null;
  }

  public onMessage(callback: MessageListener): void {
    this.listener = callback;
  }

  public emit(event: PluginEvent): void {
    if (!this.listener) throw new Error("Expected registered panel listener");
    this.listener(event);
  }
}

function snapshotEvent(): PluginEvent {
  return {
    version: PROTOCOL_VERSION,
    messageId: "snapshot-1",
    chatId: "chat-1",
    type: "state.snapshot",
    payload: {
      chats: [{ id: "chat-1", title: "Plan", updatedAt: 1 }],
      activeChat: {
        id: "chat-1",
        title: "Plan",
        messages: [],
        context: {
          activeNote: true,
          vault: false,
          autoApply: false,
          interactionMode: "agent",
          attachedNoteIds: [],
        },
        externalRoot: null,
        pendingChangeSet: null,
        runSummaries: [],
      },
      endpointStatus: "online",
      modelName: "glm-5.2:cloud",
      privacyNotice: "Only enabled context is sent.",
      secretNotebookIds: [],
      availableModels: ["glm-5.2:cloud"],
      contextWindowMax: 128000,
    },
  };
}

function runFailure(runId: string): PluginEvent {
  return {
    version: PROTOCOL_VERSION,
    messageId: "failure-1",
    chatId: "chat-1",
    runId,
    type: "run.failed",
    payload: { code: "PROVIDER", message: "Endpoint unavailable" },
  };
}

function pendingSnapshotEvent(): PluginEvent {
  const snapshot = snapshotEvent();
  if (snapshot.type !== "state.snapshot" || !snapshot.payload.activeChat) {
    throw new Error("Expected active snapshot");
  }
  return {
    ...snapshot,
    messageId: "snapshot-review",
    payload: {
      ...snapshot.payload,
      activeChat: {
        ...snapshot.payload.activeChat,
        pendingChangeSet: {
          changeSetId: "changes-1",
          runId: "run-1",
          applyToken: "c".repeat(64),
          changes: [
            {
              id: "change-1",
              kind: "note",
              targetId: "note-1",
              targetLabel: "Guide",
              before: "Old",
              after: "New",
              diff: "-Old\n+New",
              status: "proposed",
            },
          ],
        },
      },
    },
  };
}

async function renderReadyApp(): Promise<{
  readonly api: FakeWebviewApi;
  readonly container: HTMLElement;
}> {
  const api = new FakeWebviewApi();
  Object.defineProperty(globalThis, "webviewApi", {
    configurable: true,
    value: api,
  });
  const rendered = render(<App />);
  await act(async () => api.emit(snapshotEvent()));
  return { api, container: rendered.container };
}

describe("App shell", () => {
  test("locks rapid submissions and restores focus after failure", async () => {
    const { api } = await renderReadyApp();
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Review this" } });
    composer.focus();

    fireEvent.keyDown(composer, { key: "Enter" });
    const form = composer.closest("form");
    if (!form) throw new Error("Expected composer form");
    fireEvent.submit(form);

    const submissions = api.requests.filter(
      (request): request is Extract<PanelRequest, { type: "chat.submit" }> =>
        (request as { readonly type?: unknown }).type === "chat.submit",
    );
    expect(submissions).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    const submission = submissions[0];
    if (!submission) throw new Error("Expected one chat submission");

    await act(async () => api.emit(runFailure(submission.runId)));

    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(document.activeElement).toBe(composer);
  });

  test("appends shortcut selection to the draft without submitting", async () => {
    const { api } = await renderReadyApp();
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    });
    fireEvent.change(composer, { target: { value: "Existing prompt" } });
    screen.getByRole("button", { name: "New" }).focus();

    await act(async () =>
      api.emit({
        version: PROTOCOL_VERSION,
        messageId: "selection-1",
        chatId: "bootstrap",
        type: "composer.prefill",
        payload: { text: "selected note text" },
      }),
    );

    expect(composer.value).toBe("Existing prompt\n\nselected note text");
    expect(document.activeElement).toBe(composer);
    expect(
      api.requests.some(
        (request) =>
          (request as { readonly type?: unknown }).type === "chat.submit",
      ),
    ).toBe(false);
  });

  test("shows trusted model and active-note title without transcript live region", async () => {
    const { api } = await renderReadyApp();
    await act(async () =>
      api.emit({
        version: PROTOCOL_VERSION,
        messageId: "workspace-1",
        chatId: "chat-1",
        type: "workspace.changed",
        payload: {
          activeNote: {
            id: "note-1",
            title: "Project brief",
            parentNotebookId: "nb-1",
          },
        },
      }),
    );

    expect(screen.getByText("Online · glm-5.2:cloud")).toBeTruthy();
    expect(screen.getByText("Project brief")).toBeTruthy();
    expect(screen.getByRole("feed").getAttribute("aria-live")).toBeNull();
  });

  test("keeps destructive actions in a closing confirmed overflow menu", async () => {
    const { api } = await renderReadyApp();
    const confirmAction = jest
      .spyOn(globalThis, "confirm")
      .mockReturnValue(true);
    const menuSummary = screen.getByLabelText("More options");
    fireEvent.click(menuSummary);
    const menu = menuSummary.closest("details");
    if (!menu) throw new Error("Expected header menu");

    fireEvent.click(screen.getByRole("button", { name: "Clear chat" }));

    expect(confirmAction).toHaveBeenCalledWith("Clear this chat transcript?");
    expect(menu.open).toBe(false);
    expect(
      api.requests.some(
        (request) =>
          (request as { readonly type?: unknown }).type === "chat.clear",
      ),
    ).toBe(true);
    confirmAction.mockRestore();
  });

  test("defaults context to collapsed summary chips", async () => {
    await renderReadyApp();

    expect(screen.getByText("0 attached")).toBeTruthy();
    expect(screen.getByText("Vault off")).toBeTruthy();
    expect(screen.getAllByText("Add folder")).toHaveLength(2);
    const summary = screen.getByLabelText("Context settings");
    const details = summary.closest("details");
    if (!details) throw new Error("Expected context details");
    expect(details.open).toBe(false);

    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(
      screen.getByText("Attachments persist in this chat until detached."),
    ).toBeTruthy();
  });

  test("requests automatic apply for the current chat", async () => {
    const { api } = await renderReadyApp();
    fireEvent.click(screen.getByLabelText("Context settings"));
    const toggle = screen.getByRole("checkbox", {
      name: /Bypass permissions/,
    });
    expect(
      screen.getByText(
        /Auto-apply non-delete proposals, then review with Keep\/Undo/,
      ),
    ).toBeTruthy();

    fireEvent.click(toggle);

    expect(api.requests.at(-1)).toMatchObject({
      type: "context.update",
      payload: { autoApply: true },
    });
  });

  test("provides an accessible guard for panels below supported width", async () => {
    await renderReadyApp();

    const guard = screen.getByRole("status", { name: "Panel too narrow" });
    expect(guard.textContent).toContain("Widen panel");
    expect(guard.textContent).toContain("Minimum width: 280px");
  });

  test("keeps composer editable while a run is busy so follow-ups can be queued", async () => {
    const { api } = await renderReadyApp();
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    });
    fireEvent.change(composer, { target: { value: "Start run" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: "follow up while busy" } });
    expect(composer.value).toBe("follow up while busy");
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(screen.getByLabelText("Queued follow-up").textContent).toContain(
      "follow up while busy",
    );
    expect(
      api.requests.filter(
        (r) => (r as { type?: unknown }).type === "chat.submit",
      ),
    ).toHaveLength(1);
  });

  test("keeps transcript visible with docked review and disables composer until resolved", async () => {
    const { api } = await renderReadyApp();
    await act(async () => api.emit(pendingSnapshotEvent()));

    expect(screen.getByRole("feed", { name: "Messages" })).toBeTruthy();
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    });
    expect(composer.disabled).toBe(true);
    expect(screen.getByText("1 accepted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(
      api.requests.some(
        (request) =>
          (request as { readonly type?: unknown }).type === "changes.apply",
      ),
    ).toBe(true);
    await act(async () =>
      api.emit({
        version: PROTOCOL_VERSION,
        messageId: "completed-review",
        chatId: "chat-1",
        runId: "run-1",
        type: "run.completed",
        payload: { summary: "Applied 1; conflicts 0", undoRunId: "run-1" },
      }),
    );
    await act(async () => api.emit(snapshotEvent()));
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Message" }),
    );
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  test("has no serious automated accessibility violations", async () => {
    const { container } = await renderReadyApp();
    const result = await axe(container);
    const serious = result.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );

    expect(serious).toEqual([]);
  });
});

describe("App compact config chrome", () => {
  test("renders Mode control near the composer without expanding context details", async () => {
    await renderReadyApp();

    // Mode buttons should be visible (Ask/Agent) without opening a details panel.
    const modeGroup = screen.getByRole("group", { name: "Interaction mode" });
    expect(modeGroup).toBeTruthy();
    expect(screen.getAllByText("Agent").length).toBeGreaterThan(0);
  });

  test("secondary context settings are reachable from an overflow control", async () => {
    await renderReadyApp();

    // The context summary should be a collapsed <details> by default.
    const summary = screen.getByLabelText("Context settings");
    expect(summary.closest("details")?.open).toBe(false);
    // Vault RAG toggle is inside the collapsed details — the details element
    // is closed by default, so the overflow content is not expanded.
    const vaultToggle = screen.queryByText("Vault RAG");
    if (vaultToggle) {
      const details = vaultToggle.closest("details");
      expect(details?.open).toBe(false);
    }
  });
});
