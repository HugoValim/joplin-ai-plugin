import type { ProviderMessage } from "../providers/types";
import { pendingAgentPlanCount } from "./agentPlan";
import type {
  ToolExecutionContext,
  ToolRegistry,
} from "../tools/toolRegistry";

/** After this many content-body reads without a proposal, force propose-write only. */
export const READ_BUDGET_TOOL_CALLS = 8;

/** Consecutive text-only bailout nudges before the run terminates early. */
export const MAX_TEXT_ONLY_BAILOUTS = 5;

/** PLAN REQUIRED text-only failures before the plugin bootstraps a plan. */
export const PLAN_REQUIRED_BOOTSTRAP_AFTER = 2;

/**
 * Activates propose-only mode after the content-read budget is exhausted.
 *
 * @example proposeOnly = activateProposeOnlyIfNeeded(...)
 */
export function activateProposeOnlyIfNeeded(
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
  if (!tools.hasProposeWriteTools(context)) return false;
  messages.push(readBudgetNudgeMessage(tools, context));
  return true;
}

/**
 * True after multi-notebook inventory when the model still has not set a plan.
 *
 * @example if (needsAgentPlanAfterDiscovery(toolNames, context, tools)) ...
 */
export function needsAgentPlanAfterDiscovery(
  toolNames: readonly string[],
  context: ToolExecutionContext,
  tools: ToolRegistry,
): boolean {
  if (context.agentPlan.plan) return false;
  if (toolNames.includes("set_agent_plan")) return false;
  if (!hasAgentPlanTools(tools, context)) return false;
  return isSignificantDiscovery(toolNames);
}

/**
 * System nudge that forces set_agent_plan after inventory.
 *
 * @example messages.push(planRequiredNudge())
 */
export function planRequiredNudge(): ProviderMessage {
  return planRequiredMessage();
}

/**
 * Returns a system nudge when the model tries to stop without required actions.
 *
 * @example const bailout = textOnlyBailoutMessage(...)
 */
export function textOnlyBailoutMessage(
  proposeOnly: boolean,
  readOnly: boolean,
  tools: ToolRegistry,
  context: ToolExecutionContext,
  toolNames: readonly string[],
): ProviderMessage | null {
  if (readOnly) return null;
  if (proposeOnly && tools.hasProposeWriteTools(context)) {
    return proposeRequiredMessage();
  }
  if (
    tools.hasProposeWriteTools(context) &&
    pendingAgentPlanCount(context.agentPlan.plan) > 0
  ) {
    return planInProgressMessage();
  }
  if (needsAgentPlanAfterDiscovery(toolNames, context, tools)) {
    return planRequiredMessage();
  }
  return null;
}

/**
 * True when a bailout nudge requires set_agent_plan (post-inventory).
 *
 * @example if (isPlanRequiredBailout(bailout)) proposeOnly = true
 */
export function isPlanRequiredBailout(message: ProviderMessage): boolean {
  return (
    message.role === "system" && message.content.includes("PLAN REQUIRED:")
  );
}

export function withStuckLoopNotice(assistantText: string): string {
  return [
    assistantText,
    "",
    "[STUCK LOOP DETECTED] The agent repeated the same intent across consecutive steps without advancing the plan. The run was terminated to avoid wasting steps. Review the plan and start a new run with a different approach.",
  ].join("\n");
}

export function withBailoutExhaustedNotice(assistantText: string): string {
  return [
    assistantText,
    "",
    "[BAILOUT EXHAUSTED] The agent kept answering with chat-only text instead of calling tools after repeated nudges. The run was terminated to avoid wasting steps. Ask again and the model should call propose-write tools in the same turn.",
  ].join("\n");
}

export function withMissingProposalNotice(assistantText: string): string {
  const notice =
    "No propose-write tools were called, so ChangeReview did not open. Ask again to apply the changes.";
  const trimmed = assistantText.trim();
  return trimmed ? `${trimmed}\n\n${notice}` : notice;
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

function readBudgetNudgeMessage(
  tools: ToolRegistry,
  context: ToolExecutionContext,
): ProviderMessage {
  const content = tools.hasProposeWriteTools(context)
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
