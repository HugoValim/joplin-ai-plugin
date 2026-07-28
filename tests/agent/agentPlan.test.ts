import {
  AGENT_PLAN_MAX_ITEMS,
  agentPlanContinuationNudge,
  agentPlanSummaryText,
  pendingAgentPlanCount,
  setAgentPlan,
  updateAgentPlanItem,
} from "../../src/agent/agentPlan";

describe("agentPlan", () => {
  test("builds a pending checklist and updates item status", () => {
    const plan = setAgentPlan([
      { id: "1", content: "Improve FWS notes" },
      { id: "2", content: "Tighten roadmap", status: "in_progress" },
    ]);
    expect(plan.items).toHaveLength(2);
    expect(pendingAgentPlanCount(plan)).toBe(2);
    expect(agentPlanSummaryText(plan)).toContain("1 in progress");

    const next = updateAgentPlanItem(plan, "1", "completed");
    expect(next.items[0]?.status).toBe("completed");
    expect(pendingAgentPlanCount(next)).toBe(1);
  });

  test("rejects empty, oversized, and duplicate plans", () => {
    expect(() => setAgentPlan([])).toThrow("expected 1 to");
    expect(() =>
      setAgentPlan(
        Array.from({ length: AGENT_PLAN_MAX_ITEMS + 1 }, (_, index) => ({
          id: String(index + 1),
          content: `Item ${index + 1}`,
        })),
      ),
    ).toThrow(`at most ${AGENT_PLAN_MAX_ITEMS}`);
    expect(() =>
      setAgentPlan([
        { id: "1", content: "One" },
        { id: "1", content: "Dup" },
      ]),
    ).toThrow("Duplicate agent plan item id");
  });

  test("requires an active plan before status updates", () => {
    expect(() => updateAgentPlanItem(null, "1", "completed")).toThrow(
      "No active agent plan",
    );
    const plan = setAgentPlan([{ id: "1", content: "Only" }]);
    expect(() => updateAgentPlanItem(plan, "missing", "completed")).toThrow(
      "Unknown agent plan item",
    );
  });

  test("builds a continuation nudge while work remains", () => {
    const plan = setAgentPlan([
      { id: "1", content: "Improve FWS notes" },
      { id: "2", content: "Done already", status: "completed" },
    ]);
    const nudge = agentPlanContinuationNudge(plan);
    expect(nudge).toContain("ACTIVE AGENT PLAN");
    expect(nudge).toContain("Improve FWS notes");
    expect(agentPlanContinuationNudge(updateAgentPlanItem(plan, "1", "completed"))).toBeNull();
  });
});
