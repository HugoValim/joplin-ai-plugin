import type { AgentContinuation } from "../agent/agentRunner";
import type { ChangeApplier, ApplyResult } from "../agent/changeApplier";
import type { ContextCitation } from "../agent/contextBuilder";
import type { ChangeSet, ChangeSetStore } from "../persistence/changeSetStore";
import {
  ChangeSetLifecycle,
  type ChangeSetTransitionPort,
  type ChangeSetApplyInput,
  type ChangeSetDiscardInput,
  type ChangeSetResolutionEvent,
  type ChangeSetResolutionTransitionPort,
} from "../persistence/changeSetLifecycle";
import type { ChatStore } from "../persistence/chatStore";
import type { PanelRequest } from "../shared/protocol";
import type { ToolRegistry } from "../tools/toolRegistry";
import {
  ApprovalContinuation,
  type ContinuationProviderPort,
} from "./approvalContinuation";
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
      // Wired to panel publish in the parking-wiring slice.
      reviewRestored: (): void => {},
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
    await this.changeSetLifecycle.rollback(
      {
        chatId: request.chatId,
        runId: request.runId,
        targetRunId: request.payload.targetRunId,
      },
      this.applier,
      this.changeSetResolutionTransition(),
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
    await this.changeSetLifecycle.deny(
      {
        chatId: request.chatId,
        runId: request.runId,
        changeSetId: request.payload.changeSetId,
      },
      this.applier,
      this.changeSetResolutionTransition(),
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
    await this.changeSetLifecycle.keep(
      {
        chatId: request.chatId,
        runId: request.runId,
        changeSetId: request.payload.changeSetId,
        changeIds: request.payload.changeIds,
      },
      this.changeSetResolutionTransition(),
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
    await this.changeSetLifecycle.undoSelected(
      {
        chatId: request.chatId,
        runId: request.runId,
        changeSetId: request.payload.changeSetId,
        changeIds: request.payload.changeIds,
      },
      this.applier,
      this.changeSetResolutionTransition(),
    );
  }

  private changeSetResolutionTransition(): ChangeSetResolutionTransitionPort {
    return {
      publish: (input, event): void => this.publishResolution(input, event),
      deleteContinuation: (changeSetId): void =>
        this.continuationRuns.delete(changeSetId),
    };
  }

  private publishResolution(
    input: { readonly chatId: string; readonly runId: string },
    event: ChangeSetResolutionEvent,
  ): void {
    if (event.mode === "review" && !event.summary) {
      this.events.post(
        "changes.proposed",
        input.chatId,
        toChangeSetView(event.changeSet, ""),
        input.runId,
      );
      return;
    }
    this.events.post(
      "run.completed",
      input.chatId,
      {
        summary: event.summary,
        ...(event.undoRunId ? { undoRunId: event.undoRunId } : {}),
      },
      input.runId,
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
