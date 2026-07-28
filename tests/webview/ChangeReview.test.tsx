/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ChangeSetView } from "../../src/shared/protocol";
import { ChangeReview } from "../../src/webview/ChangeReview";

const CHANGE_SET: ChangeSetView = {
  changeSetId: "changes-1",
  runId: "run-1",
  applyToken: "g".repeat(64),
  reviewNoteId: "review-note-1",
  changes: [
    {
      id: "change-1",
      kind: "note",
      operation: "update",
      targetId: "note-1",
      targetLabel: "Guide",
      before: "Old",
      after: "New",
      diff: "-Old\n+New",
      status: "proposed",
    },
    {
      id: "change-2",
      kind: "file",
      operation: "replace",
      targetId: "readme.md",
      targetLabel: "readme.md",
      before: "Old",
      after: "New",
      diff: "-Old\n+New",
      status: "conflict",
      message: "Changed on disk",
    },
  ],
};

describe("ChangeReview", () => {
  test("keeps selection and Apply/Discard controls reachable", () => {
    const onSelectAll = jest.fn();
    const onSelectNone = jest.fn();
    const onApply = jest.fn();
    const onDiscard = jest.fn();
    const onOpenReview = jest.fn();
    render(
      <ChangeReview
        changeSet={CHANGE_SET}
        acceptedIds={new Set(["change-1"])}
        disabled={false}
        phase="Waiting for approval"
        onToggle={jest.fn()}
        onSelectAll={onSelectAll}
        onSelectNone={onSelectNone}
        onApply={onApply}
        onDiscard={onDiscard}
        onDeny={jest.fn()}
        onOpenReview={onOpenReview}
      />,
    );

    expect(screen.getByText("update · note")).toBeTruthy();
    expect(screen.getByText("conflict")).toBeTruthy();
    expect(screen.queryByText("-Old")).toBeNull();
    expect(screen.getByText("1 accepted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open review" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onOpenReview).toHaveBeenCalledTimes(1);
    expect(onSelectNone).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
