import {
  InMemoryChangeSetStore,
  type ChangeSet,
} from "../../src/persistence/changeSetStore";
import { ChangeSetLifecycle } from "../../src/persistence/changeSetLifecycle";
import { ChatStore, type PersistedChat } from "../../src/persistence/chatStore";
import type { ReviewNotePort } from "../../src/plugin/reviewNoteService";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

describe("ChangeSetLifecycle", () => {
  test("activates manual review with an attached Review Note and apply token", async () => {
    const harness = await reviewHarness("Review");
    const changeSet = addNoteUpdate(harness.changes, harness.chat.id, "run-1");

    const activation = await harness.lifecycle.activateReview(changeSet, false);

    expect(activation).toMatchObject({
      mode: "manual",
      changeSet: { id: changeSet.id, reviewNoteId: "review-note-1" },
    });
    expect(activation.applyToken).toHaveLength(64);
    expect(
      harness.lifecycle.verifyApplyToken(changeSet.id, activation.applyToken),
    ).toBe(true);
    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet,
    ).toEqual(activation.changeSet);
    expect(harness.reviewNotes.opened).toEqual([
      { changeSetId: changeSet.id, chatTitle: "Review" },
    ]);
  });

  test("activates eligible auto-apply with the accepted change ids", async () => {
    const harness = await reviewHarness("Automatic review");
    const changeSet = addFileUpdate(
      harness.changes,
      harness.chat.id,
      "run-auto",
    );

    const activation = await harness.lifecycle.activateReview(changeSet, true);

    expect(activation).toMatchObject({
      mode: "automatic",
      acceptedChangeIds: [changeSet.changes[0]?.id],
    });
  });

  test("keeps deletion proposals on manual review when auto-apply is enabled", async () => {
    const harness = await reviewHarness("Deletion review");
    const changeSet = addNoteDeletion(
      harness.changes,
      harness.chat.id,
      "run-delete",
    );

    const activation = await harness.lifecycle.activateReview(changeSet, true);

    expect(activation.mode).toBe("manual");
  });

  test("leaves presentation uncommitted when Review Note attachment fails", async () => {
    const harness = await reviewHarness(
      "Failed review",
      new RecordingReviewNotePort(true),
    );
    const changeSet = addNoteUpdate(
      harness.changes,
      harness.chat.id,
      "run-failed",
    );

    await expect(
      harness.lifecycle.activateReview(changeSet, false),
    ).rejects.toThrow("Review Note unavailable");
    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet,
    ).toBeNull();
    expect(harness.changes.get(changeSet.id)?.reviewNoteId).toBeUndefined();
  });

  test("reopens a pending review through the lifecycle", async () => {
    const harness = await reviewHarness("Reopen review");
    const pending = addNoteUpdate(
      harness.changes,
      harness.chat.id,
      "run-reopen",
    );
    await harness.chats.save({ ...harness.chat, pendingChangeSet: pending });

    const reviewed = await harness.lifecycle.openReview(
      harness.chat.id,
      pending.id,
    );

    expect(reviewed.reviewNoteId).toBe("review-note-1");
    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet,
    ).toEqual(reviewed);
  });

  test("recovers a persisted pending Change Set", async () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = recoveryLifecycle(changes);
    const pending = sampleChangeSet("pending-1", "run-1", "proposed");

    await lifecycle.recover(sampleChat({ pendingChangeSet: pending }));

    expect(changes.get(pending.id)).toEqual(pending);
  });

  test("recovers a parked applied Change Set", async () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = recoveryLifecycle(changes);
    const applied = sampleChangeSet("applied-1", "run-1", "applied");

    await lifecycle.recover(sampleChat({ parkedAppliedChangeSet: applied }));

    expect(changes.get(applied.id)).toEqual(applied);
  });

  test("does nothing when persisted Change Set references are missing", async () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = recoveryLifecycle(changes);

    await lifecycle.recover(sampleChat());

    expect(changes.getByRun("run-1")).toBeNull();
  });

  test("rejects a malformed persisted Change Set reference", async () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = recoveryLifecycle(changes);
    const malformed = {
      ...sampleChangeSet("bad-1", "run-1", "proposed"),
      chatId: undefined,
    };

    await expect(
      lifecycle.recover(
        sampleChat({ pendingChangeSet: malformed as unknown as ChangeSet }),
      ),
    ).rejects.toThrow("expected a schema-v1 proposal batch");
  });

  test("repeated recovery leaves the same runtime state", async () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = recoveryLifecycle(changes);
    const pending = sampleChangeSet("pending-1", "run-new", "proposed");
    const parked = sampleChangeSet("applied-1", "run-old", "applied");
    const chat = sampleChat({
      pendingChangeSet: pending,
      parkedAppliedChangeSet: parked,
    });

    await lifecycle.recover(chat);
    await lifecycle.recover(chat);

    expect(changes.get(pending.id)).toEqual(pending);
    expect(changes.get(parked.id)).toEqual(parked);
  });
});

function recoveryLifecycle(
  changes: InMemoryChangeSetStore,
): ChangeSetLifecycle {
  return new ChangeSetLifecycle(
    changes,
    new ChatStore("/plugin", new MemoryJsonFilePort()),
    new RecordingReviewNotePort(),
  );
}

interface ReviewHarness {
  readonly changes: InMemoryChangeSetStore;
  readonly chats: ChatStore;
  readonly chat: PersistedChat;
  readonly lifecycle: ChangeSetLifecycle;
  readonly reviewNotes: RecordingReviewNotePort;
}

async function reviewHarness(
  title: string,
  reviewNotes = new RecordingReviewNotePort(),
): Promise<ReviewHarness> {
  const changes = new InMemoryChangeSetStore();
  const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
  const chat = await chats.create(title);
  return {
    changes,
    chats,
    chat,
    lifecycle: new ChangeSetLifecycle(changes, chats, reviewNotes),
    reviewNotes,
  };
}

function addNoteUpdate(
  changes: InMemoryChangeSetStore,
  chatId: string,
  runId: string,
): ChangeSet {
  changes.add(chatId, runId, {
    kind: "note",
    operation: "update",
    noteId: "note-1",
    targetLabel: "Guide",
    before: "Old",
    after: "New",
    expectedUpdatedTime: 1,
  });
  return requiredChangeSet(changes, runId);
}

function addFileUpdate(
  changes: InMemoryChangeSetStore,
  chatId: string,
  runId: string,
): ChangeSet {
  changes.add(chatId, runId, {
    kind: "file",
    relativePath: "guide.md",
    targetLabel: "guide.md",
    before: "Old",
    after: "New",
    expectedSha256: "old-hash",
  });
  return requiredChangeSet(changes, runId);
}

function addNoteDeletion(
  changes: InMemoryChangeSetStore,
  chatId: string,
  runId: string,
): ChangeSet {
  changes.add(chatId, runId, {
    kind: "note",
    operation: "delete",
    noteId: "note-1",
    targetLabel: "Guide",
    before: "Old",
    after: "Moved to Trash",
    expectedUpdatedTime: 1,
  });
  return requiredChangeSet(changes, runId);
}

function requiredChangeSet(
  changes: InMemoryChangeSetStore,
  runId: string,
): ChangeSet {
  const changeSet = changes.getByRun(runId);
  if (changeSet) return changeSet;
  throw new Error(`Change Set for ${runId} missing; expected proposal`);
}

class RecordingReviewNotePort implements ReviewNotePort {
  public readonly opened: Array<{
    readonly changeSetId: string;
    readonly chatTitle: string;
  }> = [];

  public constructor(private readonly failOpen = false) {}

  public openForChangeSet(
    changeSet: ChangeSet,
    chatTitle: string,
  ): Promise<string> {
    if (this.failOpen) {
      return Promise.reject(new Error("Review Note unavailable"));
    }
    this.opened.push({ changeSetId: changeSet.id, chatTitle });
    return Promise.resolve("review-note-1");
  }

  public ensureOpen(changeSet: ChangeSet, chatTitle: string): Promise<string> {
    return this.openForChangeSet(changeSet, chatTitle);
  }

  public dispose(_noteId: string): Promise<void> {
    return Promise.resolve();
  }
}

function sampleChat(overrides: Partial<PersistedChat> = {}): PersistedChat {
  return {
    schemaVersion: 1,
    id: "chat-1",
    title: "Recovery",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    context: sampleContext,
    externalRoot: null,
    references: [],
    runSummaries: [],
    pendingChangeSet: null,
    parkedAppliedChangeSet: null,
    ...overrides,
  };
}

const sampleContext: PersistedChat["context"] = {
  activeNote: true,
  vault: false,
  autoApply: false,
  interactionMode: "agent",
  attachedNoteIds: [],
  attachedNotebookIds: [],
  selectionRefs: [],
};

function sampleChangeSet(
  id: string,
  runId: string,
  status: ChangeSet["status"],
): ChangeSet {
  return {
    id,
    chatId: "chat-1",
    runId,
    createdAt: 1,
    status,
    changes: [],
  };
}
