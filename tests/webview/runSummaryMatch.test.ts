import { runSummaryForMessage } from "../../src/webview/runSummaryMatch";
import type { ActiveChatView } from "../../src/shared/protocol";

type ChatMessage = ActiveChatView["messages"][number];
type RunSummary = ActiveChatView["runSummaries"][number];

describe("runSummaryForMessage", () => {
  test("maps assistant messages to completed run summaries by order", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Hi", createdAt: 1 },
      { id: "a1", role: "assistant", content: "Hello", createdAt: 2 },
    ];
    const runSummaries: RunSummary[] = [
      {
        runId: "run-1",
        status: "completed",
        summary: "Completed",
        completedAt: 3,
        totalTokens: 10,
      },
    ];

    expect(runSummaryForMessage(messages[1]!, messages, runSummaries)).toEqual(
      runSummaries[0],
    );
  });
});
