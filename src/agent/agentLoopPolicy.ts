import type { ProviderMessage } from "../providers/types";
import { pendingAgentPlanCount, type AgentPlan } from "./agentPlan";
import {
  bootstrapPlanFromInventory,
  planBootstrappedNudge,
} from "./inventoryPlanBootstrap";
import { StuckLoopDetector } from "./stuckLoopDetector";
import type { ToolExecutionContext, ToolRegistry } from "../tools/toolRegistry";

/** After this many content-body reads without a proposal, force propose-write only. */
export const READ_BUDGET_TOOL_CALLS = 8;

/** Consecutive text-only bailout nudges before the run terminates early. */
export const MAX_TEXT_ONLY_BAILOUTS = 5;

/** PLAN REQUIRED text-only failures before the plugin bootstraps a plan. */
export const PLAN_REQUIRED_BOOTSTRAP_AFTER = 2;

export interface AgentLoopModelPolicy {
  readonly proposeOnly: boolean;
  readonly readOnly: boolean;
  readonly blockDiscovery: boolean;
}

export interface AgentLoopToolBatchSummary {
  readonly proposed: boolean;
  readonly discoveryCapped: boolean;
  readonly contentReadCount: number;
}

export interface AgentLoopContinueTransition {
  readonly action: "continue";
  readonly planUpdated?: AgentPlan;
}

export interface AgentLoopCompleteTransition {
  readonly action: "complete";
  readonly reason:
    "finished" | "stuck" | "bailout-exhausted" | "missing-proposal";
}

export type AgentLoopTransition =
  | AgentLoopContinueTransition
  | { readonly action: "awaiting-approval" }
  | AgentLoopCompleteTransition;

type AgentLoopTextTransition =
  AgentLoopContinueTransition | AgentLoopCompleteTransition;

type AgentLoopBatchTransition =
  AgentLoopContinueTransition | { readonly action: "awaiting-approval" };

/**
 * Owns bounded-loop counters and exposes controlled policy transitions.
 *
 * @example const state = new AgentLoopPolicyState(false, tools, context)
 */
export class AgentLoopPolicyState {
  private readCallsSincePropose = 0;
  private proposeOnly = false;
  private blockDiscovery = false;
  private textOnlyBailouts = 0;
  private readonly stuckDetector = new StuckLoopDetector();

  public constructor(
    private readonly readOnly: boolean,
    private readonly tools: ToolRegistry,
    private readonly context: ToolExecutionContext,
  ) {}

  /**
   * Returns tool visibility policy for the next model step.
   *
   * @example const policy = state.prepareModelStep(messages)
   */
  public prepareModelStep(messages: ProviderMessage[]): AgentLoopModelPolicy {
    this.proposeOnly = activateProposeOnlyIfNeeded(
      this.proposeOnly,
      this.readCallsSincePropose,
      this.readOnly,
      this.tools,
      this.context,
      messages,
    );
    return this.modelPolicy();
  }

  /**
   * Records one completed tool batch for later policy decisions.
   *
   * @example state.recordToolBatch(batch, messages, toolNames)
   */
  public recordToolBatch(
    batch: AgentLoopToolBatchSummary,
    messages: ProviderMessage[],
    toolNames: readonly string[],
  ): AgentLoopBatchTransition {
    this.textOnlyBailouts = 0;
    if (batch.proposed) return { action: "awaiting-approval" };
    this.readCallsSincePropose += batch.contentReadCount;
    if (batch.discoveryCapped) {
      this.blockDiscovery = true;
      return { action: "continue" };
    }
    if (this.shouldRequirePlan(toolNames)) {
      this.blockDiscovery = true;
      messages.push(planRequiredNudge());
    }
    return { action: "continue" };
  }

  /**
   * Records a model step that stopped without calling tools.
   *
   * @example state.recordTextOnlyStep(messages, toolNames, false)
   */
  public recordTextOnlyStep(
    messages: ProviderMessage[],
    toolNames: readonly string[],
    atModelStepLimit: boolean,
  ): AgentLoopTextTransition {
    const bailout = this.textOnlyBailout(toolNames);
    if (!bailout) return { action: "complete", reason: "finished" };
    return this.recordBailout(messages, bailout, atModelStepLimit);
  }

  /**
   * Records assistant intent accompanying a tool batch.
   *
   * @example state.recordToolStep(assistantText)
   */
  public recordToolStep(text: string): AgentLoopTextTransition {
    if (!this.context.agentPlan.plan) return { action: "continue" };
    if (!this.stuckDetector.addStep(text)) return { action: "continue" };
    return { action: "complete", reason: "stuck" };
  }

  private recordBailout(
    messages: ProviderMessage[],
    bailout: ProviderMessage,
    atModelStepLimit: boolean,
  ): AgentLoopTextTransition {
    if (this.startPlanRequiredPhase(messages, bailout)) {
      return { action: "continue" };
    }
    this.textOnlyBailouts += 1;
    const plan = this.bootstrapPlanIfReady(messages, bailout);
    if (plan) return { action: "continue", planUpdated: plan };
    if (this.isTextOnlyStuck()) return { action: "complete", reason: "stuck" };
    if (this.bailoutLimitReached(bailout)) {
      return { action: "complete", reason: "bailout-exhausted" };
    }
    if (atModelStepLimit) {
      return { action: "complete", reason: "missing-proposal" };
    }
    messages.push(bailout);
    return { action: "continue" };
  }

  private textOnlyBailout(
    toolNames: readonly string[],
  ): ProviderMessage | null {
    return textOnlyBailoutMessage(
      this.proposeOnly,
      this.readOnly,
      this.tools,
      this.context,
      toolNames,
    );
  }

  private startPlanRequiredPhase(
    messages: ProviderMessage[],
    bailout: ProviderMessage,
  ): boolean {
    if (this.blockDiscovery || this.readOnly) return false;
    if (!isPlanRequiredBailout(bailout)) return false;
    this.blockDiscovery = true;
    this.textOnlyBailouts = 0;
    messages.push(bailout);
    return true;
  }

  private bootstrapPlanIfReady(
    messages: ProviderMessage[],
    bailout: ProviderMessage,
  ): AgentPlan | null {
    if (!isPlanRequiredBailout(bailout)) return null;
    if (this.textOnlyBailouts < PLAN_REQUIRED_BOOTSTRAP_AFTER) return null;
    if (this.context.agentPlan.plan) return null;
    const plan = bootstrapPlanFromInventory(messages);
    if (!plan) return null;
    this.context.agentPlan.plan = plan;
    this.blockDiscovery = true;
    this.textOnlyBailouts = 0;
    messages.push(planBootstrappedNudge(plan.items.length));
    return plan;
  }

  private isTextOnlyStuck(): boolean {
    if (!this.context.agentPlan.plan) return false;
    return this.stuckDetector.addTextOnlyStep();
  }

  private bailoutLimitReached(bailout: ProviderMessage): boolean {
    if (isPlanRequiredBailout(bailout)) return false;
    return this.textOnlyBailouts >= MAX_TEXT_ONLY_BAILOUTS;
  }

  private shouldRequirePlan(toolNames: readonly string[]): boolean {
    if (this.blockDiscovery || this.readOnly) return false;
    return needsAgentPlanAfterDiscovery(toolNames, this.context, this.tools);
  }

  private modelPolicy(): AgentLoopModelPolicy {
    return {
      proposeOnly: this.proposeOnly,
      readOnly: this.readOnly,
      blockDiscovery: this.blockDiscovery,
    };
  }
}

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
  return tools.hasSignificantDiscovery(toolNames);
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
