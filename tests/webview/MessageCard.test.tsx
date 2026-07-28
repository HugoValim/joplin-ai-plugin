/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActiveChatView } from "../../src/shared/protocol";
import { MessageCard } from "../../src/webview/MessageCard";

type ChatMessage = ActiveChatView["messages"][number];

class RecordingClipboard {
  public readonly copied: string[] = [];

  public async writeText(value: string): Promise<void> {
    this.copied.push(value);
  }
}

const MESSAGE: ChatMessage = {
  id: "assistant-1",
  role: "assistant",
  content: "Answer",
  createdAt: 1,
  citations: [
    {
      kind: "note",
      id: "note-1",
      label: "Guide",
      lineStart: 2,
      lineEnd: 4,
    },
  ],
};

describe("MessageCard", () => {
  test("keeps Copy visible and closes keyboard action menus", async () => {
    const user = userEvent.setup();
    const clipboard = new RecordingClipboard();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });
    const onAction = jest.fn();
    render(
      <MessageCard
        message={MESSAGE}
        position={1}
        total={1}
        runSummary={null}
        canRegenerate={false}
        onOpenNote={jest.fn()}
        onAssistantAction={onAction}
        noteActionsDisabled={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(clipboard.copied).toEqual(["Answer"]);
    expect(screen.getByText("Sources (1)")).toBeTruthy();

    const actionSummary = screen.getByText("More actions");
    await user.click(actionSummary);
    const menu = actionSummary.closest("details");
    if (!menu) throw new Error("Expected action details");
    expect(menu.open).toBe(true);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(actionSummary);

    await user.click(actionSummary);
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(onAction).toHaveBeenCalledWith("assistant-1", "insert-at-cursor");
    expect(menu.open).toBe(false);
  });
});
