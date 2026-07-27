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
});
