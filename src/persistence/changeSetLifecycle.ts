import { randomBytes } from "crypto";
import { DomainError, safeValue } from "../shared/errors";
import type {
  ChangeSet,
  ChangeSetScope,
  ChangeSetStore,
  ProposedChange,
} from "./changeSetStore";
import type { ChatStore, PersistedChat } from "./chatStore";
import {
  ChangeSetParking,
  type ChangeSetRollbackMergePort,
} from "./changeSetParking";
import {
  ChangeSetResolution,
  type ChangeSetResolutionInput,
  type ChangeSetResolutionTransitionPort,
  type ChangeSetRollbackInput,
  type ChangeSetRollbackPort,
  type ChangeSetSelectionResolutionInput,
} from "./changeSetResolution";

export type {
  ChangeSetResolutionEvent,
  ChangeSetResolutionInput,
  ChangeSetResolutionTransitionPort,
  ChangeSetRollbackInput,
  ChangeSetRollbackPort,
  ChangeSetSelectionResolutionInput,
} from "./changeSetResolution";

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

export interface ChangeSetApplicationPort extends ChangeSetRollbackMergePort {
  apply(
    changeSetId: string,
    acceptedChangeIds: readonly string[],
    scope: ChangeSetScope,
  ): Promise<ChangeSetApplyResult>;
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
  reviewRestored(changeSet: ChangeSet): void;
}

export interface ChangeSetDiscardInput extends ChangeSetScope {
  readonly changeSetId: string;
}

export class ChangeSetLifecycle {
  private readonly applyTokens = new Map<string, string>();
  private readonly parking: ChangeSetParking;
  private readonly resolution: ChangeSetResolution;

  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly chats: ChatStore,
    private readonly reviewNotes: ChangeSetReviewNotePort,
  ) {
    this.parking = new ChangeSetParking(
      changes,
      chats,
      reviewNotes,
      (changeSetId): void => this.revokeApplyToken(changeSetId),
    );
    this.resolution = new ChangeSetResolution(
      changes,
      chats,
      (chatId, runId, status): Promise<ChangeSet | null> =>
        this.parking.resolveCurrent(chatId, runId, status),
      (changeSetId): void => this.revokeApplyToken(changeSetId),
    );
  }

  /**
   * Parks the current applied review while another Change Set is presented.
   *
   * @example await lifecycle.parkAppliedReview(chatId, application)
   */
  public parkAppliedReview(
    chatId: string,
    application: ChangeSetRollbackMergePort,
  ): Promise<void> {
    return this.parking.parkAppliedReview(chatId, application);
  }

  /**
   * Clears runtime approval state before a chat is cleared or deleted.
   *
   * @example await lifecycle.abandon(chatId)
   */
  public async abandon(chatId: string): Promise<void> {
    await this.parking.abandon(chatId);
  }

  /**
   * Keeps selected applied items and retains any unresolved review items.
   *
   * @example await lifecycle.keep(input, transition)
   */
  public keep(
    input: ChangeSetSelectionResolutionInput,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    return this.resolution.keep(input, transition);
  }

  /**
   * Denies a proposed or applied Change Set through its required resolution path.
   *
   * @example await lifecycle.deny(input, rollback, transition)
   */
  public deny(
    input: ChangeSetResolutionInput,
    rollback: ChangeSetRollbackPort,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    return this.resolution.deny(input, rollback, transition);
  }

  /**
   * Restores selected applied items and retains any unresolved review items.
   *
   * @example await lifecycle.undoSelected(input, rollback, transition)
   */
  public undoSelected(
    input: ChangeSetSelectionResolutionInput,
    rollback: ChangeSetRollbackPort,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    return this.resolution.undoSelected(input, rollback, transition);
  }

  /**
   * Restores every retained rollback item for an applied run.
   *
   * @example await lifecycle.rollback(input, rollback, transition)
   */
  public rollback(
    input: ChangeSetRollbackInput,
    rollback: ChangeSetRollbackPort,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    return this.resolution.rollback(input, rollback, transition);
  }

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
    this.revokeApplyToken(input.changeSetId);
    const restored = await this.parking.resolveCurrent(
      input.chatId,
      input.runId,
      "completed",
    );
    this.changes.discard(input.changeSetId, input);
    transition.deleteContinuation(input.changeSetId);
    transition.discardCompleted(input);
    if (restored) transition.reviewRestored(restored);
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
    const retained = await this.parking.retainAppliedReview(
      input.chatId,
      input.runId,
      result.changeSetId,
      application,
    );
    if (!retained) {
      await this.clearPending(input.chatId, input.runId, "applied");
    }
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
    const merged = await this.parking.mergeAppliedReviews(
      chatId,
      applied,
      parked,
      application,
    );
    if (parked.id !== applied.id) this.changes.drop(parked.id);
    return merged;
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
    await this.resolution.clearPending(chatId, runId, status);
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
