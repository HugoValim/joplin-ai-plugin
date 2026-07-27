import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  NormalizedToolCall,
  ProviderToolDefinition,
} from "../providers/types";
import { DomainError, safeValue } from "../shared/errors";

export type ToolRisk = "read" | "propose-write";

export interface ToolExecutionContext {
  readonly chatId: string;
  readonly runId: string;
  readonly hasFileWorkspace: boolean;
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
   *
   * @example registry.providerDefinitions(context)
   */
  public providerDefinitions(
    context: ToolExecutionContext,
  ): readonly ProviderToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => tool.isAvailable(context))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
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
