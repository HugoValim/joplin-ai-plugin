import type { RollbackRecord } from "../../src/agent/changeCompensation";
import { ChatStore } from "../../src/persistence/chatStore";
import { JsonRollbackStore } from "../../src/persistence/rollbackStore";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

function record(runId: string, createdAt: number): RollbackRecord {
  return {
    runId,
    chatId: "chat-1",
    createdAt,
    items: [
      {
        kind: "file",
        changeId: "change-1",
        chatId: "chat-1",
        snapshot: {
          relativePath: "guide.md",
          bytesBase64: Buffer.from("original").toString("base64"),
          sha256: "original-hash",
          mode: 0o644,
        },
        expectedAppliedSha256: "applied-hash",
      },
      {
        kind: "note-create",
        changeId: "change-note-create",
        noteId: "note-created",
        expectedAppliedUpdatedTime: 2,
      },
      {
        kind: "notebook-create",
        changeId: "change-notebook-create",
        notebookId: "notebook-created",
        expectedAppliedUpdatedTime: 3,
      },
      {
        kind: "note-trash",
        changeId: "change-note-trash",
        original: {
          id: "note-trashed",
          title: "Draft",
          parentId: "folder-1",
          updatedTime: 4,
          order: 0,
        },
        expectedAppliedUpdatedTime: 5,
      },
    ],
  };
}

describe("JsonRollbackStore", () => {
  test("persists an exact rollback record", async () => {
    const files = new MemoryJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => 1_000);
    const input = record("run-1", 1_000);

    await store.save(input);

    expect(await store.get("run-1")).toEqual(input);
  });

  test("persists repository-sized organization titles", async () => {
    const files = new MemoryJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => 1_000);
    const input: RollbackRecord = {
      runId: "run-long-title",
      chatId: "chat-1",
      createdAt: 1_000,
      items: [
        {
          kind: "note-metadata",
          changeId: "change-long-title",
          original: {
            id: "note-1",
            title: "x".repeat(100_000),
            parentId: "folder-1",
            updatedTime: 1,
            order: 0,
          },
          expectedAppliedUpdatedTime: 2,
        },
      ],
    };

    await store.save(input);

    expect(await store.get(input.runId)).toEqual(input);
  });

  test("persists an application journal before rollback items exist", async () => {
    const files = new MemoryJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => 1_000);
    const journal: RollbackRecord = {
      runId: "run-applying",
      chatId: "chat-1",
      createdAt: 1_000,
      items: [],
      application: {
        changeSetId: "changes-1",
        state: "applying",
        acceptedChangeIds: ["change-1"],
      },
    };

    await store.save(journal);

    expect(await store.get(journal.runId)).toEqual(journal);
  });

  test("removes a rollback record and its index entry", async () => {
    const files = new MemoryJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => 1_000);
    await store.save(record("run-remove", 1_000));

    await store.remove("run-remove");

    expect(await store.get("run-remove")).toBeNull();
    expect(files.removed).toContain("/plugin/rollbacks/run-remove.json");
  });

  test("retains only the latest ten runs within seven days", async () => {
    const now = 8 * 24 * 60 * 60 * 1_000;
    const files = new MemoryJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => now);
    await store.save(record("expired", 0));
    for (let index = 0; index < 11; index += 1) {
      await store.save(record(`run-${index}`, now + index));
    }

    expect(await store.get("expired")).toBeNull();
    expect(await store.get("run-0")).toBeNull();
    expect(await store.get("run-10")).not.toBeNull();
    expect(files.removed).toEqual(
      expect.arrayContaining([
        "/plugin/rollbacks/expired.json",
        "/plugin/rollbacks/run-0.json",
      ]),
    );
  });

  test("repairs merge ownership after chat save and immediate rollback fail", async () => {
    const files = new FailingRollbackJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Before merge");
    const store = new JsonRollbackStore("/plugin", files, () => 1_000);
    const target = record("run-target", 1_000);
    const source = record("run-source", 999);
    await store.save(target);
    await store.save(source);
    await store.beginMerge({
      targetRunId: target.runId,
      sourceRunId: source.runId,
      chatId: "chat-1",
      target,
      source,
    });
    await store.save({ ...target, items: [...target.items, ...source.items] });
    await store.save({ ...source, items: [] });
    files.failChatWrites = true;
    files.failRollbackWrites = true;

    await expect(chats.save({ ...chat, title: "Merged" })).rejects.toThrow(
      "Chat persistence unavailable",
    );

    await expect(store.rollbackPendingMerge()).rejects.toThrow(
      "Rollback persistence unavailable",
    );

    files.failChatWrites = false;
    files.failRollbackWrites = false;
    const restarted = new JsonRollbackStore("/plugin", files, () => 1_000);
    await restarted.rollbackPendingMerge();
    expect(await restarted.get(target.runId)).toEqual(target);
    expect(await restarted.get(source.runId)).toEqual(source);
    expect(files.files.has("/plugin/rollbacks/merge-journal.json")).toBe(false);
  });

  test("rejects ordinary reads while a live merge journal exists", async () => {
    const files = new MemoryJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => 1_000);
    const target = record("run-live-target", 1_000);
    const source = record("run-live-source", 999);
    await store.save(target);
    await store.save(source);
    await store.beginMerge({
      targetRunId: target.runId,
      sourceRunId: source.runId,
      chatId: "chat-1",
      target,
      source,
    });

    await expect(store.get(target.runId)).rejects.toThrow(
      "is pending; expected lifecycle recovery",
    );
    expect(await store.pendingMerge()).not.toBeNull();
    await store.rollbackPendingMerge();
    expect(await store.get(target.runId)).toEqual(target);
  });

  test("keeps merged ownership when journal deletion fails after chat save", async () => {
    const files = new FailingRollbackJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => 1_000);
    const target = record("run-merged-target", 1_000);
    const source = record("run-merged-source", 999);
    await store.save(target);
    await store.save(source);
    await store.beginMerge({
      targetRunId: target.runId,
      sourceRunId: source.runId,
      chatId: "chat-1",
      target,
      source,
    });
    await store.save({ ...target, items: [...target.items, ...source.items] });
    await store.save({ ...source, items: [] });
    files.failMergeJournalRemoves = true;

    await expect(
      store.commitPendingMerge(target.runId, source.runId),
    ).rejects.toThrow("Merge journal removal unavailable");

    files.failMergeJournalRemoves = false;
    const restarted = new JsonRollbackStore("/plugin", files, () => 1_000);
    await expect(restarted.get(target.runId)).rejects.toThrow(
      "is pending; expected lifecycle recovery",
    );
    await restarted.commitPendingMerge(target.runId, source.runId);
    expect((await restarted.get(target.runId))?.items).toHaveLength(8);
    expect((await restarted.get(source.runId))?.items).toHaveLength(0);
  });
});

class FailingRollbackJsonFilePort extends MemoryJsonFilePort {
  public failChatWrites = false;
  public failRollbackWrites = false;
  public failMergeJournalRemoves = false;

  public override writeTextAtomic(
    path: string,
    content: string,
  ): Promise<void> {
    if (this.failChatWrites && path.includes("/chats/")) {
      return Promise.reject(new Error("Chat persistence unavailable"));
    }
    if (this.failRollbackWrites && path.includes("/rollbacks/")) {
      return Promise.reject(new Error("Rollback persistence unavailable"));
    }
    return super.writeTextAtomic(path, content);
  }

  public override removeFile(path: string): Promise<void> {
    if (this.failMergeJournalRemoves && path.endsWith("merge-journal.json")) {
      return Promise.reject(new Error("Merge journal removal unavailable"));
    }
    return super.removeFile(path);
  }
}
