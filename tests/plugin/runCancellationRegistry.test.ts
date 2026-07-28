import { RunCancellationRegistry } from "../../src/plugin/runCancellationRegistry";

describe("RunCancellationRegistry", () => {
  test("ignores stale cancellation for a different run", () => {
    const registry = new RunCancellationRegistry();
    const controller = new AbortController();
    registry.replace("chat-1", "run-current", controller);

    registry.cancel("chat-1", "run-stale");

    expect(controller.signal.aborted).toBe(false);
  });

  test("cancels only the matching current run", () => {
    const registry = new RunCancellationRegistry();
    const controller = new AbortController();
    registry.replace("chat-1", "run-current", controller);

    registry.cancel("chat-1", "run-current");

    expect(controller.signal.aborted).toBe(true);
  });

  test("cancels the active run when its chat is cleared", () => {
    const registry = new RunCancellationRegistry();
    const controller = new AbortController();
    registry.replace("chat-1", "run-current", controller);

    registry.cancelChat("chat-1", "Chat cleared");

    expect(controller.signal.reason).toEqual(new Error("Chat cleared"));
  });

  test("rejects a second active run without cancelling the first", () => {
    const registry = new RunCancellationRegistry();
    const first = new AbortController();
    const second = new AbortController();

    expect(registry.tryStart("chat-1", "run-first", first)).toBe(true);
    expect(registry.tryStart("chat-1", "run-second", second)).toBe(false);

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });
});

describe("RunCancellationRegistry.has", () => {
  test("reports true while a run is active and false after it clears", () => {
    const registry = new RunCancellationRegistry();
    const controller = new AbortController();

    expect(registry.has("chat-1")).toBe(false);
    registry.replace("chat-1", "run-1", controller);
    expect(registry.has("chat-1")).toBe(true);

    registry.clearIfCurrent("chat-1", controller);
    expect(registry.has("chat-1")).toBe(false);
  });

  test("reports false for a chat that never started a run", () => {
    const registry = new RunCancellationRegistry();
    expect(registry.has("chat-unknown")).toBe(false);
  });
});
