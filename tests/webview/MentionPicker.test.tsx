/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { MentionPicker } from "../../src/webview/MentionPicker";
import type { MentionCandidate } from "../../src/shared/protocol";

const NOTE: MentionCandidate = {
  kind: "note",
  id: "note-1",
  title: "Deploy guide",
};

const NOTEBOOK: MentionCandidate = {
  kind: "notebook",
  id: "nb-1",
  title: "Deploy",
  parentId: "nb-0",
};

function pickerProps(
  overrides: Partial<React.ComponentProps<typeof MentionPicker>> = {},
): React.ComponentProps<typeof MentionPicker> {
  return {
    query: "d",
    candidates: [NOTE, NOTEBOOK],
    loading: false,
    onSelect: jest.fn(),
    onQueryChange: jest.fn(),
    onDismiss: jest.fn(),
    ...overrides,
  };
}

describe("MentionPicker", () => {
  test("renders candidates and selects one via click", () => {
    const onSelect = jest.fn();
    render(<MentionPicker {...pickerProps({ onSelect })} />);

    expect(
      screen.getByRole("listbox", { name: "Mention candidates" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Deploy guide/ }));
    expect(onSelect).toHaveBeenCalledWith(NOTE);
  });

  test("filters candidates when the query changes", () => {
    const onQueryChange = jest.fn();
    render(<MentionPicker {...pickerProps({ onQueryChange })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter mentions" }), {
      target: { value: "deploy" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("deploy");
  });

  test("dismisses on Escape without submitting", () => {
    const onDismiss = jest.fn();
    render(<MentionPicker {...pickerProps({ onDismiss })} />);
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Filter mentions" }),
      {
        key: "Escape",
      },
    );
    expect(onDismiss).toHaveBeenCalled();
  });

  test("shows an empty state when no candidates match", () => {
    render(
      <MentionPicker {...pickerProps({ candidates: [], query: "zzz" })} />,
    );
    expect(screen.getByText("No matches")).toBeTruthy();
  });
});
