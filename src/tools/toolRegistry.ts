import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentPlanState } from "../agent/agentPlan";
import type {
  NormalizedToolCall,
  ProviderToolDefinition,
} from "../providers/types";
import { DomainError, safeValue } from "../shared/errors";

export type ToolRisk = "read" | "propose-write" | "meta";

/** Content-body reads that count toward the per-segment read budget. */
export const CONTENT_READ_TOOL_NAMES = new Set([
  "read_note",
  "read_text_file",
]);

export interface SubAgentSpawnInput {
  readonly subagent_id: string;
  readonly task: string;
}

export interface SubAgentSpawnResult {
  readonly subagent_id: string;
  readonly status: "completed" | "refused" | "failed" | "cancelled";
  readonly message: string;
  readonly result_text: string;
  readonly active_count: number;
}

export interface ToolExecutionContext {
  readonly chatId: string;
  readonly runId: string;
  readonly hasFileWorkspace: boolean;
  readonly vault: boolean;
  readonly readableNoteIds: ReadonlySet<string>;
  readonly secretNotebookIds: ReadonlySet<string>;
  readonly agentPlan: AgentPlanState;
  readonly readOnly: boolean;
  /** Parent AgentRunner hook: runs a nested read-only subagent to completion. */
  readonly runSubAgent?: (
    input: SubAgentSpawnInput,
  ) => Promise<SubAgentSpawnResult>;
  /** Parent AgentRunner hook: aborts one live subagent and returns remaining count. */
  readonly abortSubAgent?: (subAgentId: string) => number;
}

export interface AgentTool<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly inputSchema: TSchema;
  readonly outputSchema: TSchema;
  isAvailable(context: ToolExecutionContext): boolean;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly risk: ToolRisk;
  readonly output: unknown;
}

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly inputSchema: TSchema;
  readonly outputSchema: TSchema;
  readonly isAvailable: (context: ToolExecutionContext) => boolean;
  readonly execute: (
    input: unknown,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * Registers one schema-validated tool under a unique function name.
   *
   * @example registry.register(new ReadNoteTool(repository))
   */
  public register<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new DomainError(
        "VALIDATION",
        `Duplicate tool ${safeValue(tool.name)}; expected a unique tool name`,
      );
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
      throw new DomainError(
        "VALIDATION",
        `Invalid tool name ${safeValue(tool.name)}; expected snake_case`,
      );
    }
    this.tools.set(tool.name, eraseToolTypes(tool));
  }

  /**
   * Returns only tools available for the current chat context.
   * When proposeOnly is set, read tools are omitted so the model must propose writes.
   *
   * @example registry.providerDefinitions(context)
   * @example registry.providerDefinitions(context, { proposeOnly: true })
   */
  public providerDefinitions(
    context: ToolExecutionContext,
    options: { readonly proposeOnly?: boolean; readonly readOnly?: boolean } = {},
  ): readonly ProviderToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => tool.isAvailable(context))
      .filter(
        (tool) =>
          !options.proposeOnly ||
          tool.risk === "propose-write" ||
          tool.risk === "meta",
      )
      .filter(
        (tool) =>
          !options.readOnly || tool.risk === "read" || tool.risk === "meta",
      )
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
  }

  /**
   * Returns whether a tool name counts toward the content-read budget.
   *
   * @example registry.countsTowardReadBudget("read_note")
   */
  public countsTowardReadBudget(name: string): boolean {
    return CONTENT_READ_TOOL_NAMES.has(name);
  }

  /**
   * Returns whether any propose-write tools are available for the context.
   *
   * @example registry.hasProposeWriteTools(context)
   */
  public hasProposeWriteTools(
    context: ToolExecutionContext,
    options: { readonly readOnly?: boolean } = {},
  ): boolean {
    if (options.readOnly) return false;
    return [...this.tools.values()].some(
      (tool) => tool.risk === "propose-write" && tool.isAvailable(context),
    );
  }

  /**
   * Returns the registered risk for a tool name, or null when unknown.
   *
   * @example registry.riskFor("list_notebooks")
   */
  public riskFor(name: string): ToolRisk | null {
    return this.tools.get(name)?.risk ?? null;
  }

  /**
   * Validates model arguments/output around one bounded tool execution.
   *
   * @example await registry.execute(toolCall, context)
   */
  public async execute(
    call: NormalizedToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `Unknown tool ${safeValue(call.name)}; expected a registered tool name`,
      );
    }
    if (!tool.isAvailable(context)) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `Tool ${tool.name} is unavailable for chat ${context.chatId}; expected required context`,
      );
    }
    const input = coerceToolInput(tool.inputSchema, call.arguments);
    assertSchema(tool.inputSchema, input, `schema for tool ${tool.name}`);
    const output = await tool.execute(input, context);
    assertSchema(
      tool.outputSchema,
      output,
      `output schema for tool ${tool.name}`,
    );
    return {
      toolCallId: call.id,
      name: tool.name,
      risk: tool.risk,
      output,
    };
  }
}

function eraseToolTypes<TInput, TOutput>(
  tool: AgentTool<TInput, TOutput>,
): RegisteredTool {
  return {
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    isAvailable: (context): boolean => tool.isAvailable(context),
    execute: (input, context): Promise<unknown> =>
      tool.execute(input as TInput, context),
  };
}

function assertSchema(schema: TSchema, input: unknown, expected: string): void {
  if (Value.Check(schema, input)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid tool value ${safeValue(input)}; expected ${expected}`,
  );
}

/**
 * Coerces numeric strings for number-like tool fields before schema checks.
 *
 * @example coerceToolInput(schema, { expected_updated_time: "10" })
 */
function coerceToolInput(schema: TSchema, input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const properties = objectProperties(schema);
  if (!properties) return input;
  const coerced: Record<string, unknown> = { ...input };
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property || !isNumberLikeSchema(property)) continue;
    if (typeof value !== "string") continue;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) coerced[key] = asNumber;
  }
  return coerced;
}

function objectProperties(
  schema: TSchema,
): Record<string, TSchema> | undefined {
  if (!("properties" in schema) || !schema.properties) return undefined;
  return schema.properties as Record<string, TSchema>;
}

function isNumberLikeSchema(schema: TSchema): boolean {
  const kind = (schema as { type?: string }).type;
  return kind === "number" || kind === "integer";
}

function isPlainObject(
  input: unknown,
): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
