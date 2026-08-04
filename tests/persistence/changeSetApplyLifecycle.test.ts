import {
  ChangeApplier,
  InMemoryRollbackStore,
  type RollbackRecord,
} from "../../src/agent/changeApplier";
import type {
  CreateNoteInput,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NotebookRecord,
  UpdateNoteBodyInput,
} from "../../src/notes/retriever";
import {
  InMemoryChangeSetStore,
  type ChangeSet,
  type ChangeSetScope,
  type NoteUpdateProposalInput,
  type ProposedChange,
} from "../../src/persistence/changeSetStore";
import {
  ChangeSetLifecycle,
  type ChangeSetApplyInput,
  type ChangeSetApplyResult,
  type ChangeSetDiscardInput,
} from "../../src/persistence/changeSetLifecycle";
import { ChatStore, type PersistedChat } from "../../src/persistence/chatStore";
import type { ReviewNotePort } from "../../src/plugin/reviewNoteService";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

describe("ChangeSetLifecycle apply and discard", () => {
  test("rejects apply before invoking the application port for an invalid token", async () => {
    const harness = await applyHarness("Secure apply");
    const changeSet = addNoteUpdate(harness, "run-secure");
    await harness.lifecycle.activateReview(changeSet, false);
    const application = new RecordingChangeSetApplicationPort();

    await expect(
      harness.lifecycle.apply(
        applyInput(harness.chat.id, changeSet, "0".repeat(64)),
        application,
        new RecordingApplyHandoffPort(),
      ),
    ).rejects.toThrow("Invalid apply token");
    expect(application.appliedChangeSetIds).toEqual([]);
  });

  test("applies a valid request, persists review state, and completes without continuation", async () => {
    const harness = await applyHarness("Apply");
    const changeSet = addNoteUpdate(harness, "run-apply");
    await saveAwaitingApproval(harness, changeSet.runId);
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const application = new RecordingChangeSetApplicationPort(harness.changes);
    const handoff = new RecordingApplyHandoffPort();

    await harness.lifecycle.apply(
      applyInput(harness.chat.id, changeSet, activation.applyToken),
      application,
      handoff,
    );

    const saved = await harness.chats.get(harness.chat.id);
    expect(saved?.pendingChangeSet?.status).toBe("applied");
    expect(saved?.runSummaries[0]?.status).toBe("applied");
    expect(handoff.completedChangeSetIds).toEqual([changeSet.id]);
  });

  test("hands an applied result to a pending continuation without duplicate completion", async () => {
    const harness = await applyHarness("Continue");
    const changeSet = addNoteUpdate(harness, "run-continue");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const handoff = new RecordingApplyHandoffPort(true);

    await harness.lifecycle.apply(
      applyInput(harness.chat.id, changeSet, activation.applyToken),
      new RecordingChangeSetApplicationPort(harness.changes),
      handoff,
    );

    expect(handoff.continuedChangeSetIds).toEqual([changeSet.id]);
    expect(handoff.completedChangeSetIds).toEqual([]);
  });

  test("discards a pending Change Set and clears persisted approval state", async () => {
    const harness = await applyHarness("Discard");
    const changeSet = addNoteUpdate(harness, "run-discard");
    await saveAwaitingApproval(harness, changeSet.runId);
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const handoff = new RecordingApplyHandoffPort();

    await harness.lifecycle.discard(
      discardInput(harness.chat.id, changeSet),
      handoff,
    );

    const saved = await harness.chats.get(harness.chat.id);
    expect(harness.changes.get(changeSet.id)?.status).toBe("discarded");
    expect(saved?.pendingChangeSet).toBeNull();
    expect(saved?.runSummaries[0]?.status).toBe("completed");
    expect(
      harness.lifecycle.verifyApplyToken(changeSet.id, activation.applyToken),
    ).toBe(false);
    expect(handoff.deletedChangeSetIds).toEqual([changeSet.id]);
    expect(handoff.discardedChangeSetIds).toEqual([changeSet.id]);
  });

  test("persists a partial apply for later review", async () => {
    const harness = await applyHarness("Partial");
    const changeSet = addTwoNoteUpdates(harness, "run-partial");
    const activation = await harness.lifecycle.activateReview(changeSet, false);

    await harness.lifecycle.apply(
      applyInput(harness.chat.id, changeSet, activation.applyToken),
      new RecordingChangeSetApplicationPort(harness.changes, true),
      new RecordingApplyHandoffPort(),
    );

    const pending = (await harness.chats.get(harness.chat.id))
      ?.pendingChangeSet;
    expect(pending?.status).toBe("partial");
    expect(pending?.changes.map((change) => change.status)).toEqual([
      "applied",
      "conflict",
    ]);
  });

  test("checkpoints applied state when rollback finalization is unavailable", async () => {
    const harness = await applyHarness("Rollback failure");
    const changeSet = addNoteUpdate(harness, "run-rollback-failure");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const application = new RecordingChangeSetApplicationPort(harness.changes);
    application.durabilityFailure = "Rollback storage unavailable";

    await expect(
      harness.lifecycle.apply(
        applyInput(harness.chat.id, changeSet, activation.applyToken),
        application,
        new RecordingApplyHandoffPort(),
      ),
    ).rejects.toThrow("application journal remains locked");

    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet?.status,
    ).toBe("applied");
    expect(() => harness.lifecycle.ensureApplyToken(changeSet.id)).toThrow(
      "not pending",
    );
  });

  test("keeps the application journal authoritative when chat storage also fails", async () => {
    const files = new FailingMemoryJsonFilePort();
    const harness = await applyHarness("Both stores unavailable", files);
    const changeSet = addNoteUpdate(harness, "run-both-unavailable");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const application = new RecordingChangeSetApplicationPort(harness.changes);
    application.durabilityFailure = "Rollback storage unavailable";
    files.failWrites = true;

    await expect(
      harness.lifecycle.apply(
        applyInput(harness.chat.id, changeSet, activation.applyToken),
        application,
        new RecordingApplyHandoffPort(),
      ),
    ).rejects.toThrow("application journal remains locked");

    expect(harness.changes.get(changeSet.id)?.status).toBe("applied");
    expect(() => harness.lifecycle.ensureApplyToken(changeSet.id)).toThrow(
      "not pending",
    );
    const stale = await harness.chats.get(harness.chat.id);
    if (!stale) throw new Error("Expected stale persisted proposal");
    const restartedChanges = new InMemoryChangeSetStore();
    const restarted = new ChangeSetLifecycle(
      restartedChanges,
      harness.chats,
      new RecordingReviewNotePort(),
    );
    const recovered = await restarted.recover(stale, application);
    expect(recovered?.status).toBe("applied");
    expect(application.rollbackMergeRepairs).toBe(1);
    expect(restarted.applyTokenIfPending(changeSet.id)).toBeNull();
    expect(application.duplicateApplications).toBe(0);
  });

  test("prevents duplicate note writes after both post-write saves fail", async () => {
    const files = new FailingMemoryJsonFilePort();
    const harness = await applyHarness("Real write-ahead recovery", files);
    const changeSet = addNoteUpdate(harness, "run-real-journal");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const notes = new DurableTestNoteRepository();
    const rollbacks = new RejectingSecondRollbackSave();
    const applier = new ChangeApplier(
      harness.changes,
      notes,
      { resolve: () => null },
      rollbacks,
    );
    files.failWrites = true;
    const input = applyInput(harness.chat.id, changeSet, activation.applyToken);

    await expect(
      harness.lifecycle.apply(input, applier, new RecordingApplyHandoffPort()),
    ).rejects.toThrow("application journal remains locked");

    const stale = await harness.chats.get(harness.chat.id);
    if (!stale)
      throw new Error("Expected stale proposal after chat save failure");
    const restartedChanges = new InMemoryChangeSetStore();
    const restartedApplier = new ChangeApplier(
      restartedChanges,
      notes,
      { resolve: () => null },
      rollbacks,
    );
    const restarted = new ChangeSetLifecycle(
      restartedChanges,
      harness.chats,
      new RecordingReviewNotePort(),
    );
    const recovered = await restarted.recover(stale, restartedApplier);
    expect(recovered?.status).toBe("applied");
    expect(restarted.applyTokenIfPending(changeSet.id)).toBeNull();
    await expect(
      restarted.apply(input, restartedApplier, new RecordingApplyHandoffPort()),
    ).rejects.toThrow("Invalid apply token");
    expect(notes.updateCount).toBe(1);
  });

  test("compensates writes and restores a retryable proposal when durable save fails", async () => {
    const files = new FailingMemoryJsonFilePort();
    const harness = await applyHarness("Persistence failure", files);
    const changeSet = addNoteUpdate(harness, "run-persistence");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const handoff = new RecordingApplyHandoffPort(true);
    const application = new RecordingChangeSetApplicationPort(harness.changes);
    files.failWrites = true;

    await expect(
      harness.lifecycle.apply(
        applyInput(harness.chat.id, changeSet, activation.applyToken),
        application,
        handoff,
      ),
    ).rejects.toThrow("completed writes were compensated");
    expect(harness.changes.get(changeSet.id)?.status).toBe("proposed");
    expect(application.compensatedChangeIds).toEqual([
      changeSet.changes[0]?.id,
    ]);
    expect(application.duplicateApplications).toBe(0);
    expect([...application.activeChangeIds]).toEqual([]);
    expect(
      harness.lifecycle.verifyApplyToken(changeSet.id, activation.applyToken),
    ).toBe(false);
    expect(handoff.continuedChangeSetIds).toEqual([]);
    expect(handoff.completedChangeSetIds).toEqual([]);

    const recoveredChanges = new InMemoryChangeSetStore();
    const recovered = new ChangeSetLifecycle(
      recoveredChanges,
      harness.chats,
      new RecordingReviewNotePort(),
    );
    files.failWrites = false;
    const persisted = await harness.chats.get(harness.chat.id);
    if (!persisted) throw new Error("Expected persisted proposal");
    await recovered.recover(persisted, application);
    expect(recoveredChanges.get(changeSet.id)?.status).toBe("proposed");

    const retryToken = harness.lifecycle.ensureApplyToken(changeSet.id);
    await harness.lifecycle.apply(
      applyInput(harness.chat.id, changeSet, retryToken),
      application,
      new RecordingApplyHandoffPort(),
    );
    expect(application.appliedChangeSetIds).toEqual([
      changeSet.id,
      changeSet.id,
    ]);
    expect(application.compensatedChangeIds).toEqual([
      changeSet.changes[0]?.id,
    ]);
    expect(application.duplicateApplications).toBe(0);
    expect([...application.activeChangeIds]).toEqual([
      changeSet.changes[0]?.id,
    ]);
  });

  test("conservatively locks stale journal IDs after successful compensation", async () => {
    const files = new FailingMemoryJsonFilePort();
    const harness = await applyHarness("Stale compensation journal", files);
    const changeSet = addNoteUpdate(harness, "run-stale-journal");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const application = new RecordingChangeSetApplicationPort(harness.changes);
    application.retainCompensatedIds = true;
    files.failWrites = true;

    await expect(
      harness.lifecycle.apply(
        applyInput(harness.chat.id, changeSet, activation.applyToken),
        application,
        new RecordingApplyHandoffPort(),
      ),
    ).rejects.toThrow("completed writes were compensated");

    const stale = await harness.chats.get(harness.chat.id);
    if (!stale) throw new Error("Expected persisted proposal");
    const restartedChanges = new InMemoryChangeSetStore();
    const restarted = new ChangeSetLifecycle(
      restartedChanges,
      harness.chats,
      new RecordingReviewNotePort(),
    );
    const recovered = await restarted.recover(stale, application);
    expect(recovered?.status).toBe("applied");
    expect(recovered?.changes[0]?.status).toBe("applied");
    expect(restarted.applyTokenIfPending(changeSet.id)).toBeNull();
  });

  test("keeps applied state non-reapplicable when Review Note replacement fails", async () => {
    const reviewNotes = new RecordingReviewNotePort();
    const harness = await applyHarness(
      "Review Note failure",
      new MemoryJsonFilePort(),
      reviewNotes,
    );
    const changeSet = addNoteUpdate(harness, "run-review-failure");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const application = new RecordingChangeSetApplicationPort(harness.changes);
    reviewNotes.failOpens = true;

    await expect(
      harness.lifecycle.apply(
        applyInput(harness.chat.id, changeSet, activation.applyToken),
        application,
        new RecordingApplyHandoffPort(),
      ),
    ).rejects.toThrow("Review Note unavailable");

    expect(harness.changes.get(changeSet.id)?.status).toBe("applied");
    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet?.status,
    ).toBe("applied");
    expect(application.compensatedChangeIds).toEqual([]);
    expect(
      harness.lifecycle.verifyApplyToken(changeSet.id, activation.applyToken),
    ).toBe(false);
  });

  test("recovers non-reapplicable state when compensation and chat saves fail", async () => {
    const files = new FailingMemoryJsonFilePort();
    const harness = await applyHarness("Compensation conflict", files);
    const changeSet = addNoteUpdate(harness, "run-compensation-conflict");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const application = new RecordingChangeSetApplicationPort(harness.changes);
    application.compensationConflicts.push("note changed after apply");
    files.failWrites = true;
    const input = applyInput(harness.chat.id, changeSet, activation.applyToken);

    await expect(
      harness.lifecycle.apply(
        input,
        application,
        new RecordingApplyHandoffPort(),
      ),
    ).rejects.toThrow("compensation conflicted");

    expect(harness.changes.get(changeSet.id)?.status).toBe("applied");
    const persisted = await harness.chats.get(harness.chat.id);
    expect(persisted?.pendingChangeSet?.status).toBe("proposed");
    expect(
      harness.lifecycle.verifyApplyToken(changeSet.id, activation.applyToken),
    ).toBe(false);
    await expect(
      harness.lifecycle.apply(
        input,
        application,
        new RecordingApplyHandoffPort(),
      ),
    ).rejects.toThrow("Invalid apply token");
    expect(application.appliedChangeSetIds).toHaveLength(1);

    const recoveredChanges = new InMemoryChangeSetStore();
    const recovered = new ChangeSetLifecycle(
      recoveredChanges,
      harness.chats,
      new RecordingReviewNotePort(),
    );
    if (!persisted) throw new Error("Expected persisted proposal");
    await recovered.recover(persisted, application);
    expect(recoveredChanges.get(changeSet.id)?.status).toBe("applied");
    expect(() => recovered.ensureApplyToken(changeSet.id)).toThrow(
      "not pending",
    );
    expect(recovered.applyTokenIfPending(changeSet.id)).toBeNull();
  });
});

interface ApplyHarness {
  readonly changes: InMemoryChangeSetStore;
  readonly chats: ChatStore;
  readonly chat: PersistedChat;
  readonly lifecycle: ChangeSetLifecycle;
}

async function applyHarness(
  title: string,
  files: MemoryJsonFilePort = new MemoryJsonFilePort(),
  reviewNotes: RecordingReviewNotePort = new RecordingReviewNotePort(),
): Promise<ApplyHarness> {
  const changes = new InMemoryChangeSetStore();
  const chats = new ChatStore("/plugin", files);
  const chat = await chats.create(title);
  return {
    changes,
    chats,
    chat,
    lifecycle: new ChangeSetLifecycle(changes, chats, reviewNotes),
  };
}

function addNoteUpdate(harness: ApplyHarness, runId: string): ChangeSet {
  harness.changes.add(harness.chat.id, runId, noteUpdate("note-1"));
  return requiredChangeSet(harness.changes, runId);
}

function addTwoNoteUpdates(harness: ApplyHarness, runId: string): ChangeSet {
  harness.changes.add(harness.chat.id, runId, noteUpdate("note-1"));
  harness.changes.add(harness.chat.id, runId, noteUpdate("note-2"));
  return requiredChangeSet(harness.changes, runId);
}

function noteUpdate(noteId: string): NoteUpdateProposalInput {
  return {
    kind: "note" as const,
    operation: "update" as const,
    noteId,
    targetLabel: noteId,
    before: "Old",
    after: "New",
    expectedUpdatedTime: 1,
  };
}

function requiredChangeSet(
  changes: InMemoryChangeSetStore,
  runId: string,
): ChangeSet {
  const changeSet = changes.getByRun(runId);
  if (changeSet) return changeSet;
  throw new Error(`Change Set for ${runId} missing; expected proposal`);
}

async function saveAwaitingApproval(
  harness: ApplyHarness,
  runId: string,
): Promise<void> {
  await harness.chats.save({
    ...harness.chat,
    runSummaries: [
      {
        runId,
        status: "awaiting-approval",
        summary: "Changes proposed",
        completedAt: 1,
      },
    ],
  });
}

function applyInput(
  chatId: string,
  changeSet: ChangeSet,
  applyToken: string,
): ChangeSetApplyInput {
  return {
    chatId,
    runId: changeSet.runId,
    changeSetId: changeSet.id,
    acceptedChangeIds: changeSet.changes.map((change) => change.id),
    applyToken,
    automatic: false,
  };
}

function discardInput(
  chatId: string,
  changeSet: ChangeSet,
): ChangeSetDiscardInput {
  return { chatId, runId: changeSet.runId, changeSetId: changeSet.id };
}

class RecordingChangeSetApplicationPort {
  public readonly appliedChangeSetIds: string[] = [];
  public readonly compensatedChangeIds: string[] = [];
  public readonly compensationConflicts: string[] = [];
  public readonly activeChangeIds = new Set<string>();
  public duplicateApplications = 0;
  public durabilityFailure: string | null = null;
  public retainCompensatedIds = false;
  public rollbackMergeRepairs = 0;

  public constructor(
    private readonly changes?: InMemoryChangeSetStore,
    private readonly partial = false,
  ) {}

  public apply(
    changeSetId: string,
    _acceptedChangeIds: readonly string[],
    _scope: ChangeSetScope,
  ): Promise<ChangeSetApplyResult> {
    this.appliedChangeSetIds.push(changeSetId);
    const changeSet = this.changes?.get(changeSetId);
    if (!changeSet)
      return Promise.reject(new Error("Application should not run"));
    const results = changeSet.changes.map((change, index) =>
      applyResult(change, this.partial && index === 1),
    );
    for (const result of results) {
      if (result.status !== "applied") continue;
      if (this.activeChangeIds.has(result.id)) this.duplicateApplications += 1;
      this.activeChangeIds.add(result.id);
    }
    this.changes?.setResults(changeSetId, results);
    return Promise.resolve({
      changeSetId,
      changes: results,
      undoAvailable: true,
      ...(this.durabilityFailure
        ? { durabilityFailure: this.durabilityFailure }
        : {}),
    });
  }

  public mergeRollbacks(): Promise<{
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }> {
    return Promise.resolve({
      commit: (): Promise<void> => Promise.resolve(),
      rollback: (): Promise<void> => Promise.resolve(),
    });
  }

  public compensate(
    _runId: string,
    _chatId: string,
    changeIds: readonly string[],
  ): Promise<{
    readonly restored: number;
    readonly conflicts: readonly string[];
  }> {
    this.compensatedChangeIds.push(...changeIds);
    if (this.compensationConflicts.length === 0 && !this.retainCompensatedIds) {
      for (const changeId of changeIds) this.activeChangeIds.delete(changeId);
    }
    return Promise.resolve({
      restored: changeIds.length - this.compensationConflicts.length,
      conflicts: this.compensationConflicts,
    });
  }

  public retainedAppliedChangeIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.activeChangeIds]);
  }

  public resolvePendingRollbackMerge(): Promise<void> {
    this.rollbackMergeRepairs += 1;
    return Promise.resolve();
  }
}

function applyResult(
  change: ProposedChange,
  conflict: boolean,
): ProposedChange {
  return {
    ...change,
    status: conflict ? "conflict" : "applied",
    ...(conflict ? { message: "Concurrent change" } : {}),
  };
}

class RecordingApplyHandoffPort {
  public readonly completedChangeSetIds: string[] = [];
  public readonly continuedChangeSetIds: string[] = [];
  public readonly deletedChangeSetIds: string[] = [];
  public readonly discardedChangeSetIds: string[] = [];

  public constructor(private readonly hasContinuation = false) {}

  public continueAfterApply(
    _input: ChangeSetApplyInput,
    result: ChangeSetApplyResult,
  ): Promise<boolean> {
    this.continuedChangeSetIds.push(result.changeSetId);
    return Promise.resolve(this.hasContinuation);
  }

  public applyCompleted(
    _input: ChangeSetApplyInput,
    result: ChangeSetApplyResult,
  ): void {
    this.completedChangeSetIds.push(result.changeSetId);
  }

  public deleteContinuation(changeSetId: string): void {
    this.deletedChangeSetIds.push(changeSetId);
  }

  public discardCompleted(input: ChangeSetDiscardInput): void {
    this.discardedChangeSetIds.push(input.changeSetId);
  }

  public reviewRestored(): void {}
}

class RecordingReviewNotePort implements ReviewNotePort {
  public failOpens = false;

  public openForChangeSet(): Promise<string> {
    if (this.failOpens)
      return Promise.reject(new Error("Review Note unavailable"));
    return Promise.resolve("review-note-1");
  }

  public ensureOpen(): Promise<string> {
    return Promise.resolve("review-note-1");
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class RejectingSecondRollbackSave extends InMemoryRollbackStore {
  private saveCount = 0;

  public override save(record: RollbackRecord): Promise<void> {
    this.saveCount += 1;
    if (this.saveCount === 2) {
      return Promise.reject(new Error("Rollback finalization unavailable"));
    }
    return super.save(record);
  }
}

class DurableTestNoteRepository implements NoteRepository {
  public updateCount = 0;
  private note: NoteRecord = {
    id: "note-1",
    parentId: "folder-1",
    title: "Guide",
    body: "Old",
    updatedTime: 1,
  };

  public searchNotes(): Promise<readonly NoteSearchHit[]> {
    return Promise.resolve([]);
  }

  public readNote(): Promise<NoteRecord> {
    return Promise.resolve(this.note);
  }

  public listNotebooks(): Promise<readonly NotebookRecord[]> {
    return Promise.resolve([]);
  }

  public createNote(_input: CreateNoteInput): Promise<NoteRecord> {
    return Promise.reject(new Error("Note creation not expected"));
  }

  public updateNoteBody(input: UpdateNoteBodyInput): Promise<NoteRecord> {
    this.updateCount += 1;
    this.note = { ...this.note, body: input.body, updatedTime: 2 };
    return Promise.resolve(this.note);
  }
}

class FailingMemoryJsonFilePort extends MemoryJsonFilePort {
  public failWrites = false;
  public failuresRemaining = 0;

  public override writeTextAtomic(
    path: string,
    content: string,
  ): Promise<void> {
    if (this.failWrites || this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error("Chat persistence unavailable"));
    }
    return super.writeTextAtomic(path, content);
  }
}
