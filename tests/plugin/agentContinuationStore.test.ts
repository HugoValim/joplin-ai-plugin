import type { AgentContinuation } from "../../src/agent/agentRunner";
import { AgentContinuationStore } from "../../src/plugin/agentContinuationStore";

const CONTINUATION: AgentContinuation = {
  messages: [{ role: "user", content: "Original request" }],
  nextStep: 2,
  toolCallCount: 1,
  plan: null,
};

describe("AgentContinuationStore", () => {
  test("keeps pending model context in memory until approval consumes it", () => {
    const store = new AgentContinuationStore();
    store.save("changes-1", {
      chatId: "chat-1",
      hasFileWorkspace: true,
      vault: true,
      readableNoteIds: new Set<string>(),
      secretNotebookIds: new Set<string>(),
      continuation: CONTINUATION,
      citations: [],
    });

    const pending = store.take("changes-1");
    expect(pending?.chatId).toBe("chat-1");
    expect(pending?.hasFileWorkspace).toBe(true);
    expect(pending?.vault).toBe(true);
    expect(pending?.continuation).toEqual(CONTINUATION);
    expect(store.take("changes-1")).toBeNull();
  });

  test("drops pending context when its chat is cleared", () => {
    const store = new AgentContinuationStore();
    store.save("changes-1", {
      chatId: "chat-1",
      hasFileWorkspace: true,
      vault: true,
      readableNoteIds: new Set<string>(),
      secretNotebookIds: new Set<string>(),
      continuation: CONTINUATION,
      citations: [],
    });

    store.deleteChat("chat-1");

    expect(store.take("changes-1")).toBeNull();
  });
});
