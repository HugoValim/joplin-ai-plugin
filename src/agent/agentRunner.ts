import {
  agentPlanContinuationNudge,
  pendingAgentPlanCount,
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
import type {
  ToolRegistry,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../tools/toolRegistry";

/** Safety only — not a normal stop for reorganization work. */
const MAX_MODEL_STEPS = 200;
/** After this many content-body reads without a proposal, force propose-write only. */
const READ_BUDGET_TOOL_CALLS = 8;

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
  onStep?(current: number, total: number): void;
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
    const context = toolContext(request, planState);
    let toolCallCount = initialToolCallCount;
    let assistantText = "";
    let readCallsSincePropose = 0;
    let proposeOnly = false;
    let usage: TokenUsage | null = null;
    const toolNames: string[] = [];

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
      );
      usage = mergeUsage(usage, modelStep.usage);
      assistantText += modelStep.text;
      messages.push(toAssistantMessage(modelStep));
      if (!modelStep.toolCalls.length) {
        const bailout = textOnlyBailoutMessage(
          proposeOnly,
          request.readOnly,
          this.tools,
          context,
          toolNames,
        );
        if (bailout) {
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
      toolCallCount += modelStep.toolCalls.length;
      const proposed = await this.executeTools(
        modelStep.toolCalls,
        messages,
        context,
        abortSignal,
        proposeOnly,
        request.readOnly,
        toolNames,
      );
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
      `Agent exceeded ${MAX_MODEL_STEPS} model steps; expected completion within the loop limit`,
    );
  }

  private async runModelStep(
    messages: readonly ProviderMessage[],
    context: ToolExecutionContext,
    abortSignal: AbortSignal,
    proposeOnly: boolean,
    readOnly: boolean,
  ): Promise<ModelStep & { readonly usage: TokenUsage | null }> {
    let text = "";
    const toolCalls: NormalizedToolCall[] = [];
    let usage: TokenUsage | null = null;
    const stream = this.provider.streamChat(
      {
        messages,
        tools: this.tools.providerDefinitions(context, { proposeOnly, readOnly }),
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

  private async executeTools(
    calls: readonly NormalizedToolCall[],
    messages: ProviderMessage[],
    context: ToolExecutionContext,
    abortSignal: AbortSignal,
    proposeOnly: boolean,
    readOnly: boolean,
    toolNames: string[],
  ): Promise<boolean> {
    let proposed = false;
    for (const call of calls) {
      assertNotAborted(abortSignal);
      this.observer.onToolStarted?.(call);
      const result = await this.executeOneTool(
        call,
        context,
        proposeOnly,
        readOnly,
      );
      toolNames.push(call.name);
      this.observer.onToolCompleted?.(result);
      if (result.risk === "meta" && context.agentPlan.plan) {
        this.observer.onPlanUpdated?.(context.agentPlan.plan);
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(result.output),
      });
      if (result.risk === "propose-write") proposed = true;
    }
    return proposed;
  }

  private async executeOneTool(
    call: NormalizedToolCall,
    context: ToolExecutionContext,
    proposeOnly: boolean,
    readOnly: boolean,
  ): Promise<ToolExecutionResult> {
    try {
      if (readOnly && this.tools.riskFor(call.name) === "propose-write") {
        return {
          toolCallId: call.id,
          name: call.name,
          risk: "propose-write",
          output: {
            error: {
              code: "NOT_AVAILABLE",
              message: `Write tool ${call.name} is disabled in Ask mode; expected a read-only tool`,
            },
          },
        };
      }
      if (proposeOnly) {
        const risk = this.tools.riskFor(call.name);
        if (risk === "read") {
          return {
            toolCallId: call.id,
            name: call.name,
            risk: "read",
            output: {
              error: {
                code: "NOT_AVAILABLE",
                message: `Read tool ${call.name} is disabled after the read budget; expected a propose-write tool`,
              },
            },
          };
        }
      }
      return await this.tools.execute(call, context);
    } catch (error: unknown) {
      return toolFailureResult(call, error);
    }
  }
}

function toolContext(
  request: AgentRunRequest,
  agentPlan: AgentPlanState,
): ToolExecutionContext {
  return {
    chatId: request.chatId,
    runId: request.runId,
    hasFileWorkspace: request.hasFileWorkspace,
    vault: request.vault,
    readableNoteIds: request.readableNoteIds,
    secretNotebookIds: request.secretNotebookIds,
    agentPlan,
  };
}

function countContentReads(
  tools: ToolRegistry,
  calls: readonly NormalizedToolCall[],
): number {
  return calls.filter((call) => tools.countsTowardReadBudget(call.name)).length;
}

function activateProposeOnlyIfNeeded(
  proposeOnly: boolean,
  readCallsSincePropose: number,
  readOnly: boolean,
  tools: ToolRegistry,
  context: ToolExecutionContext,
  messages: ProviderMessage[],
): boolean {
  if (readOnly) return false;
  if (proposeOnly) return true;
  if (readCallsSincePropose < READ_BUDGET_TOOL_CALLS) return false;
  if (!hasProposeWriteTools(tools, context)) return false;
  messages.push(readBudgetNudgeMessage(tools, context));
  return true;
}

function readBudgetNudgeMessage(
  tools: ToolRegistry,
  context: ToolExecutionContext,
): ProviderMessage {
  const content = hasProposeWriteTools(tools, context)
    ? [
        "READ BUDGET EXCEEDED: Note and file body reads are disabled for the rest of this run segment.",
        "Call the available propose-write tools now for notes already read in this segment.",
        "Update the agent plan for completed items. Do not ask the user for opaque ID lists.",
      ].join(" ")
    : [
        "READ BUDGET: You have completed several content reads without proposing changes.",
        "Secret notebooks are excluded. Mark notebooks secret to hide them, or attach notes to seed prompt context.",
        "Do not ask the user to paste notebook or note ID lists.",
      ].join(" ");
  return { role: "system", content };
}

function proposeRequiredMessage(): ProviderMessage {
  return {
    role: "system",
    content: [
      "PROPOSE REQUIRED: Do not end with a chat-only text plan.",
      "Call propose-write tools now so ChangeReview can open, or update the agent plan and propose the next bounded batch.",
    ].join(" "),
  };
}

function planRequiredMessage(): ProviderMessage {
  return {
    role: "system",
    content: [
      "PLAN REQUIRED: You inventoried multiple notebooks or notes.",
      "Call set_agent_plan now with a checklist of remaining work,",
      "then read a few note bodies and call propose-write tools for the first batch.",
      "Do not stop or ask the user to continue before the plan and first proposal batch.",
    ].join(" "),
  };
}

function planInProgressMessage(): ProviderMessage {
  return {
    role: "system",
    content: [
      "PLAN IN PROGRESS: An agent plan still has pending items.",
      "Do not stop with chat-only text. Mark progress with update_agent_plan_item,",
      "read the next pending note bodies, and call propose-write tools for a bounded batch now.",
    ].join(" "),
  };
}

function textOnlyBailoutMessage(
  proposeOnly: boolean,
  readOnly: boolean,
  tools: ToolRegistry,
  context: ToolExecutionContext,
  toolNames: readonly string[],
): ProviderMessage | null {
  if (readOnly) return null;
  if (shouldRefuseProposeBailout(proposeOnly, tools, context)) {
    return proposeRequiredMessage();
  }
  if (shouldRefusePendingPlanBailout(context, tools)) {
    return planInProgressMessage();
  }
  if (shouldRefuseDiscoveryBailout(toolNames, context, tools)) {
    return planRequiredMessage();
  }
  return null;
}

function shouldRefuseProposeBailout(
  proposeOnly: boolean,
  tools: ToolRegistry,
  context: ToolExecutionContext,
): boolean {
  return proposeOnly && hasProposeWriteTools(tools, context);
}

function shouldRefusePendingPlanBailout(
  context: ToolExecutionContext,
  tools: ToolRegistry,
): boolean {
  if (!hasProposeWriteTools(tools, context)) return false;
  return pendingAgentPlanCount(context.agentPlan.plan) > 0;
}

/**
 * After inventory across notebooks, refuse chat-only stops until a plan exists.
 * Pure list_notebooks (no note listing) still allowed to complete.
 */
function shouldRefuseDiscoveryBailout(
  toolNames: readonly string[],
  context: ToolExecutionContext,
  tools: ToolRegistry,
): boolean {
  if (context.agentPlan.plan) return false;
  if (toolNames.includes("set_agent_plan")) return false;
  if (!hasAgentPlanTools(tools, context)) return false;
  return isSignificantDiscovery(toolNames);
}

function isSignificantDiscovery(toolNames: readonly string[]): boolean {
  const noteLists = toolNames.filter(
    (name) => name === "list_notebook_notes",
  ).length;
  if (noteLists >= 2) return true;
  return (
    toolNames.includes("list_notebooks") &&
    toolNames.includes("list_notebook_notes")
  );
}

function hasAgentPlanTools(
  tools: ToolRegistry,
  context: ToolExecutionContext,
): boolean {
  return tools
    .providerDefinitions(context)
    .some((tool) => tool.name === "set_agent_plan");
}

function withMissingProposalNotice(assistantText: string): string {
  const notice =
    "No propose-write tools were called, so ChangeReview did not open. Ask again to apply the changes.";
  const trimmed = assistantText.trim();
  return trimmed ? `${trimmed}\n\n${notice}` : notice;
}

function hasProposeWriteTools(
  tools: ToolRegistry,
  context: ToolExecutionContext,
): boolean {
  return tools.hasProposeWriteTools(context);
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

function toolFailureResult(
  call: NormalizedToolCall,
  error: unknown,
): ToolExecutionResult {
  if (error instanceof DomainError && shouldRethrowToolError(error)) {
    throw error;
  }
  const failure =
    error instanceof DomainError
      ? error
      : new DomainError("INTERNAL", "Unexpected tool failure", error);
  return {
    toolCallId: call.id,
    name: call.name,
    risk: "read",
    output: {
      error: {
        code: failure.code,
        message: failure.message,
      },
    },
  };
}

function shouldRethrowToolError(error: DomainError): boolean {
  return error.code === "ABORTED" || error.code === "LIMIT_EXCEEDED";
}
