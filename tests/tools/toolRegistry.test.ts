import { Type } from "@sinclair/typebox";
import {
  ToolRegistry,
  type AgentTool,
  type ToolExecutionContext,
} from "../../src/tools/toolRegistry";

interface EchoInput {
  readonly value: string;
}

interface EchoOutput {
  readonly echoed: string;
}

class EchoAgentTool implements AgentTool<EchoInput, EchoOutput> {
  public readonly name = "echo";
  public readonly description = "Echo validated text";
  public readonly risk = "read" as const;
  public readonly classification = "content-read" as const;
  public readonly inputSchema = Type.Object(
    { value: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object(
    { echoed: Type.String() },
    { additionalProperties: false },
  );
  public executeCount = 0;

  public isAvailable(): boolean {
    return true;
  }

  public async execute(input: EchoInput): Promise<EchoOutput> {
    this.executeCount += 1;
    return { echoed: input.value };
  }
}

const CONTEXT: ToolExecutionContext = {
  chatId: "chat-1",
  runId: "run-1",
  hasFileWorkspace: false,
  vault: true,
  readableNoteIds: new Set<string>(),
  secretNotebookIds: new Set<string>(),
  agentPlan: { plan: null },
  readOnly: false,
};

describe("ToolRegistry", () => {
  test("rejects invalid model arguments before executing a tool", async () => {
    const tool = new EchoAgentTool();
    const registry = new ToolRegistry();
    registry.register(tool);

    await expect(
      registry.execute(
        { id: "call-1", name: "echo", arguments: { value: 42 } },
        CONTEXT,
      ),
    ).rejects.toThrow("expected schema for tool echo");
    expect(tool.executeCount).toBe(0);
  });

  test("coerces numeric strings for number fields without widening other types", async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoAgentTool());
    registry.register(new CountTool());

    await expect(
      registry.execute(
        { id: "call-1", name: "echo", arguments: { value: 42 } },
        CONTEXT,
      ),
    ).rejects.toThrow("expected schema for tool echo");

    const counted = await registry.execute(
      { id: "call-2", name: "count", arguments: { amount: "7" } },
      CONTEXT,
    );
    expect(counted.output).toEqual({ amount: 7 });
  });

  test("omits propose-write tools when readOnly is enabled", () => {
    const registry = new ToolRegistry();
    registry.register(new EchoAgentTool());
    registry.register(new WriteTool());
    registry.register(new MetaTool());

    const all = registry.providerDefinitions(CONTEXT).map((tool) => tool.name);
    const ask = registry
      .providerDefinitions(CONTEXT, { readOnly: true })
      .map((tool) => tool.name);
    const proposeOnly = registry
      .providerDefinitions(CONTEXT, { proposeOnly: true })
      .map((tool) => tool.name);

    expect(all).toEqual(["echo", "write_note", "set_plan"]);
    expect(ask).toEqual(["echo", "set_plan"]);
    expect(proposeOnly).toEqual(["write_note", "set_plan"]);
    expect(registry.hasProposeWriteTools(CONTEXT, { readOnly: true })).toBe(
      false,
    );
  });

  test("omits inventory tools when blockDiscovery is enabled", () => {
    const registry = new ToolRegistry();
    registry.register(new EchoAgentTool());
    registry.register(new ListNotebooksTool());
    registry.register(new MetaTool());

    const blocked = registry
      .providerDefinitions(CONTEXT, { blockDiscovery: true })
      .map((tool) => tool.name);

    expect(blocked).toEqual(["echo", "set_plan"]);
    expect(registry.isDiscoveryTool("catalog")).toBe(true);
    expect(registry.isDiscoveryTool("echo")).toBe(false);
  });

  test("rejects write execution in read-only mode without calling the tool", async () => {
    const registry = new ToolRegistry();
    const tool = new WriteTool();
    registry.register(tool);
    const execution = registry.beginGuardedExecution({
      readOnly: true,
      proposeOnly: false,
      blockDiscovery: false,
      priorToolNames: [],
      abortSignal: new AbortController().signal,
    });

    const result = await execution.execute(
      { id: "call-1", name: "write_note", arguments: {} },
      CONTEXT,
    );

    expect(result.output).toEqual({
      error: {
        code: "NOT_AVAILABLE",
        message:
          "Write tool write_note is disabled in Ask mode; expected a read-only tool",
      },
    });
    expect(tool.executeCount).toBe(0);
  });

  test("rejects read execution after the content-read budget", async () => {
    const registry = new ToolRegistry();
    const tool = new EchoAgentTool();
    registry.register(tool);
    const execution = registry.beginGuardedExecution({
      readOnly: false,
      proposeOnly: true,
      blockDiscovery: false,
      priorToolNames: [],
      abortSignal: new AbortController().signal,
    });

    const result = await execution.execute(
      { id: "call-1", name: "echo", arguments: { value: "ignored" } },
      CONTEXT,
    );

    expect(result.output).toEqual({
      error: {
        code: "NOT_AVAILABLE",
        message:
          "Read tool echo is disabled after the read budget; expected a propose-write tool",
      },
    });
    expect(tool.executeCount).toBe(0);
  });

  test("caps classified discovery executions per run segment", async () => {
    const registry = new ToolRegistry();
    registry.register(new ListNotebooksTool());
    const execution = registry.beginGuardedExecution({
      readOnly: false,
      proposeOnly: false,
      blockDiscovery: false,
      priorToolNames: Array<string>(10).fill("catalog"),
      abortSignal: new AbortController().signal,
    });

    const result = await execution.execute(
      { id: "call-1", name: "catalog", arguments: {} },
      CONTEXT,
    );

    expect(result.output).toEqual({
      error: {
        code: "NOT_AVAILABLE",
        message:
          "Discovery tool catalog hit the per-segment cap of 10; call set_agent_plan then read and propose a bounded batch",
      },
    });
    expect(execution.discoveryCapped).toBe(true);
  });

  test("counts only classified content reads", async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoAgentTool());
    registry.register(new CountTool());
    const execution = registry.beginGuardedExecution({
      readOnly: false,
      proposeOnly: false,
      blockDiscovery: false,
      priorToolNames: [],
      abortSignal: new AbortController().signal,
    });

    await execution.execute(
      { id: "call-1", name: "echo", arguments: { value: "read" } },
      CONTEXT,
    );
    await execution.execute(
      { id: "call-2", name: "count", arguments: { amount: 1 } },
      CONTEXT,
    );

    expect(execution.contentReadCount).toBe(1);
  });

  test("returns invalid tool output as a guarded failure", async () => {
    const registry = new ToolRegistry();
    registry.register(new InvalidOutputTool());
    const execution = registry.beginGuardedExecution({
      readOnly: false,
      proposeOnly: false,
      blockDiscovery: false,
      priorToolNames: [],
      abortSignal: new AbortController().signal,
    });

    const result = await execution.execute(
      { id: "call-1", name: "invalid_output", arguments: {} },
      CONTEXT,
    );

    expect(result.output).toEqual({
      error: {
        code: "VALIDATION",
        message:
          'Invalid tool value {"ok":"not-a-boolean"}; expected output schema for tool invalid_output',
      },
    });
  });

  test("rejects an aborted guarded execution before calling the tool", async () => {
    const registry = new ToolRegistry();
    const tool = new EchoAgentTool();
    registry.register(tool);
    const abortController = new AbortController();
    abortController.abort("cancelled");
    const execution = registry.beginGuardedExecution({
      readOnly: false,
      proposeOnly: false,
      blockDiscovery: false,
      priorToolNames: [],
      abortSignal: abortController.signal,
    });

    await expect(
      execution.execute(
        { id: "call-1", name: "echo", arguments: { value: "ignored" } },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(tool.executeCount).toBe(0);
  });
});

class ListNotebooksTool implements AgentTool<
  Record<string, never>,
  { ok: boolean }
> {
  public readonly name = "catalog";
  public readonly description = "List notebooks";
  public readonly risk = "read" as const;
  public readonly classification = "discovery" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
class WriteTool implements AgentTool<Record<string, never>, { ok: boolean }> {
  public readonly name = "write_note";
  public readonly description = "Propose a note write";
  public readonly risk = "propose-write" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });
  public executeCount = 0;

  public isAvailable(): boolean {
    return true;
  }

  public async execute(): Promise<{ ok: boolean }> {
    this.executeCount += 1;
    return { ok: true };
  }
}

class MetaTool implements AgentTool<Record<string, never>, { ok: boolean }> {
  public readonly name = "set_plan";
  public readonly description = "Set a plan";
  public readonly risk = "meta" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

class CountTool implements AgentTool<{ amount: number }, { amount: number }> {
  public readonly name = "count";
  public readonly description = "Echo a number";
  public readonly risk = "read" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    { amount: Type.Number({ minimum: 0 }) },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ amount: Type.Number() });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(input: { amount: number }): Promise<{ amount: number }> {
    return { amount: input.amount };
  }
}

class InvalidOutputTool implements AgentTool<Record<string, never>, object> {
  public readonly name = "invalid_output";
  public readonly description = "Return invalid output";
  public readonly risk = "read" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object({});
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(): Promise<object> {
    return { ok: "not-a-boolean" };
  }
}
