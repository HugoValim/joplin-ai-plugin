import { registerAgentPlanTools } from "../../src/tools/agentPlanTools";
import { ToolRegistry } from "../../src/tools/toolRegistry";
import { toolContext } from "../helpers/toolContext";

describe("agentPlanTools", () => {
  test("sets and updates the shared plan on the tool context", async () => {
    const registry = new ToolRegistry();
    registerAgentPlanTools(registry);
    const context = toolContext();

    const setResult = await registry.execute(
      {
        id: "set-1",
        name: "set_agent_plan",
        arguments: {
          items: [
            { id: "1", content: "Improve FWS notes" },
            { id: "2", content: "Tighten roadmap" },
          ],
        },
      },
      context,
    );
    expect(setResult.risk).toBe("meta");
    expect(context.agentPlan.plan?.items).toHaveLength(2);
    const setOutput = setResult.output as { summary: string };
    expect(setOutput.summary).toContain("2 pending");

    const updateResult = await registry.execute(
      {
        id: "upd-1",
        name: "update_agent_plan_item",
        arguments: { id: "1", status: "completed" },
      },
      context,
    );
    expect(context.agentPlan.plan?.items[0]?.status).toBe("completed");
    const updateOutput = updateResult.output as { summary: string };
    expect(updateOutput.summary).toContain("1 completed");
  });

  test("keeps meta tools available in proposeOnly and Ask mode", () => {
    const registry = new ToolRegistry();
    registerAgentPlanTools(registry);
    const context = toolContext();

    expect(
      registry
        .providerDefinitions(context, { proposeOnly: true })
        .map((tool) => tool.name),
    ).toEqual(["set_agent_plan", "update_agent_plan_item"]);
    expect(
      registry
        .providerDefinitions(context, { readOnly: true })
        .map((tool) => tool.name),
    ).toEqual(["set_agent_plan", "update_agent_plan_item"]);
  });
});
