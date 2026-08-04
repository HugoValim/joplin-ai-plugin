import type { AgentContinuation } from "../agent/agentRunner";
import type { ChangeApplier, ApplyResult } from "../agent/changeApplier";
import type { ContextCitation } from "../agent/contextBuilder";
import type { ChangeSet, ChangeSetStore } from "../persistence/changeSetStore";
import {
  ChangeSetLifecycle,
  type ChangeSetTransitionPort,
  type ChangeSetApplyInput,
  type ChangeSetDiscardInput,
} from "../persistence/changeSetLifecycle";
import type { ChatStore } from "../persistence/chatStore";
import { DomainError, safeValue } from "../shared/errors";
import type { PanelRequest } from "../shared/protocol";
import type { ToolRegistry } from "../tools/toolRegistry";
import {
  ApprovalContinuation,
  type ContinuationProviderPort,
} from "./approvalContinuation";
import { requireChat } from "./chatLifecycle";
import { toChangeSetView } from "./chatView";
import {
  automaticApplyRequest,
  toChangeSetApplyInput,
} from "./changeSetApprovalRequest";
import type { PluginEventSender } from "./pluginEventSender";
import type { RunCancellationRegistry } from "./runCancellationRegistry";
import type { ReviewNotePort } from "./reviewNoteService";
import { ModelRunLifecycle } from "./modelRunLifecycle";

export class ApprovalWorkflow {
  private readonly continuationRuns: ApprovalContinuation;
  private readonly changeSetLifecycle: ChangeSetLifecycle;

  public constructor(
    private readonly chats: ChatStore,
    private readonly changes: ChangeSetStore,
    private readonly applier: ChangeApplier,
    tools: ToolRegistry,
    providers: ContinuationProviderPort,
    private readonly events: PluginEventSender,
    activeRuns: RunCancellationRegistry,
    private readonly reviewNotes: ReviewNotePort,
    changeSetLifecycle?: ChangeSetLifecycle,
    modelRuns?: ModelRunLifecycle,
  ) {
    this.changeSetLifecycle =
      changeSetLifecycle ?? new ChangeSetLifecycle(changes, chats, reviewNotes);
    const continuationModelRuns =
      modelRuns ??
      new ModelRunLifecycle(chats, tools, changes, events, activeRuns);
    this.continuationRuns = new ApprovalContinuation(
      chats,
      providers,
      events,
      continuationModelRuns,
      async (changeSet, autoApply): Promise<void> =>
        this.resolveProposedChanges(changeSet, autoApply),
    );
  }

  public remember(
    changeSet: ChangeSet | null,
    continuation: AgentContinuation | null,
    chatId: string,
    hasFileWorkspace: boolean,
    vault: boolean,
    readableNoteIds: ReadonlySet<string>,
    secretNotebookIds: ReadonlySet<string>,
    citations: readonly ContextCitation[],
  ): void {
    this.continuationRuns.remember(
      changeSet,
      continuation,
      chatId,
      hasFileWorkspace,
      vault,
      readableNoteIds,
      secretNotebookIds,
      citations,
    );
  }

  public abandonChat(chatId: string): void {
    void this.disposePendingReviewNote(chatId);
    this.continuationRuns.deleteChat(chatId);
  }

  /**
   * Opens or recreates the Review Note for a pending change set.
   *
   * @example await workflow.openReview(request)
   */
  public async openReview(
    request: Extract<PanelRequest, { type: "review.open" }>,
  ): Promise<void> {
    await this.changeSetLifecycle.openReview(
      request.chatId,
      request.payload.changeSetId,
    );
  }

  /**
   * Ensures a pending change set has a plugin-issued apply token for snapshots.
   *
   * @example workflow.applyTokenForChangeSet("changes-1")
   */
  public applyTokenForChangeSet(changeSetId: string): string {
    return this.changeSetLifecycle.ensureApplyToken(changeSetId);
  }

  /**
   * Presents a proposal for review or applies every item under chat opt-in.
   *
   * @example await workflow.resolveProposedChanges(changeSet, autoApply)
   */
  public async resolveProposedChanges(
    changeSet: ChangeSet,
    autoApply: boolean,
  ): Promise<void> {
    await this.parkAppliedReview(changeSet.chatId);
    const activation = await this.changeSetLifecycle.activateReview(
      changeSet,
      autoApply,
    );
    if (activation.mode === "automatic") {
      this.postAutomaticProgress(activation.changeSet);
      await this.applyRequest(
        automaticApplyRequest(
          activation.changeSet,
          activation.acceptedChangeIds,
          activation.applyToken,
        ),
        true,
      );
      return;
    }
    this.events.post(
      "changes.proposed",
      changeSet.chatId,
      toChangeSetView(activation.changeSet, activation.applyToken),
      changeSet.runId,
    );
  }

  private postAutomaticProgress(changeSet: ChangeSet): void {
    this.events.post(
      "run.progress",
      changeSet.chatId,
      {
        current: 0,
        total: changeSet.changes.length,
        label: `Auto-applying ${changeSet.changes.length} proposed changes`,
      },
      changeSet.runId,
    );
  }

  public async apply(
    request: Extract<PanelRequest, { type: "changes.apply" }>,
  ): Promise<void> {
    await this.applyRequest(request, false);
  }

  private async applyRequest(
    request: Extract<PanelRequest, { type: "changes.apply" }>,
    automatic: boolean,
  ): Promise<void> {
    await this.changeSetLifecycle.apply(
      toChangeSetApplyInput(request, automatic),
      this.applier,
      this.changeSetTransition(),
    );
  }

  public async discard(
    request: Extract<PanelRequest, { type: "changes.discard" }>,
  ): Promise<void> {
    await this.changeSetLifecycle.discard(
      {
        chatId: request.chatId,
        runId: request.runId,
        changeSetId: request.payload.changeSetId,
      },
      this.changeSetTransition(),
    );
  }

  private changeSetTransition(): ChangeSetTransitionPort {
    return {
      continueAfterApply: async (input, result): Promise<boolean> =>
        this.continuationRuns.continueAfterApply(input, result),
      applyCompleted: (input, result): void =>
        this.postApplyCompleted(input, result),
      deleteContinuation: (changeSetId): void =>
        this.continuationRuns.delete(changeSetId),
      discardCompleted: (input): void => this.postDiscardCompleted(input),
    };
  }

  private postDiscardCompleted(input: ChangeSetDiscardInput): void {
    this.events.post(
      "run.completed",
      input.chatId,
      { summary: "Changes discarded" },
      input.runId,
    );
  }

  public async undo(
    request: Extract<PanelRequest, { type: "run.undo" }>,
  ): Promise<void> {
    const result = await this.applier.undo(
      request.payload.targetRunId,
      request.chatId,
    );
    this.events.post(
      "run.completed",
      request.chatId,
      {
        summary: `Restored ${result.restored}; conflicts ${result.conflicts.length}`,
      },
      request.runId,
    );
  }

  /**
   * Denies an applied change set: restores pre-change content for each
   * accepted change and resolves the change set. Used when Bypass auto-applied
   * changes and the user wants to review and undo the batch.
   *
   * @example await workflow.deny(request)
   */
  public async deny(
    request: Extract<PanelRequest, { type: "changes.deny" }>,
  ): Promise<void> {
    const changeSet = this.changes.get(request.payload.changeSetId);
    if (!changeSet) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `Change set ${safeValue(request.payload.changeSetId)} not found; expected an applied or pending change set`,
      );
    }
    if (changeSet.status === "proposed") {
      this.changes.discard(request.payload.changeSetId, {
        chatId: request.chatId,
        runId: request.runId,
      });
      this.changeSetLifecycle.revokeApplyToken(request.payload.changeSetId);
      this.continuationRuns.delete(request.payload.changeSetId);
      await this.changeSetLifecycle.clearPending(
        request.chatId,
        request.runId,
        "denied",
      );
      this.events.post(
        "run.completed",
        request.chatId,
        { summary: "Changes denied before apply" },
        request.runId,
      );
      return;
    }
    const result = await this.applier.undo(changeSet.runId, request.chatId);
    this.changes.removeChanges(
      changeSet.id,
      changeSet.changes.map((change) => change.id),
      { chatId: request.chatId, runId: request.runId },
    );
    await this.changeSetLifecycle.clearPending(
      request.chatId,
      request.runId,
      "denied",
    );
    this.events.post(
      "run.completed",
      request.chatId,
      {
        summary: `Denied and restored ${result.restored}; conflicts ${result.conflicts.length}`,
      },
      request.runId,
    );
  }

  /**
   * Keeps applied review items without restoring content.
   *
   * @example await workflow.keep(request)
   */
  public async keep(
    request: Extract<PanelRequest, { type: "changes.keep" }>,
  ): Promise<void> {
    const remaining = this.changes.removeChanges(
      request.payload.changeSetId,
      request.payload.changeIds,
      { chatId: request.chatId, runId: request.runId },
    );
    if (!remaining) {
      await this.changeSetLifecycle.clearPending(
        request.chatId,
        request.runId,
        "applied",
      );
      this.events.post(
        "run.completed",
        request.chatId,
        { summary: "Kept applied changes" },
        request.runId,
      );
      return;
    }
    await this.savePending(request.chatId, remaining);
    this.events.post(
      "changes.proposed",
      request.chatId,
      toChangeSetView(remaining, ""),
      request.runId,
    );
  }

  /**
   * Undoes selected applied review items and drops them from the pending panel.
   *
   * @example await workflow.undoChanges(request)
   */
  public async undoChanges(
    request: Extract<PanelRequest, { type: "changes.undo" }>,
  ): Promise<void> {
    const changeSet = this.changes.getScoped(request.payload.changeSetId, {
      chatId: request.chatId,
      runId: request.runId,
    });
    if (changeSet.status !== "applied" && changeSet.status !== "partial") {
      throw new DomainError(
        "NOT_AVAILABLE",
        `Change set ${safeValue(changeSet.id)} has status ${changeSet.status}; expected applied or partial status`,
      );
    }
    const result = await this.applier.undo(
      changeSet.runId,
      request.chatId,
      request.payload.changeIds,
    );
    const remaining = this.changes.removeChanges(
      changeSet.id,
      request.payload.changeIds,
      { chatId: request.chatId, runId: request.runId },
    );
    if (!remaining) {
      await this.changeSetLifecycle.clearPending(
        request.chatId,
        request.runId,
        "applied",
      );
      this.events.post(
        "run.completed",
        request.chatId,
        {
          summary: `Undid ${result.restored}; conflicts ${result.conflicts.length}`,
        },
        request.runId,
      );
      return;
    }
    await this.savePending(request.chatId, remaining);
    this.events.post(
      "run.completed",
      request.chatId,
      {
        summary: `Undid ${result.restored}; conflicts ${result.conflicts.length}`,
        ...(result.restored > 0 || remaining.changes.some(isUndoableApplied)
          ? { undoRunId: changeSet.runId }
          : {}),
      },
      request.runId,
    );
  }

  private postApplyCompleted(
    input: ChangeSetApplyInput,
    result: ApplyResult,
  ): void {
    const counts = applyCounts(result);
    this.events.post(
      "run.completed",
      input.chatId,
      {
        summary: `Applied ${counts.applied}; conflicts ${counts.conflicts}`,
        ...(result.undoAvailable ? { undoRunId: input.runId } : {}),
      },
      input.runId,
    );
  }

  private async parkAppliedReview(chatId: string): Promise<void> {
    const chat = await this.chats.get(chatId);
    if (!chat?.pendingChangeSet) return;
    const pending = chat.pendingChangeSet;
    if (pending.status !== "applied" && pending.status !== "partial") return;
    await this.disposeReviewNote(pending.reviewNoteId);
    const parkedWithoutNote = stripReviewNote(pending);
    const existing = chat.parkedAppliedChangeSet;
    if (!existing) {
      await this.chats.save({
        ...chat,
        updatedAt: Date.now(),
        pendingChangeSet: null,
        parkedAppliedChangeSet: parkedWithoutNote,
      });
      return;
    }
    const merged = await this.changeSetLifecycle.mergeAppliedReviews(
      chatId,
      parkedWithoutNote,
      existing,
      this.applier,
    );
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      pendingChangeSet: null,
      parkedAppliedChangeSet: stripReviewNote(merged),
    });
  }

  private async savePending(
    chatId: string,
    changeSet: ChangeSet,
  ): Promise<void> {
    const chat = await requireChat(this.chats, chatId);
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      pendingChangeSet: changeSet,
    });
  }

  private async disposePendingReviewNote(chatId: string): Promise<void> {
    const chat = await this.chats.get(chatId);
    await this.disposeReviewNote(chat?.pendingChangeSet?.reviewNoteId);
    await this.disposeReviewNote(chat?.parkedAppliedChangeSet?.reviewNoteId);
  }

  private async disposeReviewNote(
    reviewNoteId: string | undefined,
  ): Promise<void> {
    if (!reviewNoteId) return;
    await this.reviewNotes.dispose(reviewNoteId);
  }
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

function isUndoableApplied(change: ChangeSet["changes"][number]): boolean {
  if (change.status !== "applied") return false;
  if (change.kind === "file") return true;
  return change.operation === "update";
}

function applyCounts(result: ApplyResult): {
  readonly applied: number;
  readonly conflicts: number;
} {
  return {
    applied: result.changes.filter((change) => change.status === "applied")
      .length,
    conflicts: result.changes.filter((change) => change.status === "conflict")
      .length,
  };
}
