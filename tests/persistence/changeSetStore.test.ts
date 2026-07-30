import {
  InMemoryChangeSetStore,
  type FileChangeProposalInput,
} from "../../src/persistence/changeSetStore";

describe("InMemoryChangeSetStore", () => {
  test("collects file edits without writing and produces a review diff", () => {
    const store = new InMemoryChangeSetStore();
    const input: FileChangeProposalInput = {
      kind: "file",
      relativePath: "guide.md",
      targetLabel: "guide.md",
      before: "# Guide\nOld wording.",
      after: "# Guide\nClear wording.",
      expectedSha256: "abc123",
    };

    const change = store.add("chat-1", "run-1", input);
    const changeSet = store.getByRun("run-1");

    expect(change.diff).toContain("-Old wording.");
    expect(change.diff).toContain("+Clear wording.");
    expect(changeSet?.changes).toEqual([change]);
    expect(changeSet?.status).toBe("proposed");
  });

  test("restores a persisted proposal batch for approval after restart", () => {
    const original = new InMemoryChangeSetStore();
    original.add("chat-1", "run-1", {
      kind: "file",
      relativePath: "guide.md",
      targetLabel: "guide.md",
      before: "Old",
      after: "New",
      expectedSha256: "abc123",
    });
    const persisted = original.getByRun("run-1");
    expect(persisted).not.toBeNull();

    const restored = new InMemoryChangeSetStore();
    restored.restore(persisted!);

    expect(restored.getByRun("run-1")).toEqual(persisted);
  });

  test("restores persisted organization proposals", () => {
    const original = new InMemoryChangeSetStore();
    original.add("chat-1", "run-1", {
      kind: "note",
      operation: "move",
      noteId: "note-1",
      parentId: "notebook-2",
      expectedUpdatedTime: 123,
      targetLabel: "Note",
      before: "Notebook: notebook-1",
      after: "Notebook: notebook-2",
    });
    original.add("chat-1", "run-1", {
      kind: "notebook",
      operation: "delete",
      notebookId: "notebook-1",
      expectedUpdatedTime: 456,
      targetLabel: "Notebook",
      before: "Active",
      after: "Trash",
    });
    const persisted = original.getByRun("run-1");
    expect(persisted).not.toBeNull();

    const restored = new InMemoryChangeSetStore();
    restored.restore(persisted!);

    expect(restored.getByRun("run-1")).toEqual(persisted);
  });

  test("rejects approval access from another chat or run", () => {
    const store = new InMemoryChangeSetStore();
    store.add("chat-1", "run-1", {
      kind: "file",
      relativePath: "guide.md",
      targetLabel: "guide.md",
      before: "Old",
      after: "New",
      expectedSha256: "abc123",
    });
    const changeSet = store.getByRun("run-1");
    if (!changeSet) throw new Error("Expected change set");

    expect(() =>
      store.getScoped(changeSet.id, { chatId: "chat-2", runId: "run-1" }),
    ).toThrow("expected chat chat-2 run run-1");
  });

  test("absorbs earlier applied changes and drops the source set", () => {
    const store = new InMemoryChangeSetStore();
    const older = store.add("chat-1", "run-old", {
      kind: "file",
      relativePath: "a.md",
      targetLabel: "a.md",
      before: "A0",
      after: "A1",
      expectedSha256: "a0",
    });
    const newer = store.add("chat-1", "run-new", {
      kind: "file",
      relativePath: "b.md",
      targetLabel: "b.md",
      before: "B0",
      after: "B1",
      expectedSha256: "b0",
    });
    const oldSet = store.getByRun("run-old");
    const newSet = store.getByRun("run-new");
    if (!oldSet || !newSet) throw new Error("Expected change sets");
    store.setResults(oldSet.id, [{ ...older, status: "applied" }]);
    store.setResults(newSet.id, [{ ...newer, status: "applied" }]);

    const merged = store.absorbAppliedChanges(newSet.id, oldSet.changes, {
      chatId: "chat-1",
      runId: "run-new",
    });
    store.drop(oldSet.id);

    expect(merged.changes.map((change) => change.targetLabel)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(store.get(oldSet.id)).toBeNull();
    expect(store.getByRun("run-old")).toBeNull();
    expect(store.getByRun("run-new")?.changes).toHaveLength(2);
  });
});
