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
import { executeAgentToolBatch } from "./agentToolBatch";
import {
  bootstrapPlanFromInventory,
  planBootstrappedNudge,
} from "./inventoryPlanBootstrap";
import {
  activateProposeOnlyIfNeeded,
  isPlanRequiredBailout,
  MAX_TEXT_ONLY_BAILOUTS,
  needsAgentPlanAfterDiscovery,
  PLAN_REQUIRED_BOOTSTRAP_AFTER,
  planRequiredNudge,
  textOnlyBailoutMessage,
  withBailoutExhaustedNotice,
  withMissingProposalNotice,
  withStuckLoopNotice,
} from "./agentLoopPolicy";
import type {
  ToolRegistry,
  ToolExecutionContext,
  ToolExecutionResult,
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
  public constructor(
    private readonly provider: AiProvider,
    private readonly tools: ToolRegistry,
    private readonly changes: ChangeSetStore,
    private readonly observer: AgentObserver = {},
  ) {}

  /**
   * Runs model/tool steps and pauses before every proposed write batch.
   *
   * @example await runner.run({ chatId, runId, messages, hasFileWorkspace }, signal)
   */
  public async run(
    request: AgentRunRequest,
    abortSignal: AbortSignal,
  ): Promise<AgentRunOutcome> {
    return this.runFrom(
      request,
      [...request.messages],
      1,
      0,
      { plan: null },
      abortSignal,
    );
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
    return this.runFrom(
      request,
      messages,
      continuation.nextStep,
      continuation.toolCallCount,
      planState,
      abortSignal,
    );
  }

  private async runFrom(
    request: AgentRunRequest,
    messages: ProviderMessage[],
    firstStep: number,
    initialToolCallCount: number,
    planState: AgentPlanState,
    abortSignal: AbortSignal,
  ): Promise<AgentRunOutcome> {
    const context = this.buildToolContext(request, planState);
    let toolCallCount = initialToolCallCount;
    let assistantText = "";
    let readCallsSincePropose = 0;
    let proposeOnly = false;
    let blockDiscovery = false;
    let textOnlyBailouts = 0;
    let usage: TokenUsage | null = null;
    const toolNames: string[] = [];
    const loopDetector = new StuckLoopDetector();

    for (let step = firstStep; step <= MAX_MODEL_STEPS; step += 1) {
      assertNotAborted(abortSignal);
      this.observer.onStep?.(step, MAX_MODEL_STEPS);
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
        blockDiscovery,
      );
      usage = mergeUsage(usage, modelStep.usage);
      assistantText += modelStep.text;
      messages.push(toAssistantMessage(modelStep));
      if (
        context.agentPlan.plan &&
        modelStep.toolCalls.length &&
        loopDetector.addStep(modelStep.text)
      ) {
        this.observer.onStep?.(step, MAX_MODEL_STEPS);
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
          // Post-inventory: stop further listing and give a fresh bailout budget.
          if (
            !blockDiscovery &&
            !request.readOnly &&
            isPlanRequiredBailout(bailout)
          ) {
            blockDiscovery = true;
            textOnlyBailouts = 0;
            messages.push(bailout);
            continue;
          }
          textOnlyBailouts += 1;
          if (
            isPlanRequiredBailout(bailout) &&
            textOnlyBailouts >= PLAN_REQUIRED_BOOTSTRAP_AFTER &&
            !context.agentPlan.plan
          ) {
            const bootstrapped = tryBootstrapInventoryPlan(
              messages,
              context,
              this.observer,
            );
            if (bootstrapped) {
              blockDiscovery = true;
              textOnlyBailouts = 0;
              continue;
            }
          }
          if (context.agentPlan.plan && loopDetector.addTextOnlyStep()) {
            this.observer.onStep?.(step, MAX_MODEL_STEPS);
            return completedOutcome(
              messages,
              withStuckLoopNotice(assistantText),
              usage,
              toolNames,
            );
          }
          // Keep nudging PLAN REQUIRED; only exhaust propose/plan-in-progress loops.
          if (
            textOnlyBailouts >= MAX_TEXT_ONLY_BAILOUTS &&
            !isPlanRequiredBailout(bailout)
          ) {
            return completedOutcome(
              messages,
              withBailoutExhaustedNotice(assistantText),
              usage,
              toolNames,
            );
          }
          if (step >= MAX_MODEL_STEPS) {
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
      textOnlyBailouts = 0;
      toolCallCount += modelStep.toolCalls.length;
      const batch = await executeAgentToolBatch({
        calls: modelStep.toolCalls,
        messages,
        context,
        abortSignal,
        proposeOnly,
        readOnly: request.readOnly,
        blockDiscovery,
        toolNames,
        tools: this.tools,
        observer: this.observer,
      });
      if (batch.discoveryCapped) blockDiscovery = true;
      if (batch.proposed) {
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
      readCallsSincePropose += batch.contentReadCount;
      // After large inventory, block more listing and require a plan next.
      if (
        !blockDiscovery &&
        !request.readOnly &&
        needsAgentPlanAfterDiscovery(toolNames, context, this.tools)
      ) {
        blockDiscovery = true;
        messages.push(planRequiredNudge());
      }
    }
    throw new DomainError(
      "LIMIT_EXCEEDED",
      `Agent exceeded ${MAX_MODEL_STEPS} model steps; expected completion within the loop limit`,
    );
  }

  private async runModelStep(
    messages: readonly ProviderMessage[],
    context: ToolExecutionContext,
    abortSignal: AbortSignal,
    proposeOnly: boolean,
    readOnly: boolean,
    blockDiscovery: boolean,
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
          blockDiscovery,
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
    };
  }
}

function tryBootstrapInventoryPlan(
  messages: ProviderMessage[],
  context: ToolExecutionContext,
  observer: AgentObserver,
): boolean {
  const plan = bootstrapPlanFromInventory(messages);
  if (!plan) return false;
  context.agentPlan.plan = plan;
  observer.onPlanUpdated?.(plan);
  messages.push(planBootstrappedNudge(plan.items.length));
  return true;
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
