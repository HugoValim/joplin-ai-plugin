import { Type, type Static } from "@sinclair/typebox";
import {
  agentPlanSummaryText,
  setAgentPlan,
  updateAgentPlanItem,
  type AgentPlan,
  type AgentPlanItemStatus,
} from "../agent/agentPlan";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolRegistry,
} from "./toolRegistry";

const PlanItemStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

const PlanItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    content: Type.String({ minLength: 1, maxLength: 500 }),
    status: Type.Optional(PlanItemStatusSchema),
  },
  { additionalProperties: false },
);

const PlanOutputSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 2_000 }),
    items: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 64 }),
          content: Type.String({ minLength: 1, maxLength: 500 }),
          status: PlanItemStatusSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

type PlanOutput = Static<typeof PlanOutputSchema>;

class SetAgentPlanTool implements AgentTool<
  { readonly items: readonly Static<typeof PlanItemSchema>[] },
  PlanOutput
> {
  public readonly name = "set_agent_plan";
  public readonly description =
    "Replace the run checklist for large multi-note or multi-notebook work. Call after inventory. Keep each item to at most 5 notes; then execute pending items in bounded propose batches of at most 5 note bodies.";
  public readonly risk = "meta" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {
      items: Type.Array(PlanItemSchema, { minItems: 1, maxItems: 100 }),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = PlanOutputSchema;

  public isAvailable(): boolean {
    return true;
  }

  public execute(
    input: { readonly items: readonly Static<typeof PlanItemSchema>[] },
    context: ToolExecutionContext,
  ): Promise<PlanOutput> {
    const plan = setAgentPlan(input.items);
    context.agentPlan.plan = plan;
    return Promise.resolve(planOutput(plan));
  }
}

class UpdateAgentPlanItemTool implements AgentTool<
  { readonly id: string; readonly status: AgentPlanItemStatus },
  PlanOutput
> {
  public readonly name = "update_agent_plan_item";
  public readonly description =
    "Update one agent plan item status (pending, in_progress, completed, or cancelled). Call in the same turn as the matching propose-write batch; do not only narrate progress in chat.";
  public readonly risk = "meta" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {
      id: Type.String({ minLength: 1, maxLength: 64 }),
      status: PlanItemStatusSchema,
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = PlanOutputSchema;

  public isAvailable(): boolean {
    return true;
  }

  public execute(
    input: { readonly id: string; readonly status: AgentPlanItemStatus },
    context: ToolExecutionContext,
  ): Promise<PlanOutput> {
    const plan = updateAgentPlanItem(
      context.agentPlan.plan,
      input.id,
      input.status,
    );
    context.agentPlan.plan = plan;
    return Promise.resolve(planOutput(plan));
  }
}

/**
 * Registers structured agent plan tools used for multi-batch vault work.
 *
 * @example registerAgentPlanTools(registry)
 */
export function registerAgentPlanTools(registry: ToolRegistry): void {
  registry.register(new SetAgentPlanTool());
  registry.register(new UpdateAgentPlanItemTool());
}

function planOutput(plan: AgentPlan): PlanOutput {
  return {
    summary: agentPlanSummaryText(plan),
    items: plan.items.map((item) => ({
      id: item.id,
      content: item.content,
      status: item.status,
    })),
  };
}
