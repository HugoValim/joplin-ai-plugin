import type { AgentContinuation } from "../../src/agent/agentRunner";
import { AgentContinuationStore } from "../../src/plugin/agentContinuationStore";

const CONTINUATION: AgentContinuation = {
  messages: [{ role: "user", content: "Original request" }],
  nextStep: 2,
  toolCallCount: 1,
};

describe("AgentContinuationStore", () => {
  test("keeps pending model context in memory until approval consumes it", () => {
    const store = new AgentContinuationStore();
    store.save("changes-1", {
      chatId: "chat-1",
      hasFileWorkspace: true,
      continuation: CONTINUATION,
      citations: [],
    });

    expect(store.take("changes-1")).toEqual({
      chatId: "chat-1",
      hasFileWorkspace: true,
      continuation: CONTINUATION,
      citations: [],
    });
    expect(store.take("changes-1")).toBeNull();
  });

  test("drops pending context when its chat is cleared", () => {
    const store = new AgentContinuationStore();
    store.save("changes-1", {
      chatId: "chat-1",
      hasFileWorkspace: true,
      continuation: CONTINUATION,
      citations: [],
    });

    store.deleteChat("chat-1");

    expect(store.take("changes-1")).toBeNull();
  });
});
