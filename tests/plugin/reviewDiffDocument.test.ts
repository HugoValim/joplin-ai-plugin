import type { ChangeSet } from "../../src/persistence/changeSetStore";
import { renderReviewDiffDocument } from "../../src/plugin/reviewDiffDocument";

function sampleChangeSet(): ChangeSet {
  return {
    id: "changes-1",
    chatId: "chat-1",
    runId: "run-1",
    createdAt: 1,
    status: "proposed",
    changes: [
      {
        id: "change-update",
        kind: "note",
        operation: "update",
        noteId: "note-1",
        expectedUpdatedTime: 10,
        targetLabel: "Guide",
        before: "Old body",
        after: "New body",
        diff: "@@ -1 +1 @@\n-Old body\n+New body",
        status: "proposed",
      },
      {
        id: "change-delete",
        kind: "note",
        operation: "delete",
        noteId: "note-2",
        expectedUpdatedTime: 11,
        targetLabel: "Archive",
        before: "Title: Archive",
        after: "Moved to Joplin Trash (recoverable).",
        diff: "delete diff",
        status: "proposed",
        message: "Requires confirmation",
      },
    ],
  };
}

describe("renderReviewDiffDocument", () => {
  test("renders banner, table of contents, and fenced diffs", () => {
    const body = renderReviewDiffDocument({
      chatTitle: "Draft chat",
      changeSet: sampleChangeSet(),
    });

    expect(body).toContain("View-only review document");
    expect(body).toContain("## Contents");
    expect(body).toContain("[update · Guide](#change-change-update)");
    expect(body).toContain("### Diff");
    expect(body).toContain("```diff");
    expect(body).toContain("-Old body");
  });

  test("uses summary lines for delete and org-style changes", () => {
    const body = renderReviewDiffDocument({
      chatTitle: "Draft chat",
      changeSet: sampleChangeSet(),
    });

    expect(body).toContain("### Summary");
    expect(body).toContain("`Title: Archive` → `Moved to Joplin Trash (recoverable).`");
    expect(body).toContain("Requires confirmation");
  });

  test("truncates oversized diffs", () => {
    const changeSet: ChangeSet = {
      ...sampleChangeSet(),
      changes: [
        {
          id: "change-large",
          kind: "file",
          relativePath: "big.md",
          expectedSha256: "hash",
          targetLabel: "big.md",
          before: "a",
          after: "b",
          diff: "x".repeat(600_000),
          status: "proposed",
        },
      ],
    };

    const body = renderReviewDiffDocument({
      chatTitle: "Large",
      changeSet,
    });

    expect(body).toContain("diff truncated");
    expect(body.length).toBeLessThan(600_000);
  });
});
