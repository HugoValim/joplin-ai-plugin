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

/** Max inventory/search tool executions per run segment before blocking more. */
export const MAX_DISCOVERY_TOOL_CALLS = 10;

export interface AgentToolBatchResult {
  readonly proposed: boolean;
  readonly discoveryCapped: boolean;
}

/**
 * Executes one model tool batch sequentially in call order.
 *
 * @example const result = await executeAgentToolBatch({ calls, ... })
 */
export async function executeAgentToolBatch(args: {
  readonly calls: readonly NormalizedToolCall[];
  readonly messages: ProviderMessage[];
  readonly context: ToolExecutionContext;
  readonly abortSignal: AbortSignal;
  readonly proposeOnly: boolean;
  readonly readOnly: boolean;
  readonly blockDiscovery?: boolean;
  readonly toolNames: string[];
  readonly tools: ToolRegistry;
  readonly observer: AgentObserver;
}): Promise<AgentToolBatchResult> {
  let proposed = false;
  let discoveryCapped = false;
  let discoveryCount = args.toolNames.filter((name) =>
    args.tools.isDiscoveryTool(name),
  ).length;
  for (const call of args.calls) {
    assertNotAborted(args.abortSignal);
    const hitDiscoveryCap =
      args.tools.isDiscoveryTool(call.name) &&
      discoveryCount >= MAX_DISCOVERY_TOOL_CALLS;
    if (hitDiscoveryCap) discoveryCapped = true;
    args.observer.onToolStarted?.(call);
    const result = await executeOneAgentTool(
      call,
      args.context,
      args.proposeOnly,
      args.readOnly,
      args.blockDiscovery === true || hitDiscoveryCap,
      args.tools,
      hitDiscoveryCap,
    );
    args.toolNames.push(call.name);
    if (args.tools.isDiscoveryTool(call.name) && !hitDiscoveryCap) {
      discoveryCount += 1;
      if (discoveryCount >= MAX_DISCOVERY_TOOL_CALLS) discoveryCapped = true;
    }
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
  }
  return { proposed, discoveryCapped };
}

async function executeOneAgentTool(
  call: NormalizedToolCall,
  context: ToolExecutionContext,
  proposeOnly: boolean,
  readOnly: boolean,
  blockDiscovery: boolean,
  tools: ToolRegistry,
  discoveryCapped: boolean,
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
    if (blockDiscovery && tools.isDiscoveryTool(call.name)) {
      const message = discoveryCapped
        ? `Discovery tool ${call.name} hit the per-segment cap of ${MAX_DISCOVERY_TOOL_CALLS}; call set_agent_plan then read and propose a bounded batch`
        : `Discovery tool ${call.name} is disabled after inventory; call set_agent_plan then read and propose a bounded batch`;
      return unavailableResult(call, "read", message);
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
