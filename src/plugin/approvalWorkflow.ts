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
import { DomainError } from "../shared/errors";
import { PROTOCOL_VERSION, type PanelRequest } from "../shared/protocol";
import type { ToolExecutionResult, ToolRegistry } from "../tools/toolRegistry";
import {
  AgentContinuationStore,
  type PendingAgentContinuation,
} from "./agentContinuationStore";
import { persistRunOutcome, requireChat } from "./chatLifecycle";
import { toChangeSetView } from "./chatView";
import { DeltaBatcher } from "./deltaBatcher";
import type { PluginEventSender } from "./pluginEventSender";
import type { RunCancellationRegistry } from "./runCancellationRegistry";
import { summarizeToolResult } from "./toolActivity";

interface ContinuationProviderPort {
  connectWithConfirmation(): Promise<{ readonly provider: AiProvider }>;
}

export class ApprovalWorkflow {
  private readonly continuations = new AgentContinuationStore();

  public constructor(
    private readonly chats: ChatStore,
    private readonly changes: ChangeSetStore,
    private readonly applier: ChangeApplier,
    private readonly tools: ToolRegistry,
    private readonly providers: ContinuationProviderPort,
    private readonly events: PluginEventSender,
    private readonly activeRuns: RunCancellationRegistry,
  ) {}

  public remember(
    changeSet: ChangeSet | null,
    continuation: AgentContinuation | null,
    chatId: string,
    hasFileWorkspace: boolean,
    citations: readonly ContextCitation[],
  ): void {
    if (!changeSet || !continuation) return;
    this.continuations.save(changeSet.id, {
      chatId,
      hasFileWorkspace,
      continuation,
      citations,
    });
  }

  public abandonChat(chatId: string): void {
    this.continuations.deleteChat(chatId);
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
    if (autoApply && !requiresManualReview(changeSet)) {
      this.postAutomaticProgress(changeSet);
      await this.applyRequest(automaticApplyRequest(changeSet), true);
      return;
    }
    this.events.post(
      "changes.proposed",
      changeSet.chatId,
      toChangeSetView(changeSet),
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
    const result = await this.applier.apply(
      request.payload.changeSetId,
      request.payload.acceptedIds,
      { chatId: request.chatId, runId: request.runId },
    );
    await this.clearPending(request.chatId, request.runId, "applied");
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
      onStep: (current, total): void =>
        this.events.post(
          "run.progress",
          chatId,
          { current, total, label: `Model step ${current} of ${total}` },
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
    const runSummaries = chat.runSummaries.map((summary) =>
      summary.runId === runId ? { ...summary, status } : summary,
    );
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      runSummaries,
      pendingChangeSet: null,
    });
  }
}

function requiresManualReview(changeSet: ChangeSet): boolean {
  return changeSet.changes.some(
    (change) => "operation" in change && change.operation === "delete",
  );
}

function automaticApplyRequest(
  changeSet: ChangeSet,
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
