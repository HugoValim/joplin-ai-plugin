import { randomBytes } from "crypto";
import { DomainError, safeValue } from "../shared/errors";
import type {
  ChangeSet,
  ChangeSetScope,
  ChangeSetStore,
  ProposedChange,
} from "./changeSetStore";
import type { ChatStore, PersistedChat } from "./chatStore";

export interface ChangeSetReviewNotePort {
  openForChangeSet(changeSet: ChangeSet, chatTitle: string): Promise<string>;
  ensureOpen(changeSet: ChangeSet, chatTitle: string): Promise<string>;
  dispose(noteId: string): Promise<void>;
}

interface ChangeSetReviewActivationBase {
  readonly changeSet: ChangeSet;
  readonly applyToken: string;
}

export interface AutomaticChangeSetReviewActivation extends ChangeSetReviewActivationBase {
  readonly mode: "automatic";
  readonly acceptedChangeIds: string[];
}

export interface ManualChangeSetReviewActivation extends ChangeSetReviewActivationBase {
  readonly mode: "manual";
}

export type ChangeSetReviewActivation =
  AutomaticChangeSetReviewActivation | ManualChangeSetReviewActivation;

export interface ChangeSetApplyInput extends ChangeSetScope {
  readonly changeSetId: string;
  readonly acceptedChangeIds: readonly string[];
  readonly applyToken: string;
  readonly automatic: boolean;
}

export interface ChangeSetApplyResult {
  readonly changeSetId: string;
  readonly changes: readonly ProposedChange[];
  readonly undoAvailable: boolean;
}

export interface ChangeSetApplicationPort {
  apply(
    changeSetId: string,
    acceptedChangeIds: readonly string[],
    scope: ChangeSetScope,
  ): Promise<ChangeSetApplyResult>;
  mergeRollbacks(
    runId: string,
    chatId: string,
    sourceRunId: string,
  ): Promise<void>;
}

export interface ChangeSetTransitionPort {
  continueAfterApply(
    input: ChangeSetApplyInput,
    result: ChangeSetApplyResult,
  ): Promise<boolean>;
  applyCompleted(
    input: ChangeSetApplyInput,
    result: ChangeSetApplyResult,
  ): void;
  deleteContinuation(changeSetId: string): void;
  discardCompleted(input: ChangeSetDiscardInput): void;
}

export interface ChangeSetDiscardInput extends ChangeSetScope {
  readonly changeSetId: string;
}

export class ChangeSetLifecycle {
  private readonly applyTokens = new Map<string, string>();

  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly chats: ChatStore,
    private readonly reviewNotes: ChangeSetReviewNotePort,
  ) {}

  /**
   * Applies an approved Change Set through the lifecycle security boundary.
   *
   * @example await lifecycle.apply(input, application, transition)
   */
  public async apply(
    input: ChangeSetApplyInput,
    application: ChangeSetApplicationPort,
    transition: ChangeSetTransitionPort,
  ): Promise<void> {
    this.assertApplyToken(input.changeSetId, input.applyToken);
    this.revokeApplyToken(input.changeSetId);
    const result = await application.apply(
      input.changeSetId,
      input.acceptedChangeIds,
      { chatId: input.chatId, runId: input.runId },
    );
    await this.retainAppliedReview(input, result, application);
    const continued = await transition.continueAfterApply(input, result);
    if (!continued) transition.applyCompleted(input, result);
  }

  /**
   * Discards a pending Change Set and clears its approval state.
   *
   * @example await lifecycle.discard(input, transition)
   */
  public async discard(
    input: ChangeSetDiscardInput,
    transition: ChangeSetTransitionPort,
  ): Promise<void> {
    this.changes.discard(input.changeSetId, {
      chatId: input.chatId,
      runId: input.runId,
    });
    this.revokeApplyToken(input.changeSetId);
    transition.deleteContinuation(input.changeSetId);
    await this.clearPending(input.chatId, input.runId, "completed");
    transition.discardCompleted(input);
  }

  /**
   * Attaches proposal presentation state and chooses its approval path.
   *
   * @example await lifecycle.activateReview(changeSet, false)
   */
  public async activateReview(
    changeSet: ChangeSet,
    autoApply: boolean,
  ): Promise<ChangeSetReviewActivation> {
    const chat = await this.requireChat(changeSet.chatId);
    const reviewNoteId = await this.reviewNotes.openForChangeSet(
      changeSet,
      chat.title,
    );
    const reviewed = await this.attachReviewNote(chat, changeSet, reviewNoteId);
    return this.reviewActivation(reviewed, autoApply);
  }

  /**
   * Opens or recreates the Review Note for a persisted pending Change Set.
   *
   * @example await lifecycle.openReview(chatId, changeSetId)
   */
  public async openReview(
    chatId: string,
    changeSetId: string,
  ): Promise<ChangeSet> {
    const chat = await this.requireChat(chatId);
    const pending = chat.pendingChangeSet;
    if (!pending || pending.id !== changeSetId) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `No pending change set ${changeSetId}; expected an awaiting-approval batch`,
      );
    }
    const reviewNoteId = await this.reviewNotes.ensureOpen(pending, chat.title);
    if (reviewNoteId === pending.reviewNoteId) return pending;
    return this.attachReviewNote(chat, pending, reviewNoteId);
  }

  public ensureApplyToken(changeSetId: string): string {
    const existing = this.applyTokens.get(changeSetId);
    return existing ?? this.issueApplyToken(changeSetId);
  }

  public verifyApplyToken(changeSetId: string, token: string): boolean {
    return this.applyTokens.get(changeSetId) === token;
  }

  public revokeApplyToken(changeSetId: string): void {
    this.applyTokens.delete(changeSetId);
  }

  /**
   * Recovers persisted Change Sets into the runtime store.
   *
   * @example lifecycle.recover(persistedChat)
   */
  public recover(chat: PersistedChat): void {
    if (chat.parkedAppliedChangeSet) {
      this.changes.restore(chat.parkedAppliedChangeSet);
    }
    if (chat.pendingChangeSet) {
      this.changes.restore(chat.pendingChangeSet);
    }
  }

  private issueApplyToken(changeSetId: string): string {
    const token = randomBytes(32).toString("hex");
    this.applyTokens.set(changeSetId, token);
    return token;
  }

  private assertApplyToken(changeSetId: string, token: string): void {
    if (this.verifyApplyToken(changeSetId, token)) return;
    throw new DomainError(
      "SECURITY",
      `Invalid apply token for change set ${changeSetId}; expected a plugin-issued token`,
    );
  }

  private async retainAppliedReview(
    input: ChangeSetApplyInput,
    result: ChangeSetApplyResult,
    application: ChangeSetApplicationPort,
  ): Promise<void> {
    const changeSet = this.changes.get(result.changeSetId);
    if (!changeSet) {
      await this.clearPending(input.chatId, input.runId, "applied");
      return;
    }
    const chat = await this.requireChat(input.chatId);
    const retained = await this.retainParkedReview(
      chat,
      changeSet,
      application,
    );
    const reviewed = await this.attachAppliedReview(retained, chat.title);
    await this.saveAppliedReview(chat, input.runId, reviewed);
  }

  private async retainParkedReview(
    chat: PersistedChat,
    applied: ChangeSet,
    application: ChangeSetApplicationPort,
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

  /**
   * Merges a parked applied review into the current applied Change Set.
   *
   * @example await lifecycle.mergeAppliedReviews(chatId, applied, parked, application)
   */
  public async mergeAppliedReviews(
    chatId: string,
    applied: ChangeSet,
    parked: ChangeSet,
    application: ChangeSetApplicationPort,
  ): Promise<ChangeSet> {
    await application.mergeRollbacks(applied.runId, chatId, parked.runId);
    const merged = this.changes.absorbAppliedChanges(
      applied.id,
      parked.changes,
      { chatId, runId: applied.runId },
    );
    if (parked.id !== applied.id) this.changes.drop(parked.id);
    return merged;
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

  /**
   * Clears persisted review state and records the run's terminal status.
   *
   * @example await lifecycle.clearPending(chatId, runId, "applied")
   */
  public async clearPending(
    chatId: string,
    runId: string,
    status: PersistedChat["runSummaries"][number]["status"],
  ): Promise<void> {
    const chat = await this.requireChat(chatId);
    await this.disposeReviewNote(chat.pendingChangeSet?.reviewNoteId);
    await this.disposeReviewNote(chat.parkedAppliedChangeSet?.reviewNoteId);
    const runSummaries = chat.runSummaries.map((summary) =>
      summary.runId === runId ? { ...summary, status } : summary,
    );
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      runSummaries,
      pendingChangeSet: null,
      parkedAppliedChangeSet: null,
    });
  }

  private async disposeReviewNote(
    reviewNoteId: string | undefined,
  ): Promise<void> {
    if (!reviewNoteId) return;
    await this.reviewNotes.dispose(reviewNoteId);
  }

  private async attachReviewNote(
    chat: PersistedChat,
    changeSet: ChangeSet,
    reviewNoteId: string,
  ): Promise<ChangeSet> {
    const reviewed = this.changes.attachReviewNote(changeSet.id, reviewNoteId);
    await this.chats.save({ ...chat, pendingChangeSet: reviewed });
    return reviewed;
  }

  private reviewActivation(
    changeSet: ChangeSet,
    autoApply: boolean,
  ): ChangeSetReviewActivation {
    const applyToken = this.issueApplyToken(changeSet.id);
    if (!autoApply || requiresManualReview(changeSet)) {
      return { mode: "manual", changeSet, applyToken };
    }
    return {
      mode: "automatic",
      changeSet,
      applyToken,
      acceptedChangeIds: changeSet.changes.map((change) => change.id),
    };
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

function requiresManualReview(changeSet: ChangeSet): boolean {
  return changeSet.changes.some(
    (change) => change.kind !== "file" && change.operation === "delete",
  );
}
