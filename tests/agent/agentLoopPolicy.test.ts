import { Type } from "@sinclair/typebox";
import { AgentLoopPolicyState } from "../../src/agent/agentLoopPolicy";
import { setAgentPlan } from "../../src/agent/agentPlan";
import type { ProviderMessage } from "../../src/providers/types";
import type {
  AgentTool,
  AgentToolClassification,
  ToolExecutionContext,
  ToolRisk,
} from "../../src/tools/toolRegistry";
import { ToolRegistry } from "../../src/tools/toolRegistry";

class AvailableTool implements AgentTool<
  Record<string, never>,
  { ok: boolean }
> {
  public readonly description = "Available test tool";
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });

  public constructor(
    public readonly name: string,
    public readonly risk: ToolRisk,
    public readonly classification: AgentToolClassification = "other",
  ) {}

  public isAvailable(): boolean {
    return true;
  }

  public async execute(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

describe("AgentLoopPolicyState", () => {
  test("activates propose-only once when content reads reach the limit", () => {
    const tools = new ToolRegistry();
    tools.register(new AvailableTool("propose_note", "propose-write"));
    const messages: ProviderMessage[] = [];
    const state = new AgentLoopPolicyState(false, tools, toolContext());

    state.recordToolBatch(
      { proposed: false, discoveryCapped: false, contentReadCount: 8 },
      messages,
      [],
    );

    expect(state.prepareModelStep(messages)).toEqual({
      proposeOnly: true,
      readOnly: false,
      blockDiscovery: false,
    });
    expect(state.prepareModelStep(messages).proposeOnly).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("READ BUDGET EXCEEDED");
  });

  test("reports proposal batches as awaiting approval", () => {
    const tools = new ToolRegistry();
    const state = new AgentLoopPolicyState(false, tools, toolContext());

    const transition = state.recordToolBatch(
      { proposed: true, discoveryCapped: false, contentReadCount: 0 },
      [],
      ["propose_note"],
    );

    expect(transition).toEqual({ action: "awaiting-approval" });
  });

  test("blocks discovery and requests a plan after broad inventory", () => {
    const tools = new ToolRegistry();
    tools.register(new AvailableTool("list_notebooks", "read", "discovery"));
    tools.register(
      new AvailableTool("list_notebook_notes", "read", "discovery"),
    );
    tools.register(new AvailableTool("set_agent_plan", "meta"));
    const messages: ProviderMessage[] = [];
    const state = new AgentLoopPolicyState(false, tools, toolContext());

    state.recordToolBatch(
      { proposed: false, discoveryCapped: false, contentReadCount: 0 },
      messages,
      ["list_notebooks", "list_notebook_notes"],
    );

    expect(state.prepareModelStep(messages).blockDiscovery).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("PLAN REQUIRED");
  });

  test("exhausts repeated proposal bailouts at the existing limit", () => {
    const tools = new ToolRegistry();
    tools.register(new AvailableTool("propose_note", "propose-write"));
    const messages: ProviderMessage[] = [];
    const state = new AgentLoopPolicyState(false, tools, toolContext());
    state.recordToolBatch(
      { proposed: false, discoveryCapped: false, contentReadCount: 8 },
      messages,
      [],
    );
    state.prepareModelStep(messages);

    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(state.recordTextOnlyStep(messages, [], false)).toEqual({
        action: "continue",
      });
    }
    expect(state.recordTextOnlyStep(messages, [], false)).toEqual({
      action: "complete",
      reason: "bailout-exhausted",
    });
  });

  test("stops repeated tool-step intent under an active plan", () => {
    const context = toolContext();
    context.agentPlan.plan = setAgentPlan([
      { id: "1", content: "Improve notes" },
    ]);
    const state = new AgentLoopPolicyState(false, new ToolRegistry(), context);
    const repeated = "Read the next notes and propose the planned changes";

    expect(state.recordToolStep(repeated)).toEqual({ action: "continue" });
    expect(state.recordToolStep(repeated)).toEqual({ action: "continue" });
    expect(state.recordToolStep(repeated)).toEqual({
      action: "complete",
      reason: "stuck",
    });
  });
});

function toolContext(): ToolExecutionContext {
  return {
    chatId: "chat-1",
    runId: "run-1",
    hasFileWorkspace: false,
    vault: false,
    readOnly: false,
    readableNoteIds: new Set<string>(),
    secretNotebookIds: new Set<string>(),
    agentPlan: { plan: null },
  };
}
