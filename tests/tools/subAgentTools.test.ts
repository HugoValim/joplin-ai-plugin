import { ToolRegistry } from "../../src/tools/toolRegistry";
import { registerSubAgentTools } from "../../src/tools/subAgentTools";
import type {
  SubAgentSpawnResult,
  ToolExecutionContext,
} from "../../src/tools/toolRegistry";

function context(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
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
  test("start_subagent awaits the host and returns its result", async () => {
    const tools = new ToolRegistry();
    registerSubAgentTools(tools);
    const hostResult: SubAgentSpawnResult = {
      subagent_id: "sub-1",
      status: "completed",
      message: "done",
      result_text: "findings",
      active_count: 0,
    };

    const result = await tools.execute(
      {
        id: "call-1",
        name: "start_subagent",
        arguments: { subagent_id: "sub-1", task: "Read and summarize notes" },
      },
      context({
        runSubAgent: async (): Promise<SubAgentSpawnResult> => hostResult,
      }),
    );
    expect(result.output).toMatchObject({
      subagent_id: "sub-1",
      status: "completed",
      result_text: "findings",
      active_count: 0,
    });
  });

  test("complete_subagent aborts via the host", async () => {
    const tools = new ToolRegistry();
    registerSubAgentTools(tools);
    const aborted: string[] = [];

    await tools.execute(
      {
        id: "c1",
        name: "complete_subagent",
        arguments: { subagent_id: "s1", task: "done" },
      },
      context({
        abortSubAgent: (id): number => {
          aborted.push(id);
          return 0;
        },
      }),
    );
    expect(aborted).toEqual(["s1"]);
  });

  test("start_subagent is unavailable in read-only mode", () => {
    const tools = new ToolRegistry();
    registerSubAgentTools(tools);

    const defs = tools.providerDefinitions(
      context({
        readOnly: true,
        runSubAgent: async (): Promise<SubAgentSpawnResult> => ({
          subagent_id: "x",
          status: "completed",
          message: "m",
          result_text: "",
          active_count: 0,
        }),
      }),
    );
    expect(defs.some((d) => d.name === "start_subagent")).toBe(false);
  });

  test("start_subagent is unavailable without a host hook", () => {
    const tools = new ToolRegistry();
    registerSubAgentTools(tools);
    const defs = tools.providerDefinitions(context());
    expect(defs.some((d) => d.name === "start_subagent")).toBe(false);
  });
});
