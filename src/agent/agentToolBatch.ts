import type {
  NormalizedToolCall,
  ProviderMessage,
} from "../providers/types";
import { DomainError } from "../shared/errors";
import type { AgentObserver } from "./agentRunner";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../tools/toolRegistry";

/**
 * Executes one model tool batch.
 * Like Cursor multi-agent Task fan-out: every `start_subagent` in the turn
 * starts together, then remaining tools run in call order.
 *
 * @example const proposed = await executeAgentToolBatch({ calls, ... })
 */
export async function executeAgentToolBatch(args: {
  readonly calls: readonly NormalizedToolCall[];
  readonly messages: ProviderMessage[];
  readonly context: ToolExecutionContext;
  readonly abortSignal: AbortSignal;
  readonly proposeOnly: boolean;
  readonly readOnly: boolean;
  readonly toolNames: string[];
  readonly tools: ToolRegistry;
  readonly observer: AgentObserver;
}): Promise<boolean> {
  assertNotAborted(args.abortSignal);
  const startResults = await runAllStartSubAgents(args);
  let proposed = false;
  for (const call of args.calls) {
    assertNotAborted(args.abortSignal);
    if (call.name === "start_subagent") {
      const result = startResults.get(call.id);
      if (!result) {
        throw new DomainError(
          "INTERNAL",
          `Missing parallel result for start_subagent ${call.id}; expected a precomputed tool result`,
        );
      }
      appendToolResult(args, call, result);
      continue;
    }
    args.observer.onToolStarted?.(call);
    const result = await executeOneAgentTool(
      call,
      args.context,
      args.proposeOnly,
      args.readOnly,
      args.tools,
    );
    appendToolResult(args, call, result);
    if (result.risk === "propose-write") proposed = true;
  }
  return proposed;
}

async function runAllStartSubAgents(args: {
  readonly calls: readonly NormalizedToolCall[];
  readonly context: ToolExecutionContext;
  readonly proposeOnly: boolean;
  readonly readOnly: boolean;
  readonly tools: ToolRegistry;
  readonly observer: AgentObserver;
}): Promise<Map<string, ToolExecutionResult>> {
  const startCalls = args.calls.filter((call) => call.name === "start_subagent");
  const results = new Map<string, ToolExecutionResult>();
  if (startCalls.length === 0) return results;
  const settled = await Promise.all(
    startCalls.map(async (call) => {
      args.observer.onToolStarted?.(call);
      return {
        id: call.id,
        result: await executeOneAgentTool(
          call,
          args.context,
          args.proposeOnly,
          args.readOnly,
          args.tools,
        ),
      };
    }),
  );
  for (const item of settled) {
    results.set(item.id, item.result);
  }
  return results;
}

function appendToolResult(
  args: {
    readonly messages: ProviderMessage[];
    readonly toolNames: string[];
    readonly context: ToolExecutionContext;
    readonly observer: AgentObserver;
  },
  call: NormalizedToolCall,
  result: ToolExecutionResult,
): void {
  args.toolNames.push(call.name);
  args.observer.onToolCompleted?.(result);
  if (result.risk === "meta" && args.context.agentPlan.plan) {
    args.observer.onPlanUpdated?.(args.context.agentPlan.plan);
  }
  args.messages.push({
    role: "tool",
    toolCallId: call.id,
    content: JSON.stringify(result.output),
  });
}

async function executeOneAgentTool(
  call: NormalizedToolCall,
  context: ToolExecutionContext,
  proposeOnly: boolean,
  readOnly: boolean,
  tools: ToolRegistry,
): Promise<ToolExecutionResult> {
  try {
    if (context.helperOnly && tools.riskFor(call.name) !== "read") {
      return unavailableResult(
        call,
        "read",
        `Tool ${call.name} is disabled for helper subagents; expected a read tool`,
      );
    }
    if (readOnly && tools.riskFor(call.name) === "propose-write") {
      return unavailableResult(
        call,
        "propose-write",
        `Write tool ${call.name} is disabled in Ask mode; expected a read-only tool`,
      );
    }
    if (proposeOnly && tools.riskFor(call.name) === "read") {
      return unavailableResult(
        call,
        "read",
        `Read tool ${call.name} is disabled after the read budget; expected a propose-write tool`,
      );
    }
    return await tools.execute(call, context);
  } catch (error: unknown) {
    return toolFailureResult(call, error);
  }
}

function unavailableResult(
  call: NormalizedToolCall,
  risk: "read" | "propose-write",
  message: string,
): ToolExecutionResult {
  return {
    toolCallId: call.id,
    name: call.name,
    risk,
    output: {
      error: {
        code: "NOT_AVAILABLE",
        message,
      },
    },
  };
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

function assertNotAborted(abortSignal: AbortSignal): void {
  if (!abortSignal.aborted) return;
  throw new DomainError("ABORTED", "Agent run cancelled", abortSignal.reason);
}
