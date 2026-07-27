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
});
