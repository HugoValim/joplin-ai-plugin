import { SubAgentRegistry } from "../../src/agent/subAgentRegistry";

describe("SubAgentRegistry", () => {
  test("starts subagents up to the concurrency cap", () => {
    const registry = new SubAgentRegistry(3);
    expect(registry.tryStart("sub-1")).toBe(true);
    expect(registry.tryStart("sub-2")).toBe(true);
    expect(registry.tryStart("sub-3")).toBe(true);
    expect(registry.activeCount).toBe(3);
    expect(registry.remaining).toBe(0);
  });

  test("refuses spawns beyond the cap", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1");
    registry.tryStart("sub-2");
    registry.tryStart("sub-3");
    expect(registry.tryStart("sub-4")).toBe(false);
  });

  test("allows new spawns after one completes", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1");
    registry.tryStart("sub-2");
    registry.tryStart("sub-3");
    registry.complete("sub-2");
    expect(registry.tryStart("sub-4")).toBe(true);
  });

  test("rejects duplicate subagent IDs", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1");
    expect(registry.tryStart("sub-1")).toBe(false);
  });

  test("cancelAll clears all active subagents", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1");
    registry.tryStart("sub-2");
    registry.cancelAll();
    expect(registry.activeCount).toBe(0);
    expect(registry.has("sub-1")).toBe(false);
  });

  test("reports has for active and completed subagents", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1");
    expect(registry.has("sub-1")).toBe(true);
    registry.complete("sub-1");
    expect(registry.has("sub-1")).toBe(false);
  });
});
