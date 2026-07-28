import { ToolRegistry } from "../../src/tools/toolRegistry";
import { SubAgentRegistry } from "../../src/agent/subAgentRegistry";
import { registerSubAgentTools } from "../../src/tools/subAgentTools";
import type { ToolExecutionContext } from "../../src/tools/toolRegistry";

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    chatId: "chat-1",
    runId: "run-1",
    hasFileWorkspace: false,
    vault: false,
    readOnly: false,
    readableNoteIds: new Set(),
    secretNotebookIds: new Set(),
    agentPlan: { plan: null },
    ...overrides,
  };
}

describe("subagent tools", () => {
  test("start_subagent succeeds under the concurrency cap", async () => {
    const registry = new SubAgentRegistry(3);
    const tools = new ToolRegistry();
    registerSubAgentTools(registry, tools);

    const result = await tools.execute(
      { id: "call-1", name: "start_subagent", arguments: { subagent_id: "sub-1", task: "Read and summarize notes" } },
      context(),
    );
    expect(result.output).toMatchObject({
      subagent_id: "sub-1",
      status: "started",
      active_count: 1,
    });
  });

  test("start_subagent refuses beyond the cap", async () => {
    const registry = new SubAgentRegistry(3);
    const tools = new ToolRegistry();
    registerSubAgentTools(registry, tools);
    const ctx = context();

    await tools.execute({ id: "c1", name: "start_subagent", arguments: { subagent_id: "s1", task: "t" } }, ctx);
    await tools.execute({ id: "c2", name: "start_subagent", arguments: { subagent_id: "s2", task: "t" } }, ctx);
    await tools.execute({ id: "c3", name: "start_subagent", arguments: { subagent_id: "s3", task: "t" } }, ctx);
    const result = await tools.execute(
      { id: "c4", name: "start_subagent", arguments: { subagent_id: "s4", task: "t" } },
      ctx,
    );
    expect(result.output).toMatchObject({ status: "refused", active_count: 3 });
  });

  test("complete_subagent frees a slot", async () => {
    const registry = new SubAgentRegistry(3);
    const tools = new ToolRegistry();
    registerSubAgentTools(registry, tools);
    const ctx = context();

    await tools.execute({ id: "c1", name: "start_subagent", arguments: { subagent_id: "s1", task: "t" } }, ctx);
    await tools.execute({ id: "c2", name: "complete_subagent", arguments: { subagent_id: "s1", task: "done" } }, ctx);
    expect(registry.activeCount).toBe(0);
  });

  test("start_subagent is unavailable in read-only mode", () => {
    const registry = new SubAgentRegistry(3);
    const tools = new ToolRegistry();
    registerSubAgentTools(registry, tools);

    const defs = tools.providerDefinitions(context({ readOnly: true }));
    expect(defs.some((d) => d.name === "start_subagent")).toBe(false);
  });
});
