import { randomUUID } from "crypto";
import {
  AgentRunner,
  type AgentContinuation,
  type AgentObserver,
} from "../agent/agentRunner";
import type { ChangeApplier, ApplyResult } from "../agent/changeApplier";
import type { ContextCitation } from "../agent/contextBuilder";
import type { ChangeSet, ChangeSetStore } from "../persistence/changeSetStore";
import type { ChatStore, PersistedRunSummary } from "../persistence/chatStore";
import type { AiProvider } from "../providers/types";
import { DomainError, safeValue } from "../shared/errors";
import { PROTOCOL_VERSION, type PanelRequest } from "../shared/protocol";
import type { ToolExecutionResult, ToolRegistry } from "../tools/toolRegistry";
import {
  AgentContinuationStore,
  type PendingAgentContinuation,
} from "./agentContinuationStore";
import { persistRunOutcome, requireChat } from "./chatLifecycle";
import { toChangeSetView } from "./chatView";
import { DeltaBatcher } from "./deltaBatcher";
import { ApplyTokenStore } from "./applyTokenStore";
import type { PluginEventSender } from "./pluginEventSender";
import type { RunCancellationRegistry } from "./runCancellationRegistry";
import type { ReviewNotePort } from "./reviewNoteService";
import { summarizeToolResult } from "./toolActivity";

interface ContinuationProviderPort {
  connectWithConfirmation(): Promise<{ readonly provider: AiProvider }>;
}

export class ApprovalWorkflow {
  private readonly continuations = new AgentContinuationStore();
  private readonly applyTokens = new ApplyTokenStore();

  public constructor(
    private readonly chats: ChatStore,
    private readonly changes: ChangeSetStore,
    private readonly applier: ChangeApplier,
    private readonly tools: ToolRegistry,
    private readonly providers: ContinuationProviderPort,
    private readonly events: PluginEventSender,
    private readonly activeRuns: RunCancellationRegistry,
    private readonly reviewNotes: ReviewNotePort,
  ) {}

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
    if (!changeSet || !continuation) return;
    this.continuations.save(changeSet.id, {
      chatId,
      hasFileWorkspace,
      vault,
      readableNoteIds,
      secretNotebookIds,
      continuation,
      citations,
    });
  }

  public abandonChat(chatId: string): void {
    void this.disposePendingReviewNote(chatId);
    this.continuations.deleteChat(chatId);
  }

  /**
   * Opens or recreates the Review Note for a pending change set.
   *
   * @example await workflow.openReview(request)
   */
  public async openReview(
    request: Extract<PanelRequest, { type: "review.open" }>,
  ): Promise<void> {
    const chat = await requireChat(this.chats, request.chatId);
    const pending = chat.pendingChangeSet;
    if (!pending || pending.id !== request.payload.changeSetId) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `No pending change set ${request.payload.changeSetId}; expected an awaiting-approval batch`,
      );
    }
    const reviewNoteId = await this.reviewNotes.ensureOpen(pending, chat.title);
    if (reviewNoteId === pending.reviewNoteId) return;
    const updated = this.changes.attachReviewNote(pending.id, reviewNoteId);
    await this.chats.save({ ...chat, pendingChangeSet: updated });
  }

  /**
   * Ensures a pending change set has a plugin-issued apply token for snapshots.
   *
   * @example workflow.applyTokenForChangeSet("changes-1")
   */
  public applyTokenForChangeSet(changeSetId: string): string {
    return this.applyTokens.ensure(changeSetId);
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
    if (autoApply && !requiresManualReview(changeSet)) {
      this.postAutomaticProgress(changeSet);
      const applyToken = this.applyTokens.issue(changeSet.id);
      const chat = await requireChat(this.chats, changeSet.chatId);
      const reviewNoteId = await this.reviewNotes.openForChangeSet(
        changeSet,
        chat.title,
      );
      const reviewed = this.changes.attachReviewNote(
        changeSet.id,
        reviewNoteId,
      );
      await this.chats.save({ ...chat, pendingChangeSet: reviewed });
      await this.applyRequest(
        automaticApplyRequest(reviewed, applyToken),
        true,
      );
      return;
    }
    const applyToken = this.applyTokens.issue(changeSet.id);
    const chat = await requireChat(this.chats, changeSet.chatId);
    const reviewNoteId = await this.reviewNotes.openForChangeSet(
      changeSet,
      chat.title,
    );
    const reviewed = this.changes.attachReviewNote(changeSet.id, reviewNoteId);
    await this.chats.save({ ...chat, pendingChangeSet: reviewed });
    this.events.post(
      "changes.proposed",
      changeSet.chatId,
      toChangeSetView(reviewed, applyToken),
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
    if (
      !this.applyTokens.verify(
        request.payload.changeSetId,
        request.payload.applyToken,
      )
    ) {
      throw new DomainError(
        "SECURITY",
        `Invalid apply token for change set ${request.payload.changeSetId}; expected a plugin-issued token`,
      );
    }
    this.applyTokens.revoke(request.payload.changeSetId);
    const result = await this.applier.apply(
      request.payload.changeSetId,
      request.payload.acceptedIds,
      { chatId: request.chatId, runId: request.runId },
    );
    await this.retainAppliedReview(request.chatId, request.runId, result);
    const pending = this.continuations.take(request.payload.changeSetId);
    if (pending) {
      await this.continueAfterApproval(request, pending, result, automatic);
      return;
    }
    this.postApplyCompleted(request, result);
  }

  public async discard(
    request: Extract<PanelRequest, { type: "changes.discard" }>,
  ): Promise<void> {
    this.changes.discard(request.payload.changeSetId, {
      chatId: request.chatId,
      runId: request.runId,
    });
    this.applyTokens.revoke(request.payload.changeSetId);
    this.continuations.delete(request.payload.changeSetId);
    await this.clearPending(request.chatId, request.runId, "completed");
    this.events.post(
      "run.completed",
      request.chatId,
      { summary: "Changes discarded" },
      request.runId,
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
      this.applyTokens.revoke(request.payload.changeSetId);
      this.continuations.delete(request.payload.changeSetId);
      await this.clearPending(request.chatId, request.runId, "denied");
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
    await this.clearPending(request.chatId, request.runId, "denied");
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
      await this.clearPending(request.chatId, request.runId, "applied");
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
      await this.clearPending(request.chatId, request.runId, "applied");
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

  private async continueAfterApproval(
    request: Extract<PanelRequest, { type: "changes.apply" }>,
    pending: PendingAgentContinuation,
    applied: ApplyResult,
    automatic: boolean,
  ): Promise<void> {
    const runId = randomUUID();
    const controller = new AbortController();
    this.activeRuns.replace(request.chatId, runId, controller);
    this.events.post(
      "run.started",
      request.chatId,
      { startedAt: Date.now() },
      runId,
    );
    const deltas = this.createDeltaBatcher(request.chatId, runId);
    try {
      await this.executeContinuation(
        pending,
        applied,
        request.runId,
        runId,
        automatic,
        controller.signal,
        deltas,
      );
    } catch (error: unknown) {
      this.postContinuationFailure(request, runId, applied, error);
    } finally {
      deltas.dispose();
      this.activeRuns.clearIfCurrent(request.chatId, controller);
    }
  }

  private async executeContinuation(
    pending: PendingAgentContinuation,
    applied: ApplyResult,
    appliedRunId: string,
    runId: string,
    automatic: boolean,
    signal: AbortSignal,
    deltas: DeltaBatcher,
  ): Promise<void> {
    const { provider } = await this.providers.connectWithConfirmation();
    const runner = new AgentRunner(
      provider,
      this.tools,
      this.changes,
      this.observer(pending.chatId, runId, deltas),
    );
    const outcome = await runner.resume(
      {
        chatId: pending.chatId,
        runId,
        messages: [],
        hasFileWorkspace: pending.hasFileWorkspace,
        vault: pending.vault,
        readOnly: false,
        readableNoteIds: pending.readableNoteIds,
        secretNotebookIds: pending.secretNotebookIds,
      },
      pending.continuation,
      approvalSummary(applied, automatic),
      signal,
    );
    deltas.flush();
    const chat = await requireChat(this.chats, pending.chatId);
    await persistRunOutcome(
      this.chats,
      chat,
      runId,
      outcome,
      pending.citations,
    );
    this.remember(
      outcome.changeSet,
      outcome.continuation,
      pending.chatId,
      pending.hasFileWorkspace,
      pending.vault,
      pending.readableNoteIds,
      pending.secretNotebookIds,
      pending.citations,
    );
    await this.postContinuationOutcome(
      pending.chatId,
      runId,
      outcome.changeSet,
      applied.undoAvailable ? appliedRunId : null,
      chat.context.autoApply,
    );
  }

  private observer(
    chatId: string,
    runId: string,
    deltas: DeltaBatcher,
  ): AgentObserver {
    return {
      onTextDelta: (delta): void => deltas.push(delta),
      onToolStarted: (call): void =>
        this.events.post(
          "tool.started",
          chatId,
          { toolCallId: call.id, name: call.name },
          runId,
        ),
      onToolCompleted: (result): void =>
        this.postToolCompleted(chatId, runId, result),
      onPlanUpdated: (plan): void =>
        this.events.post(
          "run.plan",
          chatId,
          {
            items: plan.items.map((item) => ({
              id: item.id,
              content: item.content,
              status: item.status,
            })),
          },
          runId,
        ),
      onStep: (current, total, label): void =>
        this.events.post(
          "run.progress",
          chatId,
          {
            current,
            total,
            label: label ?? `Model step ${current} of ${total}`,
          },
          runId,
        ),
    };
  }

  private postToolCompleted(
    chatId: string,
    runId: string,
    result: ToolExecutionResult,
  ): void {
    this.events.post(
      "tool.completed",
      chatId,
      {
        toolCallId: result.toolCallId,
        name: result.name,
        ok: true,
        summary: summarizeToolResult(result),
      },
      runId,
    );
  }

  private createDeltaBatcher(chatId: string, runId: string): DeltaBatcher {
    return new DeltaBatcher((delta) =>
      this.events.post("assistant.delta", chatId, { delta }, runId),
    );
  }

  private async postContinuationOutcome(
    chatId: string,
    runId: string,
    changeSet: ChangeSet | null,
    undoRunId: string | null,
    autoApply: boolean,
  ): Promise<void> {
    if (changeSet) {
      await this.resolveProposedChanges(changeSet, autoApply);
      return;
    }
    this.events.post(
      "run.completed",
      chatId,
      {
        summary: "Changes applied; continuation completed",
        ...(undoRunId ? { undoRunId } : {}),
      },
      runId,
    );
  }

  private postApplyCompleted(
    request: Extract<PanelRequest, { type: "changes.apply" }>,
    result: ApplyResult,
  ): void {
    const counts = applyCounts(result);
    this.events.post(
      "run.completed",
      request.chatId,
      {
        summary: `Applied ${counts.applied}; conflicts ${counts.conflicts}`,
        ...(result.undoAvailable ? { undoRunId: request.runId } : {}),
      },
      request.runId,
    );
  }

  private postContinuationFailure(
    request: Extract<PanelRequest, { type: "changes.apply" }>,
    runId: string,
    applied: ApplyResult,
    error: unknown,
  ): void {
    const domain =
      error instanceof DomainError
        ? error
        : new DomainError("INTERNAL", "Unexpected continuation failure");
    this.events.post(
      "run.failed",
      request.chatId,
      { code: domain.code, message: domain.message },
      runId,
    );
    if (!applied.undoAvailable) return;
    this.events.post(
      "run.completed",
      request.chatId,
      {
        summary: "Changes applied; model continuation failed",
        undoRunId: request.runId,
      },
      runId,
    );
  }

  private async clearPending(
    chatId: string,
    runId: string,
    status: PersistedRunSummary["status"],
  ): Promise<void> {
    const chat = await requireChat(this.chats, chatId);
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

  private async retainAppliedReview(
    chatId: string,
    runId: string,
    result: ApplyResult,
  ): Promise<void> {
    const changeSet = this.changes.get(result.changeSetId);
    if (!changeSet) {
      await this.clearPending(chatId, runId, "applied");
      return;
    }
    const chat = await requireChat(this.chats, chatId);
    const parked = chat.parkedAppliedChangeSet;
    const retained = parked
      ? await this.mergeParkedIntoApplied(chatId, changeSet, parked)
      : changeSet;
    const reviewNoteId = await this.reviewNotes.openForChangeSet(
      retained,
      chat.title,
    );
    const reviewed = this.changes.attachReviewNote(retained.id, reviewNoteId);
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

  private async mergeParkedIntoApplied(
    chatId: string,
    applied: ChangeSet,
    parked: ChangeSet,
  ): Promise<ChangeSet> {
    await this.applier.mergeRollbacks(applied.runId, chatId, parked.runId);
    const merged = this.changes.absorbAppliedChanges(
      applied.id,
      parked.changes,
      { chatId, runId: applied.runId },
    );
    if (parked.id !== applied.id) this.changes.drop(parked.id);
    return merged;
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
    const merged = await this.mergeParkedIntoApplied(
      chatId,
      parkedWithoutNote,
      existing,
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

function requiresManualReview(changeSet: ChangeSet): boolean {
  return changeSet.changes.some(
    (change) => change.kind !== "file" && change.operation === "delete",
  );
}

function isUndoableApplied(change: ChangeSet["changes"][number]): boolean {
  if (change.status !== "applied") return false;
  if (change.kind === "file") return true;
  return change.operation === "update";
}

function automaticApplyRequest(
  changeSet: ChangeSet,
  applyToken: string,
): Extract<PanelRequest, { type: "changes.apply" }> {
  return {
    version: PROTOCOL_VERSION,
    messageId: randomUUID(),
    chatId: changeSet.chatId,
    runId: changeSet.runId,
    type: "changes.apply",
    payload: {
      changeSetId: changeSet.id,
      acceptedIds: changeSet.changes.map((change) => change.id),
      applyToken,
    },
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

function approvalSummary(result: ApplyResult, automatic: boolean): string {
  const details = result.changes.map((change) => ({
    target: change.targetLabel,
    status: change.status,
    ...(change.message ? { message: change.message } : {}),
  }));
  const policy = automatic
    ? "The chat's automatic application was enabled by the user."
    : "The user reviewed the proposed write batch.";
  return [
    policy,
    "Treat these execution results as authoritative and continue the task:",
    JSON.stringify(details),
  ].join("\n");
}
