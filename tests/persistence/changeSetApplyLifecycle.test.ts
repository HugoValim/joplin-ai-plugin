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

  test("keeps an applied Change Set recoverable when chat persistence fails", async () => {
    const files = new FailingMemoryJsonFilePort();
    const harness = await applyHarness("Persistence failure", files);
    const changeSet = addNoteUpdate(harness, "run-persistence");
    const activation = await harness.lifecycle.activateReview(changeSet, false);
    const handoff = new RecordingApplyHandoffPort(true);
    files.failWrites = true;

    await expect(
      harness.lifecycle.apply(
        applyInput(harness.chat.id, changeSet, activation.applyToken),
        new RecordingChangeSetApplicationPort(harness.changes),
        handoff,
      ),
    ).rejects.toThrow("Chat persistence unavailable");
    expect(harness.changes.get(changeSet.id)?.status).toBe("applied");
    expect(handoff.continuedChangeSetIds).toEqual([]);
    expect(handoff.completedChangeSetIds).toEqual([]);
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
): Promise<ApplyHarness> {
  const changes = new InMemoryChangeSetStore();
  const chats = new ChatStore("/plugin", files);
  const chat = await chats.create(title);
  return {
    changes,
    chats,
    chat,
    lifecycle: new ChangeSetLifecycle(
      changes,
      chats,
      new RecordingReviewNotePort(),
    ),
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
    this.changes?.setResults(changeSetId, results);
    return Promise.resolve({
      changeSetId,
      changes: results,
      undoAvailable: true,
    });
  }

  public mergeRollbacks(): Promise<void> {
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
}

class RecordingReviewNotePort implements ReviewNotePort {
  public openForChangeSet(): Promise<string> {
    return Promise.resolve("review-note-1");
  }

  public ensureOpen(): Promise<string> {
    return Promise.resolve("review-note-1");
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class FailingMemoryJsonFilePort extends MemoryJsonFilePort {
  public failWrites = false;

  public override writeTextAtomic(
    path: string,
    content: string,
  ): Promise<void> {
    if (this.failWrites)
      return Promise.reject(new Error("Chat persistence unavailable"));
    return super.writeTextAtomic(path, content);
  }
}
