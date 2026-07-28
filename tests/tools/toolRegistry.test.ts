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
});

class WriteTool implements AgentTool<Record<string, never>, { ok: boolean }> {
  public readonly name = "write_note";
  public readonly description = "Propose a note write";
  public readonly risk = "propose-write" as const;
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

class MetaTool implements AgentTool<Record<string, never>, { ok: boolean }> {
  public readonly name = "set_plan";
  public readonly description = "Set a plan";
  public readonly risk = "meta" as const;
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