import { Type, type Static } from "@sinclair/typebox";
import type {
  AgentTool,
  ToolExecutionContext,
} from "./toolRegistry";

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
      Type.Literal("completed"),
      Type.Literal("refused"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    result_text: Type.String({ maxLength: 8_000 }),
    active_count: Type.Integer({ minimum: 0, maximum: 3 }),
  },
  { additionalProperties: false },
);

export type SubAgentInput = Static<typeof SubAgentInputSchema>;
export type SubAgentOutput = Static<typeof SubAgentOutputSchema>;

class StartSubAgentTool implements AgentTool<SubAgentInput, SubAgentOutput> {
  public readonly name = "start_subagent";
  public readonly description =
    "Spawn a read-only helper subagent for one bounded research subtask (Cursor Task style). " +
    "Pass a self-contained task brief with note/notebook ids, scope, and the findings format to return — the helper does not see parent chat history. " +
    "For parallel work, call start_subagent up to 3 times in the SAME tool-call turn; they run concurrently. A 4th concurrent spawn is refused. " +
    "Awaits completion and returns result_text. You merge findings and alone propose/apply writes.";
  public readonly risk = "meta" as const;
  public readonly inputSchema = SubAgentInputSchema;
  public readonly outputSchema = SubAgentOutputSchema;

  public isAvailable(context: ToolExecutionContext): boolean {
    return !context.readOnly && context.runSubAgent !== undefined;
  }

  public execute(
    input: SubAgentInput,
    context: ToolExecutionContext,
  ): Promise<SubAgentOutput> {
    if (!context.runSubAgent) {
      return Promise.resolve({
        subagent_id: input.subagent_id,
        status: "refused",
        message:
          "Subagent host unavailable; expected AgentRunner to provide runSubAgent",
        result_text: "",
        active_count: 0,
      });
    }
    return context.runSubAgent(input);
  }
}

class CompleteSubAgentTool implements AgentTool<SubAgentInput, SubAgentOutput> {
  public readonly name = "complete_subagent";
  public readonly description =
    "Abort a live subagent early and free its concurrency slot.";
  public readonly risk = "meta" as const;
  public readonly inputSchema = SubAgentInputSchema;
  public readonly outputSchema = SubAgentOutputSchema;

  public isAvailable(context: ToolExecutionContext): boolean {
    return !context.readOnly && context.abortSubAgent !== undefined;
  }

  public execute(
    input: SubAgentInput,
    context: ToolExecutionContext,
  ): Promise<SubAgentOutput> {
    if (!context.abortSubAgent) {
      return Promise.resolve({
        subagent_id: input.subagent_id,
        status: "refused",
        message:
          "Subagent host unavailable; expected AgentRunner to provide abortSubAgent",
        result_text: "",
        active_count: 0,
      });
    }
    const activeCount = context.abortSubAgent(input.subagent_id);
    return Promise.resolve({
      subagent_id: input.subagent_id,
      status: "completed",
      message: `Subagent ${input.subagent_id} aborted and slot freed`,
      result_text: "",
      active_count: activeCount,
    });
  }
}

/**
 * Registers subagent spawn/complete tools.
 *
 * @example registerSubAgentTools(tools)
 */
export function registerSubAgentTools(tools: {
  register<TI, TO>(tool: AgentTool<TI, TO>): void;
}): void {
  tools.register(new StartSubAgentTool());
  tools.register(new CompleteSubAgentTool());
}
