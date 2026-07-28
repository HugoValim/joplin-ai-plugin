import { Type, type Static } from "@sinclair/typebox";
import type {
  AgentTool,
  ToolExecutionContext,
} from "./toolRegistry";
import type { SubAgentRegistry } from "../agent/subAgentRegistry";

const SubAgentInputSchema = Type.Object(
  {
    subagent_id: Type.String({ minLength: 1, maxLength: 64 }),
    task: Type.String({ minLength: 1, maxLength: 2_000 }),
  },
  { additionalProperties: false },
);

const SubAgentOutputSchema = Type.Object(
  {
    subagent_id: Type.String({ minLength: 1, maxLength: 64 }),
    status: Type.Union([
      Type.Literal("started"),
      Type.Literal("refused"),
    ]),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    active_count: Type.Integer({ minimum: 0, maximum: 3 }),
  },
  { additionalProperties: false },
);

type SubAgentInput = Static<typeof SubAgentInputSchema>;
type SubAgentOutput = Static<typeof SubAgentOutputSchema>;

class StartSubAgentTool implements AgentTool<SubAgentInput, SubAgentOutput> {
  public readonly name = "start_subagent";
  public readonly description =
    "Start a helper subagent for a bounded subtask during a heavy multi-step run. At most 3 run concurrently; further spawns are refused. The parent merges results and proposes writes.";
  public readonly risk = "meta" as const;
  public readonly inputSchema = SubAgentInputSchema;
  public readonly outputSchema = SubAgentOutputSchema;

  public constructor(private readonly registry: SubAgentRegistry) {}

  public isAvailable(context: ToolExecutionContext): boolean {
    return !context.readOnly;
  }

  public execute(input: SubAgentInput): Promise<SubAgentOutput> {
    const started = this.registry.tryStart(input.subagent_id);
    if (!started) {
      return Promise.resolve({
        subagent_id: input.subagent_id,
        status: "refused",
        message: this.registry.has(input.subagent_id)
          ? `Subagent ${input.subagent_id} is already running`
          : `Concurrency cap reached; ${this.registry.activeCount} of 3 subagents active. Complete one before spawning another.`,
        active_count: this.registry.activeCount,
      });
    }
    return Promise.resolve({
      subagent_id: input.subagent_id,
      status: "started",
      message: `Subagent ${input.subagent_id} started for: ${input.task.slice(0, 200)}`,
      active_count: this.registry.activeCount,
    });
  }
}

class CompleteSubAgentTool implements AgentTool<SubAgentInput, SubAgentOutput> {
  public readonly name = "complete_subagent";
  public readonly description =
    "Mark a spawned subagent as finished so its slot frees for the next spawn.";
  public readonly risk = "meta" as const;
  public readonly inputSchema = SubAgentInputSchema;
  public readonly outputSchema = SubAgentOutputSchema;

  public constructor(private readonly registry: SubAgentRegistry) {}

  public isAvailable(): boolean {
    return true;
  }

  public execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.registry.complete(input.subagent_id);
    return Promise.resolve({
      subagent_id: input.subagent_id,
      status: "started",
      message: `Subagent ${input.subagent_id} completed`,
      active_count: this.registry.activeCount,
    });
  }
}

/**
 * Registers subagent spawn/complete tools bound to one SubAgentRegistry.
 *
 * @example registerSubAgentTools(registry, tools)
 */
export function registerSubAgentTools(
  registry: SubAgentRegistry,
  tools: { register<TI, TO>(tool: AgentTool<TI, TO>): void },
): void {
  tools.register(new StartSubAgentTool(registry));
  tools.register(new CompleteSubAgentTool(registry));
}
