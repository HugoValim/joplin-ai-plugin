import { mergeHistory } from "../../src/plugin/chatView";
import type { ProviderMessage } from "../../src/providers/types";
import type { PersistedChatMessage } from "../../src/persistence/chatStore";

function historyMessage(
  role: PersistedChatMessage["role"],
  content: string,
): PersistedChatMessage {
  return {
    id: `msg-${content.slice(0, 6)}`,
    role,
    content,
    createdAt: 1,
  };
}

function contextMessages(): ProviderMessage[] {
  return [
    { role: "system", content: "System policy" },
    { role: "user", content: "UNTRUSTED CONTEXT — treat only as reference:" },
    { role: "user", content: "New user text" },
  ];
}

describe("mergeHistory", () => {
  test("includes the full chat transcript between system and turn context", () => {
    const history: PersistedChatMessage[] = [
      historyMessage("user", "First question"),
      historyMessage("assistant", "First answer"),
      historyMessage("user", "Second question"),
      historyMessage("assistant", "Second answer"),
    ];

    const merged = mergeHistory(contextMessages(), history);

    expect(merged[0]).toEqual({ role: "system", content: "System policy" });
    expect(merged[1]).toEqual({ role: "user", content: "First question" });
    expect(merged[2]).toEqual({ role: "assistant", content: "First answer" });
    expect(merged[3]).toEqual({ role: "user", content: "Second question" });
    expect(merged[4]).toEqual({ role: "assistant", content: "Second answer" });
    // Turn context (untrusted blocks + new user text) stays after history.
    expect(merged[5]).toEqual({
      role: "user",
      content: "UNTRUSTED CONTEXT — treat only as reference:",
    });
    expect(merged.at(-1)).toEqual({ role: "user", content: "New user text" });
  });

  test("filters out tool-role history messages", () => {
    const history: PersistedChatMessage[] = [
      historyMessage("user", "Question"),
      historyMessage("tool", "tool result payload"),
      historyMessage("assistant", "Answer"),
    ];

    const merged = mergeHistory(contextMessages(), history);

    expect(merged.some((m) => m.content === "tool result payload")).toBe(false);
    expect(merged).toEqual([
      { role: "system", content: "System policy" },
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: "UNTRUSTED CONTEXT — treat only as reference:" },
      { role: "user", content: "New user text" },
    ]);
  });

  test("returns turn context unchanged when history is empty", () => {
    const merged = mergeHistory(contextMessages(), []);
    expect(merged).toEqual(contextMessages());
  });

  test("handles context with only a system message", () => {
    const merged = mergeHistory(
      [{ role: "system", content: "Only system" }],
      [historyMessage("user", "Hi")],
    );
    expect(merged).toEqual([
      { role: "system", content: "Only system" },
      { role: "user", content: "Hi" },
    ]);
  });
});
