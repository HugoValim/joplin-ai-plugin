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
const READ_BUDGET_NUDGE_THRESHOLD = 4;

export interface AgentRunRequest {
  readonly chatId: string;
  readonly runId: string;
  readonly messages: readonly ProviderMessage[];
  readonly hasFileWorkspace: boolean;
  readonly vault: boolean;
  readonly readableNoteIds: ReadonlySet<string>;
  readonly secretNotebookIds: ReadonlySet<string>;
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
    let consecutiveReadOnlySteps = 0;

    for (let step = firstStep; step <= MAX_MODEL_STEPS; step += 1) {
      assertNotAborted(abortSignal);
      this.observer.onStep?.(step, MAX_MODEL_STEPS);
      if (consecutiveReadOnlySteps >= READ_BUDGET_NUDGE_THRESHOLD) {
        messages.push(readBudgetNudgeMessage(this.tools, context));
        consecutiveReadOnlySteps = 0;
      }
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
      consecutiveReadOnlySteps = proposed ? 0 : consecutiveReadOnlySteps + 1;
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
      const result = await this.executeOneTool(call, context);
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

  private async executeOneTool(
    call: NormalizedToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      return await this.tools.execute(call, context);
    } catch (error: unknown) {
      return toolFailureResult(call, error);
    }
  }
}

function toolContext(request: AgentRunRequest): ToolExecutionContext {
  return {
    chatId: request.chatId,
    runId: request.runId,
    hasFileWorkspace: request.hasFileWorkspace,
    vault: request.vault,
    readableNoteIds: request.readableNoteIds,
    secretNotebookIds: request.secretNotebookIds,
  };
}

function readBudgetNudgeMessage(
  tools: ToolRegistry,
  context: ToolExecutionContext,
): ProviderMessage {
  const content = hasProposeWriteTools(tools, context)
    ? [
        "READ BUDGET: You have completed several read-only tool steps without proposing changes.",
        "If the user asked for edits, reorganization, or new notes/files, use the available propose-write tools now.",
        "Do not ask the user for opaque ID lists; discover targets with search and list tools.",
      ].join(" ")
    : [
        "READ BUDGET: You have completed several read-only tool steps without proposing changes.",
        "Secret notebooks are excluded. Note body tools require active or attached notes.",
        "Do not ask the user to paste notebook or note ID lists.",
      ].join(" ");
  return { role: "system", content };
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
