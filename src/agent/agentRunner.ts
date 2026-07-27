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

const MAX_MODEL_STEPS = 24;
const MAX_TOOL_CALLS = 100;

export interface AgentRunRequest {
  readonly chatId: string;
  readonly runId: string;
  readonly messages: readonly ProviderMessage[];
  readonly hasFileWorkspace: boolean;
}

export interface AgentObserver {
  onTextDelta?(delta: string): void;
  onToolStarted?(call: NormalizedToolCall): void;
  onToolCompleted?(result: ToolExecutionResult): void;
  onStep?(current: number, total: number): void;
}

export interface AgentRunOutcome {
  readonly status: "completed" | "awaiting-approval";
  readonly messages: readonly ProviderMessage[];
  readonly assistantText: string;
  readonly changeSet: ChangeSet | null;
  readonly continuation: AgentContinuation | null;
}

export interface AgentContinuation {
  readonly messages: readonly ProviderMessage[];
  readonly nextStep: number;
  readonly toolCallCount: number;
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
   * Runs bounded model/tool steps and pauses before every proposed write batch.
   *
   * @example await runner.run({ chatId, runId, messages, hasFileWorkspace }, signal)
   */
  public async run(
    request: AgentRunRequest,
    abortSignal: AbortSignal,
  ): Promise<AgentRunOutcome> {
    return this.runFrom(request, [...request.messages], 1, 0, abortSignal);
  }

  /**
   * Returns approval results to the model and resumes the original bounded loop.
   *
   * @example await runner.resume(request, continuation, approvalSummary, signal)
   */
  public async resume(
    request: AgentRunRequest,
    continuation: AgentContinuation,
    approvalSummary: string,
    abortSignal: AbortSignal,
  ): Promise<AgentRunOutcome> {
    const messages = [
      ...continuation.messages,
      { role: "user" as const, content: approvalSummary },
    ];
    return this.runFrom(
      request,
      messages,
      continuation.nextStep,
      continuation.toolCallCount,
      abortSignal,
    );
  }

  private async runFrom(
    request: AgentRunRequest,
    messages: ProviderMessage[],
    firstStep: number,
    initialToolCallCount: number,
    abortSignal: AbortSignal,
  ): Promise<AgentRunOutcome> {
    const context = toolContext(request);
    let toolCallCount = initialToolCallCount;
    let assistantText = "";

    for (let step = firstStep; step <= MAX_MODEL_STEPS; step += 1) {
      assertNotAborted(abortSignal);
      this.observer.onStep?.(step, MAX_MODEL_STEPS);
      const modelStep = await this.runModelStep(messages, context, abortSignal);
      assistantText += modelStep.text;
      messages.push(toAssistantMessage(modelStep));
      if (!modelStep.toolCalls.length) {
        return completedOutcome(messages, assistantText);
      }
      toolCallCount += modelStep.toolCalls.length;
      assertToolLimit(toolCallCount);
      const proposed = await this.executeTools(
        modelStep.toolCalls,
        messages,
        context,
        abortSignal,
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
          },
        };
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
  ): Promise<ModelStep> {
    let text = "";
    const toolCalls: NormalizedToolCall[] = [];
    const stream = this.provider.streamChat(
      { messages, tools: this.tools.providerDefinitions(context) },
      abortSignal,
    );
    for await (const event of stream) {
      if (event.type === "text-delta") {
        text += event.delta;
        this.observer.onTextDelta?.(event.delta);
      }
      if (event.type === "tool-calls") toolCalls.push(...event.calls);
    }
    return { text, toolCalls };
  }

  private async executeTools(
    calls: readonly NormalizedToolCall[],
    messages: ProviderMessage[],
    context: ToolExecutionContext,
    abortSignal: AbortSignal,
  ): Promise<boolean> {
    let proposed = false;
    for (const call of calls) {
      assertNotAborted(abortSignal);
      this.observer.onToolStarted?.(call);
      const result = await this.tools.execute(call, context);
      this.observer.onToolCompleted?.(result);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(result.output),
      });
      if (result.risk === "propose-write") proposed = true;
    }
    return proposed;
  }
}

function toolContext(request: AgentRunRequest): ToolExecutionContext {
  return {
    chatId: request.chatId,
    runId: request.runId,
    hasFileWorkspace: request.hasFileWorkspace,
  };
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
): AgentRunOutcome {
  return {
    status: "completed",
    messages,
    assistantText,
    changeSet: null,
    continuation: null,
  };
}

function assertToolLimit(toolCallCount: number): void {
  if (toolCallCount <= MAX_TOOL_CALLS) return;
  throw new DomainError(
    "LIMIT_EXCEEDED",
    `Agent attempted ${toolCallCount} tool calls; expected at most ${MAX_TOOL_CALLS}`,
  );
}

function assertNotAborted(abortSignal: AbortSignal): void {
  if (!abortSignal.aborted) return;
  throw new DomainError("ABORTED", "Agent run cancelled", abortSignal.reason);
}
