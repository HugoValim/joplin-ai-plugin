/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "../../src/webview/Composer";

function composerProps(
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
): React.ComponentProps<typeof Composer> {
  return {
    draft: "",
    busy: false,
    phase: "Ready",
    focusSequence: 0,
    lastRunId: null,
    lastUsage: null,
    contextWindowMax: null,
    queuedMessage: null,
    onQueue: jest.fn(),
    disabled: false,
    history: [],
    onDraftChange: jest.fn(),
    onSubmit: jest.fn(),
    onCancel: jest.fn(),
    onUndo: jest.fn(),
    ...overrides,
  };
}

describe("Composer follow-up queue", () => {
  test("accepts typing while busy", () => {
    render(<Composer {...composerProps({ draft: "queued text", busy: true })} />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(textarea.value).toBe("queued text");
    expect(textarea.disabled).toBe(false);
  });

  test("Enter while busy calls onQueue instead of onSubmit", async () => {
    const user = userEvent.setup();
    const onQueue = jest.fn();
    const onSubmit = jest.fn();
    render(
      <Composer
        {...composerProps({
          draft: "follow up",
          busy: true,
          onQueue,
          onSubmit,
        })}
      />,
    );
    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "{Enter}");
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("Enter while idle calls onSubmit, not onQueue", async () => {
    const user = userEvent.setup();
    const onQueue = jest.fn();
    const onSubmit = jest.fn();
    render(
      <Composer
        {...composerProps({
          draft: "send now",
          busy: false,
          onQueue,
          onSubmit,
        })}
      />,
    );
    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onQueue).not.toHaveBeenCalled();
  });

  test("shows a queued indicator when a message is queued", () => {
    render(
      <Composer
        {...composerProps({ busy: true, queuedMessage: "follow up" })}
      />,
    );
    expect(screen.getByText(/queued/i)).toBeTruthy();
  });
});
