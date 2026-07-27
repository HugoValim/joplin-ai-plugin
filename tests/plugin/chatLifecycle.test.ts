import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { ChatStore } from "../../src/persistence/chatStore";
import { persistRunOutcome } from "../../src/plugin/chatLifecycle";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

describe("persistRunOutcome", () => {
  test("stores final assistant text and a restart-safe pending batch", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Review");
    const changes = new InMemoryChangeSetStore();
    changes.add(chat.id, "run-1", {
      kind: "file",
      relativePath: "guide.md",
      targetLabel: "guide.md",
      before: "Old",
      after: "New",
      expectedSha256: "original-hash",
    });
    const changeSet = changes.getByRun("run-1");
    if (!changeSet) throw new Error("Expected pending change set");

    await persistRunOutcome(
      chats,
      chat,
      "run-1",
      {
        status: "awaiting-approval",
        messages: [],
        assistantText: "Review complete.",
        changeSet,
        continuation: null,
      },
      [{ kind: "note", id: "note-1", label: "Guide" }],
    );

    const saved = await chats.get(chat.id);
    expect(saved?.messages[0]?.content).toBe("Review complete.");
    expect(saved?.pendingChangeSet).toEqual(changeSet);
    expect(saved?.runSummaries[0]?.status).toBe("awaiting-approval");
  });

  test("does not resurrect a turn cleared during provider execution", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const created = await chats.create("Review");
    const submitted = {
      ...created,
      messages: [
        {
          id: "user-1",
          role: "user" as const,
          content: "Review",
          createdAt: 1,
        },
      ],
    };
    await chats.save(submitted);
    await chats.clear(created.id);

    await expect(
      persistRunOutcome(
        chats,
        submitted,
        "run-1",
        {
          status: "completed",
          messages: [],
          assistantText: "Late response",
          changeSet: null,
          continuation: null,
        },
        [],
      ),
    ).rejects.toThrow("changed during model run");
    expect((await chats.get(created.id))?.messages).toEqual([]);
  });
});
