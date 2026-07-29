import { SubAgentRegistry } from "../../src/agent/subAgentRegistry";

describe("SubAgentRegistry", () => {
  test("starts subagents up to the concurrency cap", () => {
    const registry = new SubAgentRegistry(3);
    expect(registry.tryStart("sub-1", new AbortController())).toBe(true);
    expect(registry.tryStart("sub-2", new AbortController())).toBe(true);
    expect(registry.tryStart("sub-3", new AbortController())).toBe(true);
    expect(registry.activeCount).toBe(3);
    expect(registry.remaining).toBe(0);
  });

  test("refuses spawns beyond the cap", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1", new AbortController());
    registry.tryStart("sub-2", new AbortController());
    registry.tryStart("sub-3", new AbortController());
    expect(registry.tryStart("sub-4", new AbortController())).toBe(false);
  });

  test("allows new spawns after one completes", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1", new AbortController());
    registry.tryStart("sub-2", new AbortController());
    registry.tryStart("sub-3", new AbortController());
    registry.complete("sub-2");
    expect(registry.tryStart("sub-4", new AbortController())).toBe(true);
  });

  test("rejects duplicate subagent IDs", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1", new AbortController());
    expect(registry.tryStart("sub-1", new AbortController())).toBe(false);
  });

  test("cancelAll aborts live controllers and clears the registry", () => {
    const registry = new SubAgentRegistry(3);
    const first = new AbortController();
    const second = new AbortController();
    registry.tryStart("sub-1", first);
    registry.tryStart("sub-2", second);
    registry.cancelAll();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(registry.activeCount).toBe(0);
    expect(registry.has("sub-1")).toBe(false);
  });

  test("abort cancels one subagent and frees its slot", () => {
    const registry = new SubAgentRegistry(3);
    const controller = new AbortController();
    registry.tryStart("sub-1", controller);
    registry.tryStart("sub-2", new AbortController());
    registry.abort("sub-1");
    expect(controller.signal.aborted).toBe(true);
    expect(registry.has("sub-1")).toBe(false);
    expect(registry.activeCount).toBe(1);
  });

  test("reports has for active and completed subagents", () => {
    const registry = new SubAgentRegistry(3);
    registry.tryStart("sub-1", new AbortController());
    expect(registry.has("sub-1")).toBe(true);
    registry.complete("sub-1");
    expect(registry.has("sub-1")).toBe(false);
  });
});
