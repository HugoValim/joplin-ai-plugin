/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ActiveChatView } from "../../src/shared/protocol";
import { Transcript } from "../../src/webview/Transcript";

type ChatMessage = ActiveChatView["messages"][number];

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}`,
    createdAt: index,
  }));
}

function renderTranscript(
  transcriptMessages: readonly ChatMessage[],
  streamingText = "",
): ReturnType<typeof render> {
  return render(
    <Transcript
      chatId="chat-1"
      messages={transcriptMessages}
      streamingText={streamingText}
      busy={Boolean(streamingText)}
      submissionSequence={0}
      onOpenNote={jest.fn()}
      onAssistantAction={jest.fn()}
      onSuggestion={jest.fn()}
      noteActionsDisabled={false}
    />,
  );
}

describe("Transcript", () => {
  test("bounds the DOM to the latest 100 messages and pages backward", () => {
    renderTranscript(messages(250));

    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(100);
    expect(screen.getByText("Message 150")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load 100 earlier" }));

    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(200);
    expect(screen.getByText("Message 50")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load 50 earlier" }));

    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(250);
    const focused = document.activeElement;
    expect(
      focused instanceof HTMLElement ? focused.dataset.messageId : null,
    ).toBe("message-50");
  });

  test("preserves upward scroll and offers a jump for streaming output", () => {
    const view = renderTranscript(messages(10));
    const feed = screen.getByRole("feed");
    Object.defineProperties(feed, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(feed);

    view.rerender(
      <Transcript
        chatId="chat-1"
        messages={messages(10)}
        streamingText="New response"
        busy
        submissionSequence={0}
        onOpenNote={jest.fn()}
        onAssistantAction={jest.fn()}
        onSuggestion={jest.fn()}
        noteActionsDisabled={false}
      />,
    );

    const jump = screen.getByRole("button", {
      name: "Jump to latest (1 unread)",
    });
    expect(feed.scrollTop).toBe(100);
    fireEvent.click(jump);
    expect(feed.scrollTop).toBe(1_000);
  });

  test("resets a loaded window to the latest 100 after chat switch", () => {
    const view = renderTranscript(messages(250));
    fireEvent.click(screen.getByRole("button", { name: "Load 100 earlier" }));
    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(200);

    view.rerender(
      <Transcript
        chatId="chat-2"
        messages={messages(250)}
        streamingText=""
        busy={false}
        submissionSequence={0}
        onOpenNote={jest.fn()}
        onAssistantAction={jest.fn()}
        onSuggestion={jest.fn()}
        noteActionsDisabled={false}
      />,
    );

    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(100);
    expect(screen.getByText("Message 150")).toBeTruthy();
  });
});
