import {
  InMemoryChangeSetStore,
  type ChangeSet,
  type ChangeSetScope,
} from "../../src/persistence/changeSetStore";
import {
  ChangeSetLifecycle,
  type ChangeSetResolutionEvent,
  type ChangeSetResolutionTransitionPort,
  type ChangeSetRollbackPort,
} from "../../src/persistence/changeSetLifecycle";
import { ChatStore, type PersistedChat } from "../../src/persistence/chatStore";
import type { ReviewNotePort } from "../../src/plugin/reviewNoteService";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

describe("ChangeSetLifecycle applied resolution", () => {
  test("keeps the last reviewed item and disposes its Review Note", async () => {
    const harness = await resolutionHarness();
    const applied = await addAppliedReview(harness, "run-keep", 1);

    await harness.lifecycle.keep(
      {
        chatId: harness.chat.id,
        runId: applied.runId,
        changeSetId: applied.id,
        changeIds: [applied.changes[0]?.id ?? "missing"],
      },
      harness.transitions,
    );

    expect(harness.changes.get(applied.id)).toBeNull();
    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet,
    ).toBeNull();
    expect(harness.reviewNotes.disposed).toEqual(["review-note-1"]);
    expect(harness.transitions.events).toEqual([
      { mode: "completed", summary: "Kept applied changes" },
    ]);
  });

  test("keeps one reviewed item and publishes the remaining review", async () => {
    const harness = await resolutionHarness();
    const applied = await addAppliedReview(harness, "run-partial-keep", 2);

    await harness.lifecycle.keep(
      resolutionSelection(harness, applied, [
        applied.changes[0]?.id ?? "missing",
      ]),
      harness.transitions,
    );

    const remaining = (await harness.chats.get(harness.chat.id))
      ?.pendingChangeSet;
    expect(remaining?.changes.map((change) => change.targetLabel)).toEqual([
      "Note 1",
    ]);
    expect(harness.reviewNotes.disposed).toEqual([]);
    expect(harness.transitions.events[0]).toMatchObject({
      mode: "review",
      changeSet: { id: applied.id, changes: [{ targetLabel: "Note 1" }] },
    });
  });

  test("denies an applied review through rollback and terminal cleanup", async () => {
    const harness = await resolutionHarness();
    const applied = await addAppliedReview(harness, "run-deny", 1);
    const rollback = new RecordingRollbackPort({
      runId: applied.runId,
      restored: 1,
      conflicts: [],
    });

    await harness.lifecycle.deny(
      {
        chatId: harness.chat.id,
        runId: applied.runId,
        changeSetId: applied.id,
      },
      rollback,
      harness.transitions,
    );

    expect(rollback.calls).toEqual([
      { runId: applied.runId, chatId: harness.chat.id, changeIds: undefined },
    ]);
    expect(
      (await harness.chats.get(harness.chat.id))?.runSummaries[0]?.status,
    ).toBe("denied");
    expect(harness.reviewNotes.disposed).toEqual(["review-note-1"]);
    expect(harness.transitions.events).toEqual([
      { mode: "completed", summary: "Denied and restored 1; conflicts 0" },
    ]);
  });

  test("denies a proposed review without invoking rollback", async () => {
    const harness = await resolutionHarness();
    const proposed = await addProposedReview(harness, "run-proposed-deny");
    const rollback = new RecordingRollbackPort({
      runId: proposed.runId,
      restored: 0,
      conflicts: [],
    });

    await harness.lifecycle.deny(
      {
        chatId: harness.chat.id,
        runId: proposed.runId,
        changeSetId: proposed.id,
      },
      rollback,
      harness.transitions,
    );

    expect(rollback.calls).toEqual([]);
    expect(harness.transitions.deletedChangeSetIds).toEqual([proposed.id]);
    expect(harness.transitions.events).toEqual([
      { mode: "completed", summary: "Changes denied before apply" },
    ]);
  });

  test("undoes one selected item and retains the remaining review", async () => {
    const harness = await resolutionHarness();
    const applied = await addAppliedReview(harness, "run-partial-undo", 2);
    const selectedId = applied.changes[0]?.id ?? "missing";
    const rollback = new RecordingRollbackPort({
      runId: applied.runId,
      restored: 1,
      conflicts: [],
    });

    await harness.lifecycle.undoSelected(
      resolutionSelection(harness, applied, [selectedId]),
      rollback,
      harness.transitions,
    );

    expect(rollback.calls[0]?.changeIds).toEqual([selectedId]);
    expect(harness.transitions.events[0]).toMatchObject({
      mode: "review",
      summary: "Undid 1; conflicts 0",
      undoRunId: applied.runId,
      changeSet: { changes: [{ targetLabel: "Note 1" }] },
    });
    expect(harness.reviewNotes.disposed).toEqual([]);
  });

  test("undoes the last selected item and disposes terminal review state", async () => {
    const harness = await resolutionHarness();
    const applied = await addAppliedReview(harness, "run-terminal-undo", 1);
    const rollback = new RecordingRollbackPort({
      runId: applied.runId,
      restored: 1,
      conflicts: [],
    });

    await harness.lifecycle.undoSelected(
      resolutionSelection(harness, applied, [
        applied.changes[0]?.id ?? "missing",
      ]),
      rollback,
      harness.transitions,
    );

    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet,
    ).toBeNull();
    expect(harness.reviewNotes.disposed).toEqual(["review-note-1"]);
    expect(harness.transitions.events).toEqual([
      { mode: "completed", summary: "Undid 1; conflicts 0" },
    ]);
  });

  test("publishes a full rollback summary through the lifecycle", async () => {
    const harness = await resolutionHarness();
    const rollback = new RecordingRollbackPort({
      runId: "run-target",
      restored: 2,
      conflicts: ["note changed"],
    });

    await harness.lifecycle.rollback(
      {
        chatId: harness.chat.id,
        runId: "run-request",
        targetRunId: "run-target",
      },
      rollback,
      harness.transitions,
    );

    expect(rollback.calls).toEqual([
      {
        runId: "run-target",
        chatId: harness.chat.id,
        changeIds: undefined,
      },
    ]);
    expect(harness.transitions.events).toEqual([
      { mode: "completed", summary: "Restored 2; conflicts 1" },
    ]);
  });

  test("preserves review state when rollback fails", async () => {
    const harness = await resolutionHarness();
    const applied = await addAppliedReview(harness, "run-failed-undo", 1);
    const rollback = new FailingRollbackPort("undo conflict");

    await expect(
      harness.lifecycle.undoSelected(
        resolutionSelection(harness, applied, [
          applied.changes[0]?.id ?? "missing",
        ]),
        rollback,
        harness.transitions,
      ),
    ).rejects.toThrow("undo conflict");

    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet,
    ).toEqual(applied);
    expect(harness.changes.get(applied.id)).toEqual(applied);
    expect(harness.reviewNotes.disposed).toEqual([]);
    expect(harness.transitions.events).toEqual([]);
  });

  test("rejects stale resolution scope without changing review state", async () => {
    const harness = await resolutionHarness();
    const applied = await addAppliedReview(harness, "run-current", 1);

    await expect(
      harness.lifecycle.keep(
        {
          ...resolutionSelection(harness, applied, [
            applied.changes[0]?.id ?? "missing",
          ]),
          runId: "run-stale",
        },
        harness.transitions,
      ),
    ).rejects.toThrow("expected chat");

    expect(harness.changes.get(applied.id)).toEqual(applied);
    expect(
      (await harness.chats.get(harness.chat.id))?.pendingChangeSet,
    ).toEqual(applied);
    expect(harness.reviewNotes.disposed).toEqual([]);
  });
});

interface ResolutionHarness {
  readonly changes: InMemoryChangeSetStore;
  readonly chats: ChatStore;
  readonly chat: PersistedChat;
  readonly lifecycle: ChangeSetLifecycle;
  readonly reviewNotes: RecordingReviewNotePort;
  readonly transitions: RecordingResolutionTransition;
}

async function resolutionHarness(): Promise<ResolutionHarness> {
  const changes = new InMemoryChangeSetStore();
  const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
  const chat = await chats.create("Resolution");
  const reviewNotes = new RecordingReviewNotePort();
  return {
    changes,
    chats,
    chat,
    lifecycle: new ChangeSetLifecycle(changes, chats, reviewNotes),
    reviewNotes,
    transitions: new RecordingResolutionTransition(),
  };
}

async function addAppliedReview(
  harness: ResolutionHarness,
  runId: string,
  count: number,
): Promise<ChangeSet> {
  for (let index = 0; index < count; index += 1) {
    harness.changes.add(harness.chat.id, runId, {
      kind: "note",
      operation: "update",
      noteId: `note-${index}`,
      targetLabel: `Note ${index}`,
      before: "Old",
      after: "New",
      expectedUpdatedTime: index + 1,
    });
  }
  const proposed = harness.changes.getByRun(runId);
  if (!proposed)
    throw new Error(`Change Set ${runId} missing; expected proposal`);
  const applied = harness.changes.setResults(
    proposed.id,
    proposed.changes.map((change) => ({ ...change, status: "applied" })),
  );
  const reviewed = harness.changes.attachReviewNote(
    applied.id,
    "review-note-1",
  );
  await harness.chats.save({
    ...harness.chat,
    pendingChangeSet: reviewed,
    runSummaries: [
      {
        runId,
        status: "applied",
        summary: "Applied",
        completedAt: 1,
      },
    ],
  });
  return reviewed;
}

async function addProposedReview(
  harness: ResolutionHarness,
  runId: string,
): Promise<ChangeSet> {
  harness.changes.add(harness.chat.id, runId, {
    kind: "note",
    operation: "update",
    noteId: "note-proposed",
    targetLabel: "Proposed note",
    before: "Old",
    after: "New",
    expectedUpdatedTime: 1,
  });
  const proposed = harness.changes.getByRun(runId);
  if (!proposed)
    throw new Error(`Change Set ${runId} missing; expected proposal`);
  const reviewed = harness.changes.attachReviewNote(
    proposed.id,
    "review-note-1",
  );
  await harness.chats.save({
    ...harness.chat,
    pendingChangeSet: reviewed,
    runSummaries: [
      {
        runId,
        status: "awaiting-approval",
        summary: "Awaiting approval",
        completedAt: 1,
      },
    ],
  });
  return reviewed;
}

function resolutionSelection(
  harness: ResolutionHarness,
  changeSet: ChangeSet,
  changeIds: readonly string[],
): {
  readonly chatId: string;
  readonly runId: string;
  readonly changeSetId: string;
  readonly changeIds: readonly string[];
} {
  return {
    chatId: harness.chat.id,
    runId: changeSet.runId,
    changeSetId: changeSet.id,
    changeIds,
  };
}

class RecordingReviewNotePort implements ReviewNotePort {
  public readonly disposed: string[] = [];

  public openForChangeSet(): Promise<string> {
    return Promise.resolve("review-note-1");
  }

  public ensureOpen(): Promise<string> {
    return Promise.resolve("review-note-1");
  }

  public dispose(noteId: string): Promise<void> {
    this.disposed.push(noteId);
    return Promise.resolve();
  }
}

class RecordingResolutionTransition implements ChangeSetResolutionTransitionPort {
  public readonly events: ChangeSetResolutionEvent[] = [];
  public readonly deletedChangeSetIds: string[] = [];

  public publish(
    _input: ChangeSetScope,
    event: ChangeSetResolutionEvent,
  ): void {
    this.events.push(event);
  }

  public deleteContinuation(changeSetId: string): void {
    this.deletedChangeSetIds.push(changeSetId);
  }
}

class RecordingRollbackPort implements ChangeSetRollbackPort {
  public readonly calls: Array<{
    readonly runId: string;
    readonly chatId: string;
    readonly changeIds: readonly string[] | undefined;
  }> = [];

  public constructor(
    private readonly result: {
      readonly runId: string;
      readonly restored: number;
      readonly conflicts: readonly string[];
    },
  ) {}

  public undo(
    runId: string,
    chatId: string,
    changeIds?: readonly string[],
  ): Promise<{
    readonly runId: string;
    readonly restored: number;
    readonly conflicts: readonly string[];
  }> {
    this.calls.push({ runId, chatId, changeIds });
    return Promise.resolve(this.result);
  }
}

class FailingRollbackPort implements ChangeSetRollbackPort {
  public constructor(private readonly message: string) {}

  public undo(): Promise<never> {
    return Promise.reject(new Error(this.message));
  }
}
