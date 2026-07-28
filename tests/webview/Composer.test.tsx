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
    lastUsage: null,
    contextWindowMax: null,
    disabled: false,
    history: [],
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

  test("ArrowUp at caret start cycles older user messages and ArrowDown restores draft", () => {
    const onDraftChange = jest.fn();
    const props = composer({
      draft: "drafting",
      history: ["first", "second", "third"],
      onDraftChange,
    });
    const view = render(<Composer {...props} />);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    });
    input.setSelectionRange(0, 0);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenLastCalledWith("third");
    view.rerender(<Composer {...props} draft="third" />);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenLastCalledWith("second");
    view.rerender(<Composer {...props} draft="second" />);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onDraftChange).toHaveBeenLastCalledWith("third");
    view.rerender(<Composer {...props} draft="third" />);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onDraftChange).toHaveBeenLastCalledWith("drafting");
  });

  test("ArrowUp leaves caret mid-text alone so multiline editing still works", () => {
    const onDraftChange = jest.fn();
    render(
      <Composer
        {...composer({
          draft: "line one\nline two",
          history: ["previous"],
          onDraftChange,
        })}
      />,
    );
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    });
    input.setSelectionRange(5, 5);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onDraftChange).not.toHaveBeenCalled();
  });
});

describe("Composer token usage display", () => {
  test("shows k-formatted usage with context window when available", () => {
    render(
      <Composer
        {...composer({
          lastUsage: { promptTokens: 12000, outputTokens: 1600, totalTokens: 13600 },
          contextWindowMax: 128000,
        })}
      />,
    );
    expect(screen.getByLabelText("Token usage").textContent).toContain(
      "13.6k / 128k",
    );
  });

  test("shows usage without context window when max is null", () => {
    render(
      <Composer
        {...composer({
          lastUsage: { promptTokens: 120, outputTokens: 45, totalTokens: 165 },
          contextWindowMax: null,
        })}
      />,
    );
    const usage = screen.getByLabelText("Token usage");
    expect(usage.textContent).toContain("165 total");
    expect(usage.textContent).not.toContain("/");
  });
});
