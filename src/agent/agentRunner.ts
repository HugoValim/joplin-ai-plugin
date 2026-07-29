import {
  agentPlanContinuationNudge,
  type AgentPlan,
  type AgentPlanState,
} from "./agentPlan";
import type {
  AiProvider,
  NormalizedToolCall,
  ProviderMessage,
} from "../providers/types";
import type { ChangeSet, ChangeSetStore } from "../persistence/changeSetStore";
import { DomainError } from "../shared/errors";
import { StuckLoopDetector } from "./stuckLoopDetector";
import { SubAgentRegistry } from "./subAgentRegistry";
import {
  createNestedRunnerFactory,
  SubAgentHost,
} from "./subAgentHost";
import { executeAgentToolBatch } from "./agentToolBatch";
import {
  activateProposeOnlyIfNeeded,
  textOnlyBailoutMessage,
  withMissingProposalNotice,
  withStuckLoopNotice,
} from "./agentLoopPolicy";
import type {
  ToolRegistry,
  ToolExecutionContext,
  ToolExecutionResult,
  SubAgentSpawnResult,
} from "../tools/toolRegistry";

/** Safety only — not a normal stop for reorganization work. */
const MAX_MODEL_STEPS = 200;

export interface AgentRunRequest {
  readonly chatId: string;
  readonly runId: string;
  readonly messages: readonly ProviderMessage[];
  readonly hasFileWorkspace: boolean;
  readonly vault: boolean;
  readonly readOnly: boolean;
  readonly readableNoteIds: ReadonlySet<string>;
  readonly secretNotebookIds: ReadonlySet<string>;
  /** Caps model steps for this run; defaults to the global safety limit. */
  readonly maxModelSteps?: number;
  /** Nested helpers: expose only read tools (no meta/propose). */
  readonly helperOnly?: boolean;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AgentObserver {
  onTextDelta?(delta: string): void;
  onToolStarted?(call: NormalizedToolCall): void;
  onToolCompleted?(result: ToolExecutionResult): void;
  onPlanUpdated?(plan: AgentPlan): void;
  onStep?(current: number, total: number, label?: string): void;
}

export interface AgentRunOutcome {
  readonly status: "completed" | "awaiting-approval";
  readonly messages: readonly ProviderMessage[];
  readonly assistantText: string;
  readonly changeSet: ChangeSet | null;
  readonly continuation: AgentContinuation | null;
  readonly usage: TokenUsage | null;
  readonly toolNames: readonly string[];
}

export interface AgentContinuation {
  readonly messages: readonly ProviderMessage[];
  readonly nextStep: number;
  readonly toolCallCount: number;
  readonly plan: AgentPlan | null;
}

interface ModelStep {
  readonly text: string;
  readonly toolCalls: readonly NormalizedToolCall[];
}

export class AgentRunner {
  private readonly subAgentHost: SubAgentHost;

  public constructor(
    private readonly provider: AiProvider,
    private readonly tools: ToolRegistry,
    private readonly changes: ChangeSetStore,
    private readonly observer: AgentObserver = {},
    subAgents: SubAgentRegistry = new SubAgentRegistry(),
  ) {
    this.subAgentHost = new SubAgentHost(
      subAgents,
      createNestedRunnerFactory(provider, tools, changes, AgentRunner),
      observer,
    );
  }

  /**
   * Runs model/tool steps and pauses before every proposed write batch.
   *
   * @example await runner.run({ chatId, runId, messages, hasFileWorkspace }, signal)
   */
  public async run(
    request: AgentRunRequest,
    abortSignal: AbortSignal,
  ): Promise<AgentRunOutcome> {
    try {
      return await this.runFrom(
        request,
        [...request.messages],
        1,
        0,
        { plan: null },
        abortSignal,
      );
    } finally {
      this.subAgentHost.cancelAll();
    }
  }

  /**
   * Returns approval results to the model and resumes the original loop.
   *
   * @example await runner.resume(request, continuation, approvalSummary, signal)
   */
  public async resume(
    request: AgentRunRequest,
    continuation: AgentContinuation,
    approvalSummary: string,
    abortSignal: AbortSignal,
  ): Promise<AgentRunOutcome> {
    const planState: AgentPlanState = { plan: continuation.plan };
    const messages = [
      ...continuation.messages,
      { role: "user" as const, content: approvalSummary },
    ];
    const nudge = agentPlanContinuationNudge(planState.plan);
    if (nudge) messages.push({ role: "system", content: nudge });
    if (planState.plan) this.observer.onPlanUpdated?.(planState.plan);
    try {
      return await this.runFrom(
        request,
        messages,
        continuation.nextStep,
        continuation.toolCallCount,
        planState,
        abortSignal,
      );
    } finally {
      this.subAgentHost.cancelAll();
    }
  }

  private async runFrom(
    request: AgentRunRequest,
    messages: ProviderMessage[],
    firstStep: number,
    initialToolCallCount: number,
    planState: AgentPlanState,
    abortSignal: AbortSignal,
  ): Promise<AgentRunOutcome> {
    const maxSteps = request.maxModelSteps ?? MAX_MODEL_STEPS;
    const context = this.buildToolContext(request, planState, abortSignal);
    let toolCallCount = initialToolCallCount;
    let assistantText = "";
    let readCallsSincePropose = 0;
    let proposeOnly = false;
    let usage: TokenUsage | null = null;
    const toolNames: string[] = [];
    const loopDetector = new StuckLoopDetector();

    for (let step = firstStep; step <= maxSteps; step += 1) {
      assertNotAborted(abortSignal);
      this.observer.onStep?.(step, maxSteps);
      proposeOnly = activateProposeOnlyIfNeeded(
        proposeOnly,
        readCallsSincePropose,
        request.readOnly,
        this.tools,
        context,
        messages,
      );
      const modelStep = await this.runModelStep(
        messages,
        context,
        abortSignal,
        proposeOnly,
        request.readOnly,
        request.helperOnly === true,
      );
      usage = mergeUsage(usage, modelStep.usage);
      assistantText += modelStep.text;
      messages.push(toAssistantMessage(modelStep));
      if (context.agentPlan.plan && loopDetector.addStep(modelStep.text)) {
        this.observer.onStep?.(step, maxSteps);
        return completedOutcome(
          messages,
          withStuckLoopNotice(assistantText),
          usage,
          toolNames,
        );
      }
      if (!modelStep.toolCalls.length) {
        const bailout = textOnlyBailoutMessage(
          proposeOnly,
          request.readOnly,
          this.tools,
          context,
          toolNames,
        );
        if (bailout) {
          if (step >= maxSteps) {
            return completedOutcome(
              messages,
              withMissingProposalNotice(assistantText),
              usage,
              toolNames,
            );
          }
          messages.push(bailout);
          continue;
        }
        return completedOutcome(messages, assistantText, usage, toolNames);
      }
      toolCallCount += modelStep.toolCalls.length;
      const proposed = await executeAgentToolBatch({
        calls: modelStep.toolCalls,
        messages,
        context,
        abortSignal,
        proposeOnly,
        readOnly: request.readOnly,
        toolNames,
        tools: this.tools,
        observer: this.observer,
      });
      if (proposed) {
        return {
          status: "awaiting-approval",
          messages,
          assistantText,
          changeSet: this.changes.getByRun(request.runId),
          continuation: {
            messages,
            nextStep: step + 1,
            toolCallCount,
            plan: context.agentPlan.plan,
          },
          usage,
          toolNames,
        };
      }
      readCallsSincePropose += countContentReads(
        this.tools,
        modelStep.toolCalls,
      );
    }
    throw new DomainError(
      "LIMIT_EXCEEDED",
      `Agent exceeded ${maxSteps} model steps; expected completion within the loop limit`,
    );
  }

  private async runModelStep(
    messages: readonly ProviderMessage[],
    context: ToolExecutionContext,
    abortSignal: AbortSignal,
    proposeOnly: boolean,
    readOnly: boolean,
    helperOnly: boolean,
  ): Promise<ModelStep & { readonly usage: TokenUsage | null }> {
    let text = "";
    const toolCalls: NormalizedToolCall[] = [];
    let usage: TokenUsage | null = null;
    const stream = this.provider.streamChat(
      {
        messages,
        tools: this.tools.providerDefinitions(context, {
          proposeOnly,
          readOnly,
          helperOnly,
        }),
      },
      abortSignal,
    );
    for await (const event of stream) {
      if (event.type === "text-delta") {
        text += event.delta;
        this.observer.onTextDelta?.(event.delta);
      }
      if (event.type === "tool-calls") toolCalls.push(...event.calls);
      if (event.type === "usage") {
        usage = {
          promptTokens: event.promptTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
        };
      }
    }
    return { text, toolCalls, usage };
  }

  private buildToolContext(
    request: AgentRunRequest,
    agentPlan: AgentPlanState,
    abortSignal: AbortSignal,
  ): ToolExecutionContext {
    return {
      chatId: request.chatId,
      runId: request.runId,
      hasFileWorkspace: request.hasFileWorkspace,
      vault: request.vault,
      readOnly: request.readOnly,
      readableNoteIds: request.readableNoteIds,
      secretNotebookIds: request.secretNotebookIds,
      agentPlan,
      helperOnly: request.helperOnly,
      runSubAgent: request.readOnly || request.helperOnly
        ? undefined
        : (input): Promise<SubAgentSpawnResult> =>
            this.subAgentHost.run(input, request, abortSignal),
      abortSubAgent: request.readOnly || request.helperOnly
        ? undefined
        : (subAgentId): number => this.subAgentHost.abort(subAgentId),
    };
  }
}

function countContentReads(
  tools: ToolRegistry,
  calls: readonly NormalizedToolCall[],
): number {
  return calls.filter((call) => tools.countsTowardReadBudget(call.name)).length;
}

function toAssistantMessage(step: ModelStep): ProviderMessage {
  return {
    role: "assistant",
    content: step.text,
    ...(step.toolCalls.length ? { toolCalls: step.toolCalls } : {}),
  };
}

function completedOutcome(
  messages: readonly ProviderMessage[],
  assistantText: string,
  usage: TokenUsage | null,
  toolNames: readonly string[],
): AgentRunOutcome {
  return {
    status: "completed",
    messages,
    assistantText,
    changeSet: null,
    continuation: null,
    usage,
    toolNames,
  };
}

function mergeUsage(
  current: TokenUsage | null,
  next: TokenUsage | null,
): TokenUsage | null {
  if (!next) return current;
  if (!current) return next;
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
  };
}

function assertNotAborted(abortSignal: AbortSignal): void {
  if (!abortSignal.aborted) return;
  throw new DomainError("ABORTED", "Agent run cancelled", abortSignal.reason);
}
