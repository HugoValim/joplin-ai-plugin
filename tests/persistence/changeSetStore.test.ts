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
});
