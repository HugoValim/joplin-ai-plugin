import { DomainError, safeValue } from "../shared/errors";

export const AGENT_PLAN_MAX_ITEMS = 100;
export const AGENT_PLAN_ITEM_CONTENT_MAX = 500;

export type AgentPlanItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface AgentPlanItem {
  readonly id: string;
  readonly content: string;
  readonly status: AgentPlanItemStatus;
}

export interface AgentPlan {
  readonly items: readonly AgentPlanItem[];
}

/** Mutable holder so plan tools and the runner share one plan per run. */
export interface AgentPlanState {
  plan: AgentPlan | null;
}

export interface AgentPlanItemInput {
  readonly id: string;
  readonly content: string;
  readonly status?: AgentPlanItemStatus;
}

/**
 * Builds a validated agent plan from model-supplied checklist items.
 *
 * @example setAgentPlan([{ id: "1", content: "Improve FWS notes" }])
 */
export function setAgentPlan(
  items: readonly AgentPlanItemInput[],
): AgentPlan {
  if (items.length === 0) {
    throw new DomainError(
      "VALIDATION",
      `Agent plan items ${safeValue(items)}; expected 1 to ${AGENT_PLAN_MAX_ITEMS} items`,
    );
  }
  if (items.length > AGENT_PLAN_MAX_ITEMS) {
    throw new DomainError(
      "VALIDATION",
      `Agent plan has ${items.length} items; expected at most ${AGENT_PLAN_MAX_ITEMS}`,
    );
  }
  const seen = new Set<string>();
  const normalized: AgentPlanItem[] = [];
  for (const item of items) {
    assertItemId(item.id);
    if (seen.has(item.id)) {
      throw new DomainError(
        "VALIDATION",
        `Duplicate agent plan item id ${safeValue(item.id)}; expected unique ids`,
      );
    }
    seen.add(item.id);
    normalized.push({
      id: item.id,
      content: assertItemContent(item.content),
      status: item.status ?? "pending",
    });
  }
  return { items: normalized };
}

/**
 * Updates one plan item status; keeps other items unchanged.
 *
 * @example updateAgentPlanItem(plan, "1", "completed")
 */
export function updateAgentPlanItem(
  plan: AgentPlan | null,
  id: string,
  status: AgentPlanItemStatus,
): AgentPlan {
  if (!plan) {
    throw new DomainError(
      "VALIDATION",
      "No active agent plan; expected set_agent_plan before update_agent_plan_item",
    );
  }
  assertItemId(id);
  const index = plan.items.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new DomainError(
      "VALIDATION",
      `Unknown agent plan item ${safeValue(id)}; expected an id from the active plan`,
    );
  }
  const items = plan.items.map((item, itemIndex) =>
    itemIndex === index ? { ...item, status } : item,
  );
  return { items };
}

/**
 * Counts items still open for work (pending or in_progress).
 *
 * @example pendingAgentPlanCount(plan)
 */
export function pendingAgentPlanCount(plan: AgentPlan | null): number {
  if (!plan) return 0;
  return plan.items.filter(
    (item) => item.status === "pending" || item.status === "in_progress",
  ).length;
}

/**
 * One-line progress summary for prompts and the sidebar.
 *
 * @example agentPlanSummaryText(plan)
 */
export function agentPlanSummaryText(plan: AgentPlan | null): string {
  if (!plan || plan.items.length === 0) return "No active plan";
  const counts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const item of plan.items) counts[item.status] += 1;
  return `Plan: ${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending, ${counts.cancelled} cancelled (${plan.items.length} total)`;
}

/**
 * Compact checklist text injected when resuming with pending work.
 *
 * @example agentPlanContinuationNudge(plan)
 */
export function agentPlanContinuationNudge(plan: AgentPlan | null): string | null {
  if (!plan || pendingAgentPlanCount(plan) === 0) return null;
  const open = plan.items.filter(
    (item) => item.status === "pending" || item.status === "in_progress",
  );
  const preview = open
    .slice(0, 8)
    .map((item) => `- [${item.status}] ${item.id}: ${item.content}`)
    .join("\n");
  const more =
    open.length > 8 ? `\n… and ${open.length - 8} more pending items` : "";
  return [
    "ACTIVE AGENT PLAN: Continue pending items in bounded batches.",
    "Read a few note bodies, propose edits, then stop for ChangeReview.",
    "Mark finished items with update_agent_plan_item before the next batch.",
    agentPlanSummaryText(plan),
    "Next items:",
    `${preview}${more}`,
  ].join("\n");
}

function assertItemId(id: string): void {
  if (id.length >= 1 && id.length <= 64) return;
  throw new DomainError(
    "VALIDATION",
    `Agent plan item id ${safeValue(id)}; expected length 1 to 64`,
  );
}

function assertItemContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length < 1 || trimmed.length > AGENT_PLAN_ITEM_CONTENT_MAX) {
    throw new DomainError(
      "VALIDATION",
      `Agent plan item content ${safeValue(content)}; expected length 1 to ${AGENT_PLAN_ITEM_CONTENT_MAX}`,
    );
  }
  return trimmed;
}
