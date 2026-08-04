import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentPlanState } from "../agent/agentPlan";
import type {
  NormalizedToolCall,
  ProviderToolDefinition,
} from "../providers/types";
import { DomainError, safeValue } from "../shared/errors";

export type ToolRisk = "read" | "propose-write" | "meta";
export type AgentToolClassification = "other" | "content-read" | "discovery";

/** Max inventory/search executions per run segment before blocking more. */
const MAX_DISCOVERY_TOOL_CALLS = 10;

export interface ToolDefinitionOptions {
  readonly proposeOnly?: boolean;
  readonly readOnly?: boolean;
  /** When true, omit inventory/search tools so the model must plan and act. */
  readonly blockDiscovery?: boolean;
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
}

export interface AgentTool<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly classification: AgentToolClassification;
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

export interface ToolExecutionPolicy {
  readonly proposeOnly: boolean;
  readonly readOnly: boolean;
  readonly blockDiscovery: boolean;
  readonly priorToolNames: readonly string[];
  readonly abortSignal: AbortSignal;
}

export interface GuardedToolExecution {
  readonly contentReadCount: number;
  readonly discoveryCapped: boolean;
  execute(
    call: NormalizedToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly classification: AgentToolClassification;
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
   * When blockDiscovery is set, inventory/search tools are omitted after vault listing.
   *
   * @example registry.providerDefinitions(context)
   * @example registry.providerDefinitions(context, { proposeOnly: true })
   */
  public providerDefinitions(
    context: ToolExecutionContext,
    options: ToolDefinitionOptions = {},
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
      .filter(
        (tool) =>
          !options.blockDiscovery || tool.classification !== "discovery",
      )
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
  }

  /**
   * Returns whether a tool name is an inventory/search discovery tool.
   *
   * @example registry.isDiscoveryTool("list_notebook_notes")
   */
  public isDiscoveryTool(name: string): boolean {
    return this.tools.get(name)?.classification === "discovery";
  }

  /**
   * Returns whether a tool name counts toward the content-read budget.
   *
   * @example registry.countsTowardReadBudget("read_note")
   */
  public countsTowardReadBudget(name: string): boolean {
    return this.tools.get(name)?.classification === "content-read";
  }

  /**
   * Returns whether vault discovery is broad enough to require an agent plan.
   *
   * @example registry.hasSignificantDiscovery(toolNames)
   */
  public hasSignificantDiscovery(toolNames: readonly string[]): boolean {
    const notebookNoteLists = toolNames.filter(
      (name) => name === "list_notebook_notes",
    ).length;
    if (notebookNoteLists >= 2) return true;
    return (
      toolNames.includes("list_notebooks") &&
      toolNames.includes("list_notebook_notes")
    );
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
   * Starts one policy-guarded sequence of tool executions.
   *
   * @example registry.beginGuardedExecution(policy)
   */
  public beginGuardedExecution(
    policy: ToolExecutionPolicy,
  ): GuardedToolExecution {
    return new RegistryGuardedExecution(this, policy);
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

class RegistryGuardedExecution implements GuardedToolExecution {
  private countedContentReads = 0;
  private discoveryCount: number;
  private hitDiscoveryLimit = false;

  public constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: ToolExecutionPolicy,
  ) {
    this.discoveryCount = policy.priorToolNames.filter((name) =>
      registry.isDiscoveryTool(name),
    ).length;
  }

  public get contentReadCount(): number {
    return this.countedContentReads;
  }

  public get discoveryCapped(): boolean {
    return this.hitDiscoveryLimit;
  }

  public async execute(
    call: NormalizedToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    assertExecutionActive(this.policy.abortSignal);
    const discovery = this.registry.isDiscoveryTool(call.name);
    const hitDiscoveryCap =
      discovery && this.discoveryCount >= MAX_DISCOVERY_TOOL_CALLS;
    this.recordCallClassification(call.name, hitDiscoveryCap);
    const rejection = this.policyRejection(call, discovery, hitDiscoveryCap);
    if (rejection) return rejection;
    if (discovery) this.recordDiscoveryExecution();
    try {
      return await this.registry.execute(call, context);
    } catch (error: unknown) {
      return toolFailureResult(call, error);
    }
  }

  private recordCallClassification(
    toolName: string,
    hitDiscoveryCap: boolean,
  ): void {
    if (this.registry.countsTowardReadBudget(toolName)) {
      this.countedContentReads += 1;
    }
    if (hitDiscoveryCap) this.hitDiscoveryLimit = true;
  }

  private policyRejection(
    call: NormalizedToolCall,
    discovery: boolean,
    hitDiscoveryCap: boolean,
  ): ToolExecutionResult | null {
    const riskRejection = this.riskPolicyRejection(call);
    if (riskRejection) return riskRejection;
    if (!discovery || (!this.policy.blockDiscovery && !hitDiscoveryCap)) {
      return null;
    }
    return unavailableResult(
      call,
      "read",
      discoveryUnavailableMessage(call.name, hitDiscoveryCap),
    );
  }

  private riskPolicyRejection(
    call: NormalizedToolCall,
  ): ToolExecutionResult | null {
    const risk = this.registry.riskFor(call.name);
    if (this.policy.readOnly && risk === "propose-write") {
      return unavailableResult(
        call,
        "propose-write",
        `Write tool ${call.name} is disabled in Ask mode; expected a read-only tool`,
      );
    }
    if (this.policy.proposeOnly && risk === "read") {
      return unavailableResult(
        call,
        "read",
        `Read tool ${call.name} is disabled after the read budget; expected a propose-write tool`,
      );
    }
    return null;
  }

  private recordDiscoveryExecution(): void {
    this.discoveryCount += 1;
    if (this.discoveryCount >= MAX_DISCOVERY_TOOL_CALLS) {
      this.hitDiscoveryLimit = true;
    }
  }
}

function assertExecutionActive(abortSignal: AbortSignal): void {
  if (!abortSignal.aborted) return;
  throw new DomainError("ABORTED", "Agent run cancelled", abortSignal.reason);
}

function discoveryUnavailableMessage(
  toolName: string,
  hitDiscoveryCap: boolean,
): string {
  if (hitDiscoveryCap) {
    return `Discovery tool ${toolName} hit the per-segment cap of ${MAX_DISCOVERY_TOOL_CALLS}; call set_agent_plan then read and propose a bounded batch`;
  }
  return `Discovery tool ${toolName} is disabled after inventory; call set_agent_plan then read and propose a bounded batch`;
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
    output: { error: { code: "NOT_AVAILABLE", message } },
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
    output: { error: { code: failure.code, message: failure.message } },
  };
}

function shouldRethrowToolError(error: DomainError): boolean {
  return error.code === "ABORTED" || error.code === "LIMIT_EXCEEDED";
}

function eraseToolTypes<TInput, TOutput>(
  tool: AgentTool<TInput, TOutput>,
): RegisteredTool {
  return {
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    classification: tool.classification,
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

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
