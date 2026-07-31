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
  test("opens http links outside the panel without navigating the webview", async () => {
    const user = userEvent.setup();
    const onOpenLink = jest.fn();
    render(
      <MessageCard
        message={{
          ...MESSAGE,
          content: "See [docs](https://example.test/guide).",
        }}
        position={1}
        total={1}
        runSummary={null}
        canRegenerate={false}
        onOpenNote={jest.fn()}
        onOpenLink={onOpenLink}
        onAssistantAction={jest.fn()}
        noteActionsDisabled={false}
      />,
    );

    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.test/guide");
    expect(link.className).toContain("markdown-link");

    await user.click(link);
    expect(onOpenLink).toHaveBeenCalledWith("https://example.test/guide");
  });

  test("lets in-page hash links navigate without opening externally", async () => {
    const user = userEvent.setup();
    const onOpenLink = jest.fn();
    render(
      <MessageCard
        message={{
          ...MESSAGE,
          content: "Jump to [section](#section).",
        }}
        position={1}
        total={1}
        runSummary={null}
        canRegenerate={false}
        onOpenNote={jest.fn()}
        onOpenLink={onOpenLink}
        onAssistantAction={jest.fn()}
        noteActionsDisabled={false}
      />,
    );

    const link = screen.getByRole("link", { name: "section" });
    await user.click(link);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  test("does not open unsafe-scheme links and prevents webview navigation", async () => {
    const user = userEvent.setup();
    const onOpenLink = jest.fn();
    render(
      <MessageCard
        message={{
          ...MESSAGE,
          content: "Run [evil](javascript:alert(1)).",
        }}
        position={1}
        total={1}
        runSummary={null}
        canRegenerate={false}
        onOpenNote={jest.fn()}
        onOpenLink={onOpenLink}
        onAssistantAction={jest.fn()}
        noteActionsDisabled={false}
      />,
    );

    const link = screen.getByText("evil");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBeFalsy();
    expect(link.className).toContain("markdown-link");
    await user.click(link);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

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
        onOpenLink={jest.fn()}
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
