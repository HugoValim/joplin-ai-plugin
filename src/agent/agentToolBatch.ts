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
 * Executes one model tool batch. Parallelizes consecutive start_subagent calls.
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
  let proposed = false;
  let index = 0;
  while (index < args.calls.length) {
    assertNotAborted(args.abortSignal);
    const call = args.calls[index];
    if (!call) break;
    if (call.name === "start_subagent") {
      const group = takeStartSubAgentGroup(args.calls, index);
      index += group.length;
      const results = await Promise.all(
        group.map(async (subCall) => {
          args.observer.onToolStarted?.(subCall);
          return {
            call: subCall,
            result: await executeOneAgentTool(
              subCall,
              args.context,
              args.proposeOnly,
              args.readOnly,
              args.tools,
            ),
          };
        }),
      );
      for (const { call: subCall, result } of results) {
        args.toolNames.push(subCall.name);
        args.observer.onToolCompleted?.(result);
        args.messages.push({
          role: "tool",
          toolCallId: subCall.id,
          content: JSON.stringify(result.output),
        });
      }
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
    if (result.risk === "propose-write") proposed = true;
    index += 1;
  }
  return proposed;
}

function takeStartSubAgentGroup(
  calls: readonly NormalizedToolCall[],
  startIndex: number,
): NormalizedToolCall[] {
  const group: NormalizedToolCall[] = [];
  let index = startIndex;
  while (index < calls.length && calls[index]?.name === "start_subagent") {
    const next = calls[index];
    if (next) group.push(next);
    index += 1;
  }
  return group;
}

async function executeOneAgentTool(
  call: NormalizedToolCall,
  context: ToolExecutionContext,
  proposeOnly: boolean,
  readOnly: boolean,
  tools: ToolRegistry,
): Promise<ToolExecutionResult> {
  try {
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
