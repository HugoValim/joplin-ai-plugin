/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "../../src/webview/Composer";

function composer(
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
): React.ComponentProps<typeof Composer> {
  return {
    draft: "Hello",
    busy: false,
    phase: "Ready",
    focusSequence: 0,
    lastRunId: null,
    onDraftChange: jest.fn(),
    onSubmit: jest.fn(),
    onCancel: jest.fn(),
    onUndo: jest.fn(),
    ...overrides,
  };
}

describe("Composer", () => {
  test("sends on Enter and preserves Shift+Enter for a newline", () => {
    const props = composer();
    render(<Composer {...props} />);
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  test("keeps Stop in the submit location and restores focus", () => {
    const props = composer({ busy: true, phase: "Thinking" });
    const view = render(<Composer {...props} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    const stop = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    input.blur();
    view.rerender(<Composer {...props} focusSequence={1} />);
    expect(document.activeElement).toBe(input);
  });

  test("grows to six lines before scrolling internally", () => {
    render(<Composer {...composer()} />);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    });
    input.style.lineHeight = "20px";
    input.style.padding = "0";
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      value: 500,
    });

    fireEvent.input(input);

    expect(input.style.height).toBe("120px");
    expect(input.style.overflowY).toBe("auto");
  });
});
