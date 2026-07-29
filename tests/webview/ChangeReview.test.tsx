/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
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
      diff: "@@ -1 +1 @@\n-Old\n+New",
      status: "proposed",
      undoable: true,
    },
    {
      id: "change-2",
      kind: "file",
      operation: "replace",
      targetId: "readme.md",
      targetLabel: "readme.md",
      before: "Old",
      after: "New",
      diff: "@@ -1 +1 @@\n-Old\n+New",
      status: "conflict",
      message: "Changed on disk",
      undoable: false,
    },
  ],
};

const APPLIED_SET: ChangeSetView = {
  ...CHANGE_SET,
  changes: [
    {
      ...CHANGE_SET.changes[0]!,
      status: "applied",
      undoable: true,
    },
    {
      id: "change-create",
      kind: "note",
      operation: "create",
      targetId: "note-2",
      targetLabel: "New note",
      before: "",
      after: "Body",
      diff: "@@ -0,0 +1 @@\n+Body",
      status: "applied",
      undoable: false,
    },
  ],
};

function renderProposed(
  overrides: Partial<ComponentProps<typeof ChangeReview>> = {},
): ReturnType<typeof render> {
  return render(
    <ChangeReview
      changeSet={CHANGE_SET}
      acceptedIds={new Set(["change-1"])}
      disabled={false}
      phase="Waiting for approval"
      onToggle={jest.fn()}
      onSelectAll={jest.fn()}
      onSelectNone={jest.fn()}
      onApply={jest.fn()}
      onDiscard={jest.fn()}
      onDeny={jest.fn()}
      onOpenReview={jest.fn()}
      onKeep={jest.fn()}
      onKeepAll={jest.fn()}
      onUndoChange={jest.fn()}
      onUndoAll={jest.fn()}
      {...overrides}
    />,
  );
}

describe("ChangeReview", () => {
  test("keeps a compact list with stats and opens the Review Note", () => {
    const onOpenReview = jest.fn();
    renderProposed({ onOpenReview });

    expect(screen.getAllByText("+1/−1").length).toBeGreaterThan(0);
    expect(screen.queryByText("-Old")).toBeNull();
    expect(screen.getByText(/Diffs open in the note editor/i)).toBeTruthy();
    expect(onOpenReview).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open review" })).toBeTruthy();
  });

  test("post-apply mode offers per-row Keep and Undo controls", () => {
    const onKeep = jest.fn();
    const onUndoChange = jest.fn();
    const onKeepAll = jest.fn();
    const onUndoAll = jest.fn();
    renderProposed({
      changeSet: APPLIED_SET,
      phase: "Review applied changes",
      onKeep,
      onUndoChange,
      onKeepAll,
      onUndoAll,
    });

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    const keepButtons = screen.getAllByRole("button", { name: "Keep" });
    const undoButtons = screen.getAllByRole("button", { name: "Undo" });
    fireEvent.click(keepButtons[0]!);
    expect(onKeep).toHaveBeenCalledWith("change-1");
    fireEvent.click(undoButtons[0]!);
    expect(onUndoChange).toHaveBeenCalledWith("change-1");
    fireEvent.click(screen.getByRole("button", { name: "Keep all" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo all" }));
    expect(onKeepAll).toHaveBeenCalledTimes(1);
    expect(onUndoAll).toHaveBeenCalledTimes(1);
  });

  test("disables Undo for non-undoable applied changes", () => {
    renderProposed({
      changeSet: APPLIED_SET,
      phase: "Review applied changes",
    });

    const undoButtons = screen.getAllByRole("button", { name: "Undo" });
    expect(undoButtons[0]).toHaveProperty("disabled", false);
    expect(undoButtons[1]).toHaveProperty("disabled", true);
  });
});
