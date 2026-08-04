import { randomUUID } from "crypto";
import type {
  AgentContinuation,
  AgentRunOutcome,
  AgentRunRequest,
} from "../agent/agentRunner";
import type { ApplyResult } from "../agent/changeApplier";
import type { ContextCitation } from "../agent/contextBuilder";
import type { ChangeSet } from "../persistence/changeSetStore";
import type {
  ChangeSetApplyInput,
  ChangeSetApplyResult,
} from "../persistence/changeSetLifecycle";
import type { ChatStore } from "../persistence/chatStore";
import type { AiProvider } from "../providers/types";
import {
  AgentContinuationStore,
  type PendingAgentContinuation,
} from "./agentContinuationStore";
import { requireChat } from "./chatLifecycle";
import type { ModelRunLifecycle } from "./modelRunLifecycle";
import type { PluginEventSender } from "./pluginEventSender";

export interface ContinuationProviderPort {
  connectWithConfirmation(): Promise<{ readonly provider: AiProvider }>;
}

type ProposalResolver = (
  changeSet: ChangeSet,
  autoApply: boolean,
) => Promise<void>;

export class ApprovalContinuation {
  private readonly pending = new AgentContinuationStore();

  public constructor(
    private readonly chats: ChatStore,
    private readonly providers: ContinuationProviderPort,
    private readonly events: PluginEventSender,
    private readonly modelRuns: ModelRunLifecycle,
    private readonly resolveProposal: ProposalResolver,
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
    this.pending.save(changeSet.id, {
      chatId,
      hasFileWorkspace,
      vault,
      readableNoteIds,
      secretNotebookIds,
      continuation,
      citations,
    });
  }

  public delete(changeSetId: string): void {
    this.pending.delete(changeSetId);
  }

  public deleteChat(chatId: string): void {
    this.pending.deleteChat(chatId);
  }

  public async continueAfterApply(
    input: ChangeSetApplyInput,
    applied: ChangeSetApplyResult,
  ): Promise<boolean> {
    const continuation = this.pending.take(input.changeSetId);
    if (!continuation) return false;
    await this.resume(input, continuation, applied);
    return true;
  }

  private async resume(
    input: ChangeSetApplyInput,
    pending: PendingAgentContinuation,
    applied: ApplyResult,
  ): Promise<void> {
    const runId = randomUUID();
    await this.modelRuns.resume({
      chatId: input.chatId,
      runId,
      continuation: pending.continuation,
      approvalSummary: approvalSummary(applied, input.automatic),
      citations: pending.citations,
      prepare: async () => this.prepare(pending),
      onOutcome: async (outcome) =>
        this.handleOutcome(input, pending, applied, runId, outcome),
      onFailure: () => this.postCompensation(input, runId, applied),
    });
  }

  private async prepare(pending: PendingAgentContinuation): Promise<{
    readonly provider: AiProvider;
    readonly request: Omit<AgentRunRequest, "chatId" | "runId">;
  }> {
    const { provider } = await this.providers.connectWithConfirmation();
    return { provider, request: continuationRunRequest(pending) };
  }

  private async handleOutcome(
    input: ChangeSetApplyInput,
    pending: PendingAgentContinuation,
    applied: ApplyResult,
    runId: string,
    outcome: AgentRunOutcome,
  ): Promise<void> {
    const chat = await requireChat(this.chats, pending.chatId);
    this.rememberOutcome(outcome, pending);
    await this.postOutcome(
      pending.chatId,
      runId,
      outcome.changeSet,
      applied.undoAvailable ? input.runId : null,
      chat.context.autoApply,
    );
  }

  private rememberOutcome(
    outcome: AgentRunOutcome,
    pending: PendingAgentContinuation,
  ): void {
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
  }

  private async postOutcome(
    chatId: string,
    runId: string,
    changeSet: ChangeSet | null,
    undoRunId: string | null,
    autoApply: boolean,
  ): Promise<void> {
    if (changeSet) return this.resolveProposal(changeSet, autoApply);
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

  private postCompensation(
    input: ChangeSetApplyInput,
    runId: string,
    applied: ApplyResult,
  ): void {
    if (!applied.undoAvailable) return;
    this.events.post(
      "run.completed",
      input.chatId,
      {
        summary: "Changes applied; model continuation failed",
        undoRunId: input.runId,
      },
      runId,
    );
  }
}

function continuationRunRequest(
  pending: PendingAgentContinuation,
): Omit<AgentRunRequest, "chatId" | "runId"> {
  return {
    messages: [],
    hasFileWorkspace: pending.hasFileWorkspace,
    vault: pending.vault,
    readOnly: false,
    readableNoteIds: pending.readableNoteIds,
    secretNotebookIds: pending.secretNotebookIds,
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
