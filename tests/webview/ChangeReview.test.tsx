/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { ChangeSetView } from "../../src/shared/protocol";
import {
  ChangeReview,
  type ChangeReviewTransport,
} from "../../src/webview/ChangeReview";

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
      disabled={false}
      phase="Waiting for approval"
      transport={{ send: jest.fn() }}
      {...overrides}
    />,
  );
}

describe("ChangeReview", () => {
  test("keeps a compact list with stats and opens the Review Note", () => {
    const transport: ChangeReviewTransport = { send: jest.fn() };
    renderProposed({ transport });

    expect(screen.getAllByText("+1/−1").length).toBeGreaterThan(0);
    expect(screen.queryByText("-Old")).toBeNull();
    expect(screen.getByText(/Diffs open in the note editor/i)).toBeTruthy();
    expect(transport.send).toHaveBeenCalledWith({
      type: "open",
      changeSetId: "changes-1",
      runId: "run-1",
    });
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open review" })).toBeTruthy();
  });

  test("post-apply mode offers per-row Keep and Undo controls", () => {
    const transport: ChangeReviewTransport = { send: jest.fn() };
    renderProposed({
      changeSet: APPLIED_SET,
      phase: "Review applied changes",
      transport,
    });
    (transport.send as jest.Mock).mockClear();

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    const keepButtons = screen.getAllByRole("button", { name: "Keep" });
    const undoButtons = screen.getAllByRole("button", { name: "Undo" });
    fireEvent.click(keepButtons[0]!);
    expect(transport.send).toHaveBeenCalledWith({
      type: "keep",
      changeSetId: "changes-1",
      changeIds: ["change-1"],
      runId: "run-1",
      phase: "Keeping changes",
    });
    fireEvent.click(undoButtons[0]!);
    expect(transport.send).toHaveBeenCalledWith({
      type: "undo",
      changeSetId: "changes-1",
      changeIds: ["change-1"],
      runId: "run-1",
      phase: "Undoing changes",
    });
    fireEvent.click(screen.getByRole("button", { name: "Keep all" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo all" }));
    expect(transport.send).toHaveBeenCalledWith({
      type: "keep",
      changeSetId: "changes-1",
      changeIds: ["change-1", "change-create"],
      runId: "run-1",
      phase: "Keeping changes",
    });
    expect(transport.send).toHaveBeenCalledWith({
      type: "deny",
      changeSetId: "changes-1",
      runId: "run-1",
      phase: "Denying and restoring changes",
    });
  });

  test("owns proposal selection and emits apply, discard, and deny intents", () => {
    const transport: ChangeReviewTransport = { send: jest.fn() };
    renderProposed({ transport });
    (transport.send as jest.Mock).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByText("0 accepted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("1 accepted")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Accept Guide"));
    expect(screen.getByText("0 accepted")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Accept Guide"));

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny & Restore" }));

    expect(transport.send).toHaveBeenCalledWith({
      type: "apply",
      changeSetId: "changes-1",
      acceptedIds: ["change-1"],
      applyToken: "g".repeat(64),
      runId: "run-1",
      phase: "Applying changes",
    });
    expect(transport.send).toHaveBeenCalledWith({
      type: "discard",
      changeSetId: "changes-1",
      runId: "run-1",
      phase: "Discarding changes",
    });
    expect(transport.send).toHaveBeenCalledWith({
      type: "deny",
      changeSetId: "changes-1",
      runId: "run-1",
      phase: "Denying and restoring changes",
    });
  });

  test("falls back to the Change Set id when a run id is absent", () => {
    const transport: ChangeReviewTransport = { send: jest.fn() };
    renderProposed({
      changeSet: { ...CHANGE_SET, runId: undefined },
      transport,
    });

    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "changes-1" }),
    );
  });

  test("resets selection and auto-opens when the pending Change Set changes", () => {
    const transport: ChangeReviewTransport = { send: jest.fn() };
    const rendered = renderProposed({ transport });
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));

    rendered.rerender(
      <ChangeReview
        changeSet={{ ...CHANGE_SET, changeSetId: "changes-2" }}
        disabled={false}
        phase="Waiting for approval"
        transport={transport}
      />,
    );

    expect(screen.getByText("1 accepted")).toBeTruthy();
    expect(transport.send).toHaveBeenCalledWith({
      type: "open",
      changeSetId: "changes-2",
      runId: "run-1",
    });
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
