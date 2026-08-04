import {
  AgentRunner,
  type AgentContinuation,
  type AgentObserver,
  type AgentRunOutcome,
  type AgentRunRequest,
} from "../agent/agentRunner";
import type { ContextCitation } from "../agent/contextBuilder";
import type { ChangeSetStore } from "../persistence/changeSetStore";
import type { ChatStore, PersistedChat } from "../persistence/chatStore";
import type { AiProvider } from "../providers/types";
import { DomainError, safeValue } from "../shared/errors";
import type { ToolExecutionResult, ToolRegistry } from "../tools/toolRegistry";
import { persistRunOutcome, requireChat } from "./chatLifecycle";
import { DeltaBatcher } from "./deltaBatcher";
import type { PluginEventSender } from "./pluginEventSender";
import type { RunCancellationRegistry } from "./runCancellationRegistry";
import { summarizeToolResult } from "./toolActivity";

type ModelRunRequest = Omit<AgentRunRequest, "chatId" | "runId">;

export interface PreparedInitialModelRun {
  readonly provider: AiProvider;
  readonly submittedChat: PersistedChat;
  readonly citations: readonly ContextCitation[];
  readonly request: ModelRunRequest;
}

export interface StartModelRunInput<
  Prepared extends PreparedInitialModelRun = PreparedInitialModelRun,
> {
  readonly chatId: string;
  readonly runId: string;
  readonly prepare: (abortSignal: AbortSignal) => Promise<Prepared>;
  readonly onOutcome: (
    outcome: AgentRunOutcome,
    prepared: Prepared,
  ) => Promise<void>;
  readonly onActivity?: () => void;
  readonly onFailure?: (failure: DomainError) => Promise<void> | void;
}

export interface PreparedContinuationModelRun {
  readonly provider: AiProvider;
  readonly request: ModelRunRequest;
}

export interface ResumeModelRunInput {
  readonly chatId: string;
  readonly runId: string;
  readonly continuation: AgentContinuation;
  readonly approvalSummary: string;
  readonly citations: readonly ContextCitation[];
  readonly prepare: (
    abortSignal: AbortSignal,
  ) => Promise<PreparedContinuationModelRun>;
  readonly onOutcome: (outcome: AgentRunOutcome) => Promise<void>;
  readonly onActivity?: () => void;
  readonly onFailure?: (failure: DomainError) => Promise<void> | void;
}

interface ModelRunIdentity {
  readonly chatId: string;
  readonly runId: string;
  readonly onActivity?: () => void;
}

export class ModelRunLifecycle {
  public constructor(
    private readonly chats: ChatStore,
    private readonly tools: ToolRegistry,
    private readonly changes: ChangeSetStore,
    private readonly events: PluginEventSender,
    private readonly activeRuns: RunCancellationRegistry,
  ) {}

  /** Starts and owns one initial model run. Example: lifecycle.start(input). */
  public async start<Prepared extends PreparedInitialModelRun>(
    input: StartModelRunInput<Prepared>,
  ): Promise<void> {
    const controller = new AbortController();
    this.registerInitialRun(input, controller);
    await this.ownRun(
      input,
      controller,
      async (deltas) => {
        const prepared = await input.prepare(controller.signal);
        const outcome = await this.runInitial(
          input,
          prepared,
          controller,
          deltas,
        );
        await input.onOutcome(outcome, prepared);
      },
      async (error) =>
        this.handleInitialFailure(input, normalizeInitialFailure(error)),
    );
  }

  /** Resumes and owns one approved model continuation. Example: lifecycle.resume(input). */
  public async resume(input: ResumeModelRunInput): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.replace(input.chatId, input.runId, controller);
    this.postRunStarted(input);
    await this.ownRun(
      input,
      controller,
      async (deltas) => {
        const prepared = await input.prepare(controller.signal);
        const outcome = await this.runContinuation(
          input,
          prepared,
          controller,
          deltas,
        );
        await input.onOutcome(outcome);
      },
      async (error) =>
        this.notifyFailure(input, normalizeContinuationFailure(error)),
    );
  }

  private async ownRun(
    input: ModelRunIdentity,
    controller: AbortController,
    execute: (deltas: DeltaBatcher) => Promise<void>,
    fail: (error: unknown) => Promise<void>,
  ): Promise<void> {
    const deltas = this.createDeltas(input.chatId, input.runId);
    try {
      await execute(deltas);
    } catch (error: unknown) {
      deltas.flush();
      await fail(error);
    } finally {
      deltas.dispose();
      this.activeRuns.clearIfCurrent(input.chatId, controller);
    }
  }

  private async handleInitialFailure(
    input: ModelRunIdentity & {
      readonly onFailure?: (failure: DomainError) => Promise<void> | void;
    },
    failure: DomainError,
  ): Promise<void> {
    const chat = await this.chats.get(input.chatId);
    if (chat) {
      await this.chats.save({
        ...chat,
        updatedAt: Date.now(),
        runSummaries: [
          ...chat.runSummaries,
          {
            runId: input.runId,
            status: failure.code === "ABORTED" ? "cancelled" : "failed",
            summary: failure.message,
            completedAt: Date.now(),
          },
        ],
      });
    }
    await this.notifyFailure(input, failure);
  }

  private async notifyFailure(
    input: ModelRunIdentity & {
      readonly onFailure?: (failure: DomainError) => Promise<void> | void;
    },
    failure: DomainError,
  ): Promise<void> {
    this.events.post(
      "run.failed",
      input.chatId,
      { code: failure.code, message: failure.message },
      input.runId,
    );
    await input.onFailure?.(failure);
  }

  private registerInitialRun(
    input: ModelRunIdentity,
    controller: AbortController,
  ): void {
    if (!this.activeRuns.tryStart(input.chatId, input.runId, controller)) {
      throw new DomainError(
        "CONFLICT",
        `Chat ${safeValue(input.chatId)} already has an active run; expected one run at a time`,
      );
    }
    this.postRunStarted(input);
  }

  private postRunStarted(input: ModelRunIdentity): void {
    this.events.post(
      "run.started",
      input.chatId,
      { startedAt: Date.now() },
      input.runId,
    );
  }

  private async runInitial(
    input: ModelRunIdentity,
    prepared: PreparedInitialModelRun,
    controller: AbortController,
    deltas: DeltaBatcher,
  ): Promise<AgentRunOutcome> {
    const runner = new AgentRunner(
      prepared.provider,
      this.tools,
      this.changes,
      this.observer(input, deltas),
    );
    const outcome = await runner.run(
      { ...prepared.request, chatId: input.chatId, runId: input.runId },
      controller.signal,
    );
    deltas.flush();
    await persistRunOutcome(
      this.chats,
      prepared.submittedChat,
      input.runId,
      outcome,
      prepared.citations,
    );
    return outcome;
  }

  private async runContinuation(
    input: ResumeModelRunInput,
    prepared: PreparedContinuationModelRun,
    controller: AbortController,
    deltas: DeltaBatcher,
  ): Promise<AgentRunOutcome> {
    const runner = new AgentRunner(
      prepared.provider,
      this.tools,
      this.changes,
      this.observer(input, deltas),
    );
    const request = {
      ...prepared.request,
      chatId: input.chatId,
      runId: input.runId,
    };
    const outcome = await runner.resume(
      request,
      input.continuation,
      input.approvalSummary,
      controller.signal,
    );
    deltas.flush();
    const chat = await requireChat(this.chats, input.chatId);
    await persistRunOutcome(
      this.chats,
      chat,
      input.runId,
      outcome,
      input.citations,
    );
    return outcome;
  }

  private observer(
    input: ModelRunIdentity,
    deltas: DeltaBatcher,
  ): AgentObserver {
    return {
      onTextDelta: (delta): void => {
        input.onActivity?.();
        deltas.push(delta);
      },
      onToolStarted: (call): void => {
        input.onActivity?.();
        this.events.post(
          "tool.started",
          input.chatId,
          { toolCallId: call.id, name: call.name },
          input.runId,
        );
      },
      onToolCompleted: (result): void =>
        this.postToolCompleted(input.chatId, input.runId, result),
      onPlanUpdated: (plan): void => {
        input.onActivity?.();
        this.events.post(
          "run.plan",
          input.chatId,
          { items: plan.items },
          input.runId,
        );
      },
      onStep: (current, total, label): void => {
        input.onActivity?.();
        this.postProgress(input, current, total, label);
      },
    };
  }

  private postProgress(
    input: ModelRunIdentity,
    current: number,
    total: number,
    label?: string,
  ): void {
    this.events.post(
      "run.progress",
      input.chatId,
      { current, total, label: label ?? `Model step ${current} of ${total}` },
      input.runId,
    );
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

  private createDeltas(chatId: string, runId: string): DeltaBatcher {
    return new DeltaBatcher((delta) =>
      this.events.post("assistant.delta", chatId, { delta }, runId),
    );
  }
}

function normalizeInitialFailure(error: unknown): DomainError {
  return error instanceof DomainError
    ? error
    : new DomainError("PROVIDER", "Unexpected agent failure", error);
}

function normalizeContinuationFailure(error: unknown): DomainError {
  return error instanceof DomainError
    ? error
    : new DomainError("INTERNAL", "Unexpected continuation failure", error);
}
