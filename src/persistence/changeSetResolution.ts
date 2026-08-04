import type { UndoResult } from "../agent/changeApplier";
import { DomainError, safeValue } from "../shared/errors";
import type {
  ChangeSet,
  ChangeSetScope,
  ChangeSetStore,
} from "./changeSetStore";
import type { ChatStore, PersistedChat } from "./chatStore";

export interface ChangeSetResolutionInput extends ChangeSetScope {
  readonly changeSetId: string;
}

export interface ChangeSetSelectionResolutionInput extends ChangeSetResolutionInput {
  readonly changeIds: readonly string[];
}

export interface ChangeSetRollbackInput extends ChangeSetScope {
  readonly targetRunId: string;
}

export interface ChangeSetRollbackPort {
  undo(
    runId: string,
    chatId: string,
    changeIds?: readonly string[],
  ): Promise<UndoResult>;
}

export type ChangeSetResolutionEvent =
  | {
      readonly mode: "completed";
      readonly summary: string;
      readonly undoRunId?: string;
    }
  | {
      readonly mode: "review";
      readonly changeSet: ChangeSet;
      readonly summary?: string;
      readonly undoRunId?: string;
      readonly restored?: boolean;
    };

export interface ChangeSetResolutionTransitionPort {
  publish(input: ChangeSetScope, event: ChangeSetResolutionEvent): void;
  deleteContinuation(changeSetId: string): void;
}

type ResolveCurrentReview = (
  chatId: string,
  runId: string,
  status: PersistedChat["runSummaries"][number]["status"],
) => Promise<ChangeSet | null>;

export class ChangeSetResolution {
  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly chats: ChatStore,
    private readonly resolveCurrentReview: ResolveCurrentReview,
    private readonly revokeApplyToken: (changeSetId: string) => void,
  ) {}

  /**
   * Resolves kept items and publishes the next review state.
   * @example await resolution.keep(input, transition)
   */
  public async keep(
    input: ChangeSetSelectionResolutionInput,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    const remaining = this.removeSelected(input);
    if (!remaining) {
      const restored = await this.complete(input, "applied");
      transition.publish(
        input,
        completionEvent("Kept applied changes", restored),
      );
      return;
    }
    await this.savePending(input.chatId, remaining);
    transition.publish(input, { mode: "review", changeSet: remaining });
  }

  /**
   * Resolves a proposed or applied Change Set as denied.
   * @example await resolution.deny(input, rollback, transition)
   */
  public async deny(
    input: ChangeSetResolutionInput,
    rollback: ChangeSetRollbackPort,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    const changeSet = this.requireChangeSet(input);
    if (changeSet.status === "proposed") {
      await this.denyProposed(input, transition);
      return;
    }
    this.assertApplied(changeSet);
    const result = await rollback.undo(changeSet.runId, input.chatId);
    this.removeAll(input, changeSet);
    const restored = await this.complete(input, "denied");
    transition.publish(
      input,
      completionEvent(undoSummary("Denied and restored", result), restored),
    );
  }

  /**
   * Restores selected items and publishes the next review state.
   * @example await resolution.undoSelected(input, rollback, transition)
   */
  public async undoSelected(
    input: ChangeSetSelectionResolutionInput,
    rollback: ChangeSetRollbackPort,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    const changeSet = this.requireChangeSet(input);
    this.assertApplied(changeSet);
    const result = await rollback.undo(
      changeSet.runId,
      input.chatId,
      input.changeIds,
    );
    const remaining = this.removeSelected(input);
    await this.finishUndo(input, changeSet, remaining, result, transition);
  }

  /**
   * Restores every retained item for a completed run.
   * @example await resolution.rollback(input, rollback, transition)
   */
  public async rollback(
    input: ChangeSetRollbackInput,
    rollback: ChangeSetRollbackPort,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    const result = await rollback.undo(input.targetRunId, input.chatId);
    transition.publish(input, {
      mode: "completed",
      summary: undoSummary("Restored", result),
    });
  }

  /**
   * Disposes terminal Review Notes and records the run status.
   * @example await resolution.clearPending(chatId, runId, "applied")
   */
  public async clearPending(
    chatId: string,
    runId: string,
    status: PersistedChat["runSummaries"][number]["status"],
  ): Promise<ChangeSet | null> {
    return this.resolveCurrentReview(chatId, runId, status);
  }

  private async denyProposed(
    input: ChangeSetResolutionInput,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    this.revokeApplyToken(input.changeSetId);
    const restored = await this.complete(input, "denied");
    this.changes.discard(input.changeSetId, input);
    transition.deleteContinuation(input.changeSetId);
    transition.publish(
      input,
      completionEvent("Changes denied before apply", restored),
    );
  }

  private async finishUndo(
    input: ChangeSetSelectionResolutionInput,
    original: ChangeSet,
    remaining: ChangeSet | null,
    result: UndoResult,
    transition: ChangeSetResolutionTransitionPort,
  ): Promise<void> {
    const summary = undoSummary("Undid", result);
    if (!remaining) {
      const restored = await this.complete(input, "applied");
      transition.publish(input, completionEvent(summary, restored));
      return;
    }
    await this.savePending(input.chatId, remaining);
    transition.publish(input, {
      mode: "review",
      changeSet: remaining,
      summary,
      ...(undoStillAvailable(result, remaining)
        ? { undoRunId: original.runId }
        : {}),
    });
  }

  private requireChangeSet(input: ChangeSetResolutionInput): ChangeSet {
    return this.changes.getScoped(input.changeSetId, input);
  }

  private assertApplied(changeSet: ChangeSet): void {
    if (changeSet.status === "applied" || changeSet.status === "partial") {
      return;
    }
    throw new DomainError(
      "NOT_AVAILABLE",
      `Change set ${safeValue(changeSet.id)} has status ${changeSet.status}; expected applied or partial status`,
    );
  }

  private removeSelected(
    input: ChangeSetSelectionResolutionInput,
  ): ChangeSet | null {
    return this.changes.removeChanges(
      input.changeSetId,
      input.changeIds,
      input,
    );
  }

  private removeAll(
    input: ChangeSetResolutionInput,
    changeSet: ChangeSet,
  ): void {
    this.changes.removeChanges(
      changeSet.id,
      changeSet.changes.map((change) => change.id),
      input,
    );
  }

  private complete(
    input: ChangeSetScope,
    status: PersistedChat["runSummaries"][number]["status"],
  ): Promise<ChangeSet | null> {
    return this.clearPending(input.chatId, input.runId, status);
  }

  private async savePending(
    chatId: string,
    changeSet: ChangeSet,
  ): Promise<void> {
    const chat = await this.requireChat(chatId);
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      pendingChangeSet: changeSet,
    });
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

function completionEvent(
  summary: string,
  restored: ChangeSet | null,
): ChangeSetResolutionEvent {
  if (!restored) return { mode: "completed", summary };
  return { mode: "review", changeSet: restored, summary, restored: true };
}

function undoSummary(prefix: string, result: UndoResult): string {
  return `${prefix} ${result.restored}; conflicts ${result.conflicts.length}`;
}

function undoStillAvailable(result: UndoResult, remaining: ChangeSet): boolean {
  return result.restored > 0 || remaining.changes.some(isUndoableApplied);
}

function isUndoableApplied(change: ChangeSet["changes"][number]): boolean {
  if (change.status !== "applied") return false;
  if (change.kind === "file") return true;
  return change.operation === "update";
}
