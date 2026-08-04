import { randomBytes } from "crypto";
import { DomainError, safeValue } from "../shared/errors";
import type { ChangeSet, ChangeSetStore } from "./changeSetStore";
import type { ChatStore, PersistedChat } from "./chatStore";

export interface ChangeSetReviewNotePort {
  openForChangeSet(changeSet: ChangeSet, chatTitle: string): Promise<string>;
  ensureOpen(changeSet: ChangeSet, chatTitle: string): Promise<string>;
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

export class ChangeSetLifecycle {
  private readonly applyTokens = new Map<string, string>();

  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly chats: ChatStore,
    private readonly reviewNotes: ChangeSetReviewNotePort,
  ) {}

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
