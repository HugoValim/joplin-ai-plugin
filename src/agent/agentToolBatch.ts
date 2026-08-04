import type { NormalizedToolCall, ProviderMessage } from "../providers/types";
import type { AgentObserver } from "./agentRunner";
import type { ToolExecutionContext, ToolRegistry } from "../tools/toolRegistry";

export interface AgentToolBatchResult {
  readonly proposed: boolean;
  readonly discoveryCapped: boolean;
  readonly contentReadCount: number;
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
  const execution = args.tools.beginGuardedExecution({
    proposeOnly: args.proposeOnly,
    readOnly: args.readOnly,
    blockDiscovery: args.blockDiscovery === true,
    priorToolNames: args.toolNames,
    abortSignal: args.abortSignal,
  });
  for (const call of args.calls) {
    args.observer.onToolStarted?.(call);
    const result = await execution.execute(call, args.context);
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
  }
  return {
    proposed,
    discoveryCapped: execution.discoveryCapped,
    contentReadCount: execution.contentReadCount,
  };
}
