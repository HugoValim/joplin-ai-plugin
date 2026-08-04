import {
  InMemoryChangeSetStore,
  type ChangeSet,
  type ChangeSetScope,
} from "../../src/persistence/changeSetStore";
import {
  ChangeSetLifecycle,
  type ChangeSetApplyResult,
  type ChangeSetResolutionEvent,
  type ChangeSetResolutionTransitionPort,
  type ChangeSetRollbackPort,
} from "../../src/persistence/changeSetLifecycle";
import { ChatStore, type PersistedChat } from "../../src/persistence/chatStore";
import type { ReviewNotePort } from "../../src/plugin/reviewNoteService";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

describe("ChangeSetLifecycle cumulative parking", () => {
  test("parks the first applied review and disposes its Review Note once", async () => {
    const harness = await parkingHarness();
    const applied = await addAppliedReview(harness, "run-first", "First");

    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );

    const saved = await harness.chats.get(harness.chat.id);
    expect(saved?.pendingChangeSet).toBeNull();
    expect(saved?.parkedAppliedChangeSet).toEqual({
      ...applied,
      reviewNoteId: undefined,
    });
    expect(harness.reviewNotes.disposed).toEqual(["review-run-first"]);
  });

  test("merges a repeated park in chronological order with its rollback", async () => {
    const harness = await parkingHarness();
    const older = await addAppliedReview(harness, "run-older", "Older");
    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );
    const newer = await addAppliedReview(harness, "run-newer", "Newer");

    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );

    const parked = (await harness.chats.get(harness.chat.id))
      ?.parkedAppliedChangeSet;
    expect(parked?.runId).toBe("run-newer");
    expect(parked?.changes.map((change) => change.targetLabel)).toEqual([
      "Older",
      "Newer",
    ]);
    expect(harness.application.merges).toEqual([
      { runId: "run-newer", chatId: harness.chat.id, sourceRunId: "run-older" },
    ]);
    expect(harness.changes.get(older.id)).toBeNull();
    expect(harness.changes.get(newer.id)?.changes).toHaveLength(2);
    expect(harness.reviewNotes.disposed).toEqual([
      "review-run-older",
      "review-run-newer",
    ]);
  });

  test("abandons pending and parked state with exact-once cleanup", async () => {
    const harness = await parkingHarness();
    const parked = await addAppliedReview(harness, "run-parked", "Parked");
    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );
    const pending = await addProposedReview(harness, "run-pending", "Pending");
    const token = harness.lifecycle.ensureApplyToken(pending.id);

    await harness.lifecycle.abandon(harness.chat.id);

    expect(harness.reviewNotes.disposed).toEqual([
      "review-run-parked",
      "review-run-pending",
    ]);
    expect(harness.changes.get(parked.id)).toBeNull();
    expect(harness.changes.get(pending.id)).toBeNull();
    expect(harness.lifecycle.verifyApplyToken(pending.id, token)).toBe(false);
  });

  test("revokes abandoned approval before Review Note disposal fails", async () => {
    const harness = await parkingHarness();
    const pending = await addProposedReview(harness, "run-failed", "Failed");
    const token = harness.lifecycle.ensureApplyToken(pending.id);
    harness.reviewNotes.failDisposalsWith = "Review Note disposal failed";

    await expect(harness.lifecycle.abandon(harness.chat.id)).rejects.toThrow(
      "Review Note disposal failed",
    );

    expect(harness.changes.get(pending.id)).toBeNull();
    expect(harness.lifecycle.verifyApplyToken(pending.id, token)).toBe(false);
  });

  test("discarding a newer proposal restores the parked applied review", async () => {
    const harness = await parkingHarness();
    const parked = await addAppliedReview(harness, "run-applied", "Applied");
    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );
    const pending = await addProposedReview(
      harness,
      "run-proposed",
      "Proposed",
    );
    const transition = new RecordingTransitionPort();

    await harness.lifecycle.discard(
      {
        chatId: harness.chat.id,
        runId: pending.runId,
        changeSetId: pending.id,
      },
      transition,
    );

    const saved = await harness.chats.get(harness.chat.id);
    expect(saved?.pendingChangeSet).toMatchObject({
      id: parked.id,
      status: "applied",
      reviewNoteId: "review-run-applied",
    });
    expect(saved?.parkedAppliedChangeSet).toBeNull();
    expect(harness.reviewNotes.disposed).toEqual([
      "review-run-applied",
      "review-run-proposed",
    ]);
    expect(transition.restoredChangeSetIds).toEqual([parked.id]);
  });

  test("keeps a newer proposal retryable when parked restoration fails", async () => {
    const harness = await parkingHarness();
    const parked = await addAppliedReview(harness, "run-applied", "Applied");
    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );
    const pending = await addProposedReview(
      harness,
      "run-proposed",
      "Proposed",
    );
    harness.reviewNotes.failOpensWith = "Review Note unavailable";

    await expect(
      harness.lifecycle.discard(
        {
          chatId: harness.chat.id,
          runId: pending.runId,
          changeSetId: pending.id,
        },
        new RecordingTransitionPort(),
      ),
    ).rejects.toThrow("Review Note unavailable");

    const failed = await harness.chats.get(harness.chat.id);
    expect(harness.changes.get(pending.id)?.status).toBe("proposed");
    expect(failed?.pendingChangeSet?.id).toBe(pending.id);
    expect(failed?.parkedAppliedChangeSet?.id).toBe(parked.id);
  });

  test("denying a newer proposal restores and presents the parked review", async () => {
    const harness = await parkingHarness();
    const parked = await addAppliedReview(harness, "run-applied", "Applied");
    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );
    const pending = await addProposedReview(
      harness,
      "run-proposed",
      "Proposed",
    );
    const transition = new RecordingResolutionTransitionPort();

    await harness.lifecycle.deny(
      {
        chatId: harness.chat.id,
        runId: pending.runId,
        changeSetId: pending.id,
      },
      new NoOpRollbackPort(),
      transition,
    );

    const restored = (await harness.chats.get(harness.chat.id))
      ?.pendingChangeSet;
    expect(restored?.id).toBe(parked.id);
    expect(transition.events).toEqual([
      {
        mode: "review",
        changeSet: restored,
        summary: "Changes denied before apply",
        restored: true,
      },
    ]);
  });

  test("rejects an oversized cumulative merge before rollback transfer", async () => {
    const harness = await parkingHarness();
    const older = await addAppliedReview(harness, "run-older", "Older", 51);
    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );
    const newer = await addAppliedReview(harness, "run-newer", "Newer", 50);

    await expect(
      harness.lifecycle.parkAppliedReview(harness.chat.id, harness.application),
    ).rejects.toThrow("would have 101 changes; expected at most 100");

    const saved = await harness.chats.get(harness.chat.id);
    expect(harness.application.merges).toEqual([]);
    expect(saved?.pendingChangeSet?.id).toBe(newer.id);
    expect(saved?.parkedAppliedChangeSet?.id).toBe(older.id);
    expect(harness.changes.get(older.id)?.changes).toHaveLength(51);
    expect(harness.changes.get(newer.id)?.changes).toHaveLength(50);
  });

  test("preserves both reviews when rollback transfer fails", async () => {
    const harness = await parkingHarness();
    const older = await addAppliedReview(harness, "run-older", "Older");
    await harness.lifecycle.parkAppliedReview(
      harness.chat.id,
      harness.application,
    );
    const newer = await addAppliedReview(harness, "run-newer", "Newer");
    harness.application.failMergesWith = "Rollback persistence unavailable";

    await expect(
      harness.lifecycle.parkAppliedReview(harness.chat.id, harness.application),
    ).rejects.toThrow("Rollback persistence unavailable");

    const saved = await harness.chats.get(harness.chat.id);
    expect(saved?.pendingChangeSet?.id).toBe(newer.id);
    expect(saved?.parkedAppliedChangeSet?.id).toBe(older.id);
    expect(harness.changes.get(older.id)?.changes).toHaveLength(1);
    expect(harness.changes.get(newer.id)?.changes).toHaveLength(1);
    expect(harness.reviewNotes.disposed).toEqual(["review-run-older"]);
  });

});

interface ParkingHarness {
  readonly changes: InMemoryChangeSetStore;
  readonly chats: ChatStore;
  readonly chat: PersistedChat;
  readonly lifecycle: ChangeSetLifecycle;
  readonly reviewNotes: RecordingReviewNotePort;
  readonly application: RecordingApplicationPort;
}

async function parkingHarness(): Promise<ParkingHarness> {
  const changes = new InMemoryChangeSetStore();
  const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
  const chat = await chats.create("Cumulative review");
  const reviewNotes = new RecordingReviewNotePort();
  return {
    changes,
    chats,
    chat,
    lifecycle: new ChangeSetLifecycle(changes, chats, reviewNotes),
    reviewNotes,
    application: new RecordingApplicationPort(changes),
  };
}

async function addAppliedReview(
  harness: ParkingHarness,
  runId: string,
  targetLabel: string,
  count = 1,
): Promise<ChangeSet> {
  const changes = Array.from({ length: count }, (_, index) =>
    harness.changes.add(harness.chat.id, runId, {
      kind: "note",
      operation: "update",
      noteId: `note-${runId}-${index}`,
      targetLabel: count === 1 ? targetLabel : `${targetLabel} ${index}`,
      before: "Old",
      after: "New",
      expectedUpdatedTime: 1,
    }),
  );
  const proposed = harness.changes.getByRun(runId);
  if (!proposed) throw new Error(`Missing ${runId}; expected Change Set`);
  harness.changes.setResults(
    proposed.id,
    changes.map((change) => ({ ...change, status: "applied" })),
  );
  const reviewed = harness.changes.attachReviewNote(
    proposed.id,
    `review-${runId}`,
  );
  const current = await harness.chats.get(harness.chat.id);
  if (!current) throw new Error("Missing chat; expected persisted chat");
  await harness.chats.save({ ...current, pendingChangeSet: reviewed });
  return reviewed;
}

async function addProposedReview(
  harness: ParkingHarness,
  runId: string,
  targetLabel: string,
): Promise<ChangeSet> {
  harness.changes.add(harness.chat.id, runId, {
    kind: "note",
    operation: "update",
    noteId: `note-${runId}`,
    targetLabel,
    before: "Old",
    after: "New",
    expectedUpdatedTime: 1,
  });
  const proposed = harness.changes.getByRun(runId);
  if (!proposed) throw new Error(`Missing ${runId}; expected Change Set`);
  const reviewed = harness.changes.attachReviewNote(
    proposed.id,
    `review-${runId}`,
  );
  const current = await harness.chats.get(harness.chat.id);
  if (!current) throw new Error("Missing chat; expected persisted chat");
  await harness.chats.save({ ...current, pendingChangeSet: reviewed });
  return reviewed;
}

class RecordingReviewNotePort implements ReviewNotePort {
  public readonly disposed: string[] = [];
  public failDisposalsWith: string | null = null;
  public failOpensWith: string | null = null;
  public replacementNoteId: string | null = null;

  public openForChangeSet(changeSet: ChangeSet): Promise<string> {
    if (this.failOpensWith)
      return Promise.reject(new Error(this.failOpensWith));
    return Promise.resolve(
      this.replacementNoteId ??
        changeSet.reviewNoteId ??
        `review-${changeSet.runId}`,
    );
  }

  public ensureOpen(changeSet: ChangeSet): Promise<string> {
    return this.openForChangeSet(changeSet);
  }

  public dispose(noteId: string): Promise<void> {
    this.disposed.push(noteId);
    if (this.failDisposalsWith)
      return Promise.reject(new Error(this.failDisposalsWith));
    return Promise.resolve();
  }
}

class RecordingApplicationPort {
  public failMergesWith: string | null = null;
  public readonly merges: Array<{
    readonly runId: string;
    readonly chatId: string;
    readonly sourceRunId: string;
  }> = [];

  public constructor(private readonly changes: InMemoryChangeSetStore) {}

  public apply(
    _changeSetId: string,
    _acceptedChangeIds: readonly string[],
    _scope: ChangeSetScope,
  ): Promise<ChangeSetApplyResult> {
    const changeSet = this.changes.getScoped(_changeSetId, _scope);
    const results = changeSet.changes.map((change) => ({
      ...change,
      status: "applied" as const,
    }));
    this.changes.setResults(changeSet.id, results);
    return Promise.resolve({
      changeSetId: changeSet.id,
      changes: results,
      undoAvailable: true,
    });
  }

  public mergeRollbacks(
    runId: string,
    chatId: string,
    sourceRunId: string,
  ): Promise<void> {
    this.merges.push({ runId, chatId, sourceRunId });
    if (this.failMergesWith)
      return Promise.reject(new Error(this.failMergesWith));
    return Promise.resolve();
  }
}

class RecordingTransitionPort {
  public readonly restoredChangeSetIds: string[] = [];

  public continueAfterApply(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public applyCompleted(): void {}

  public deleteContinuation(): void {}

  public discardCompleted(): void {}

  public reviewRestored(changeSet: ChangeSet): void {
    this.restoredChangeSetIds.push(changeSet.id);
  }
}

class RecordingResolutionTransitionPort implements ChangeSetResolutionTransitionPort {
  public readonly events: ChangeSetResolutionEvent[] = [];

  public publish(
    _input: ChangeSetScope,
    event: ChangeSetResolutionEvent,
  ): void {
    this.events.push(event);
  }

  public deleteContinuation(): void {}
}

class NoOpRollbackPort implements ChangeSetRollbackPort {
  public undo(): ReturnType<ChangeSetRollbackPort["undo"]> {
    return Promise.reject(new Error("Rollback not expected"));
  }
}
