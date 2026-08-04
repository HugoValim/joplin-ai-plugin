import { DomainError, safeValue } from "../shared/errors";
import type { ChangeSet, ChangeSetStore } from "./changeSetStore";
import type { ChatStore, PersistedChat } from "./chatStore";

export interface ChangeSetRollbackMergeReceipt {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ChangeSetRollbackMergePort {
  mergeRollbacks(
    runId: string,
    chatId: string,
    sourceRunId: string,
  ): Promise<ChangeSetRollbackMergeReceipt>;
}

export interface ChangeSetParkingReviewNotePort {
  openForChangeSet(changeSet: ChangeSet, chatTitle: string): Promise<string>;
  dispose(noteId: string): Promise<void>;
}

export class ChangeSetParking {
  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly chats: ChatStore,
    private readonly reviewNotes: ChangeSetParkingReviewNotePort,
    private readonly revokeApproval: (changeSetId: string) => void,
  ) {}

  /**
   * Parks the current applied review while another Change Set is presented.
   *
   * @example await parking.parkAppliedReview(chatId, application)
   */
  public async parkAppliedReview(
    chatId: string,
    application: ChangeSetRollbackMergePort,
  ): Promise<void> {
    const chat = await this.requireChat(chatId);
    const pending = chat.pendingChangeSet;
    if (!pending || !isAppliedReview(pending)) return;
    const existing = chat.parkedAppliedChangeSet;
    if (existing) {
      await this.mergeParkedReview(chat, pending, existing, application);
      return;
    }
    await this.saveParked(chat, stripReviewNote(pending));
    await this.disposeReviewNote(pending.reviewNoteId);
  }

  /**
   * Merges an older parked review into a newer applied review.
   *
   * @example await parking.mergeAppliedReviews(chatId, applied, parked, application)
   */
  public async mergeAppliedReviews(
    chatId: string,
    applied: ChangeSet,
    parked: ChangeSet,
    application: ChangeSetRollbackMergePort,
  ): Promise<ChangeSet> {
    const merge = this.requireMergeable(chatId, applied, parked);
    const receipt = await application.mergeRollbacks(
      merge.applied.runId,
      chatId,
      merge.parked.runId,
    );
    await receipt.commit();
    return this.changes.absorbAppliedChanges(
      merge.applied.id,
      merge.parked.changes,
      {
        chatId,
        runId: merge.applied.runId,
      },
    );
  }

  /**
   * Disposes presentation and runtime state before a chat is cleared or deleted.
   *
   * @example await parking.abandon(chatId)
   */
  public async abandon(chatId: string): Promise<void> {
    const chat = await this.chats.get(chatId);
    if (!chat) return;
    const abandoned = uniqueChangeSets(
      chat.pendingChangeSet,
      chat.parkedAppliedChangeSet,
    );
    this.abandonRuntimeState(abandoned);
    await this.disposeReviewNotes(abandoned);
  }

  private abandonRuntimeState(changeSets: readonly ChangeSet[]): void {
    for (const changeSet of changeSets) {
      this.revokeApproval(changeSet.id);
      this.changes.drop(changeSet.id);
    }
  }

  /**
   * Resolves the current review and restores an older parked applied review.
   *
   * @example await parking.resolveCurrent(chatId, runId, "completed")
   */
  public async resolveCurrent(
    chatId: string,
    runId: string,
    status: PersistedChat["runSummaries"][number]["status"],
  ): Promise<ChangeSet | null> {
    const chat = await this.requireChat(chatId);
    const restored = await this.restoreParkedReview(chat);
    await this.disposeReplacedReview(chat, restored);
    await this.saveResolved(chat, runId, status, restored);
    return restored;
  }

  /**
   * Persists an applied review, absorbing any parked cumulative review.
   *
   * @example await parking.retainAppliedReview(chatId, runId, changeSetId, application)
   */
  public async retainAppliedReview(
    chatId: string,
    runId: string,
    changeSetId: string,
    application: ChangeSetRollbackMergePort,
  ): Promise<boolean> {
    const applied = this.changes.get(changeSetId);
    if (!applied) return false;
    const chat = await this.requireChat(chatId);
    const retained = await this.absorbParked(chat, applied, application);
    const reviewed = await this.attachAppliedReview(retained, chat.title);
    await this.saveAppliedReview(chat, runId, reviewed);
    await this.disposeReplacedReviewNote(applied, reviewed);
    this.dropAbsorbedParked(chat, reviewed);
    return true;
  }

  private async mergeParkedReview(
    chat: PersistedChat,
    pending: ChangeSet,
    existing: ChangeSet,
    application: ChangeSetRollbackMergePort,
  ): Promise<void> {
    const merged = await this.mergeAppliedReviews(
      chat.id,
      pending,
      existing,
      application,
    );
    await this.saveParked(chat, stripReviewNote(merged));
    if (existing.id !== merged.id) this.changes.drop(existing.id);
    await this.disposeReviewNotes([pending, existing]);
  }

  private async absorbParked(
    chat: PersistedChat,
    applied: ChangeSet,
    application: ChangeSetRollbackMergePort,
  ): Promise<ChangeSet> {
    const parked = chat.parkedAppliedChangeSet;
    if (!parked) return applied;
    return this.mergeAppliedReviews(chat.id, applied, parked, application);
  }

  private async attachAppliedReview(
    changeSet: ChangeSet,
    chatTitle: string,
  ): Promise<ChangeSet> {
    const noteId = await this.reviewNotes.openForChangeSet(
      changeSet,
      chatTitle,
    );
    return this.changes.attachReviewNote(changeSet.id, noteId);
  }

  private async disposeReplacedReviewNote(
    previous: ChangeSet,
    reviewed: ChangeSet,
  ): Promise<void> {
    if (previous.reviewNoteId === reviewed.reviewNoteId) return;
    await this.disposeReviewNote(previous.reviewNoteId);
  }

  private dropAbsorbedParked(chat: PersistedChat, reviewed: ChangeSet): void {
    const parkedId = chat.parkedAppliedChangeSet?.id;
    if (parkedId && parkedId !== reviewed.id) this.changes.drop(parkedId);
  }

  private requireMergeable(
    chatId: string,
    applied: ChangeSet,
    parked: ChangeSet,
  ): { readonly applied: ChangeSet; readonly parked: ChangeSet } {
    const current = this.changes.getScoped(applied.id, {
      chatId,
      runId: applied.runId,
    });
    const source = this.changes.getScoped(parked.id, {
      chatId,
      runId: parked.runId,
    });
    assertAppliedReview(current);
    assertAppliedReview(source);
    const unabsorbed = withoutAbsorbedChanges(source, current);
    assertMergeCapacity(current, unabsorbed);
    return { applied: current, parked: unabsorbed };
  }

  private async saveParked(
    chat: PersistedChat,
    parked: ChangeSet,
  ): Promise<void> {
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      pendingChangeSet: null,
      parkedAppliedChangeSet: parked,
    });
  }

  private async restoreParkedReview(
    chat: PersistedChat,
  ): Promise<ChangeSet | null> {
    const parked = chat.parkedAppliedChangeSet;
    if (!parked) return null;
    const noteId = await this.reviewNotes.openForChangeSet(parked, chat.title);
    return this.changes.attachReviewNote(parked.id, noteId);
  }

  private async disposeReplacedReview(
    chat: PersistedChat,
    restored: ChangeSet | null,
  ): Promise<void> {
    const pendingNoteId = chat.pendingChangeSet?.reviewNoteId;
    if (pendingNoteId === restored?.reviewNoteId) return;
    await this.disposeReviewNote(pendingNoteId);
  }

  private async saveResolved(
    chat: PersistedChat,
    runId: string,
    status: PersistedChat["runSummaries"][number]["status"],
    restored: ChangeSet | null,
  ): Promise<void> {
    const runSummaries = chat.runSummaries.map((summary) =>
      summary.runId === runId ? { ...summary, status } : summary,
    );
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      runSummaries,
      pendingChangeSet: restored,
      parkedAppliedChangeSet: null,
    });
  }

  private async saveAppliedReview(
    chat: PersistedChat,
    runId: string,
    reviewed: ChangeSet,
  ): Promise<void> {
    const runSummaries = chat.runSummaries.map((summary) =>
      summary.runId === runId
        ? { ...summary, status: "applied" as const }
        : summary,
    );
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      runSummaries,
      pendingChangeSet: reviewed,
      parkedAppliedChangeSet: null,
    });
  }

  private async disposeReviewNote(noteId: string | undefined): Promise<void> {
    if (!noteId) return;
    await this.reviewNotes.dispose(noteId);
  }

  private async disposeReviewNotes(
    changeSets: readonly ChangeSet[],
  ): Promise<void> {
    const noteIds = new Set(
      changeSets.flatMap((changeSet) =>
        changeSet.reviewNoteId ? [changeSet.reviewNoteId] : [],
      ),
    );
    for (const noteId of noteIds) await this.reviewNotes.dispose(noteId);
  }

  private async requireChat(chatId: string): Promise<PersistedChat> {
    const chat = await this.chats.get(chatId);
    if (chat) return chat;
    throw new DomainError(
      "NOT_AVAILABLE",
      `Chat ${safeValue(chatId)} not found; expected a persisted chat`,
    );
  }
}

function isAppliedReview(changeSet: ChangeSet): boolean {
  return changeSet.status === "applied" || changeSet.status === "partial";
}

function assertAppliedReview(changeSet: ChangeSet): void {
  if (isAppliedReview(changeSet)) return;
  throw new DomainError(
    "NOT_AVAILABLE",
    `Change set ${safeValue(changeSet.id)} has status ${changeSet.status}; expected applied or partial status`,
  );
}

function assertMergeCapacity(applied: ChangeSet, parked: ChangeSet): void {
  const total = applied.changes.length + parked.changes.length;
  if (total <= 100) return;
  throw new DomainError(
    "VALIDATION",
    `Merged change set would have ${total} changes; expected at most 100`,
  );
}

function withoutAbsorbedChanges(
  parked: ChangeSet,
  applied: ChangeSet,
): ChangeSet {
  const absorbedIds = new Set(applied.changes.map((change) => change.id));
  return {
    ...parked,
    changes: parked.changes.filter((change) => !absorbedIds.has(change.id)),
  };
}

function stripReviewNote(changeSet: ChangeSet): ChangeSet {
  if (!changeSet.reviewNoteId) return changeSet;
  return {
    id: changeSet.id,
    chatId: changeSet.chatId,
    runId: changeSet.runId,
    createdAt: changeSet.createdAt,
    status: changeSet.status,
    changes: changeSet.changes,
  };
}

function uniqueChangeSets(
  ...changeSets: readonly (ChangeSet | null)[]
): readonly ChangeSet[] {
  const unique = new Map<string, ChangeSet>();
  for (const changeSet of changeSets) {
    if (changeSet) unique.set(changeSet.id, changeSet);
  }
  return [...unique.values()];
}
