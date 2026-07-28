import type { ActiveChatView } from "../shared/protocol";

type ChatMessage = ActiveChatView["messages"][number];
type RunSummary = ActiveChatView["runSummaries"][number];

/**
 * Maps one assistant message to its persisted run summary by ordinal index.
 *
 * @example runSummaryForMessage(message, messages, runSummaries)
 */
export function runSummaryForMessage(
  message: ChatMessage,
  messages: readonly ChatMessage[],
  runSummaries: readonly RunSummary[],
): RunSummary | null {
  if (message.role !== "assistant") return null;
  const assistantMessages = messages.filter(
    (entry) => entry.role === "assistant",
  );
  const index = assistantMessages.findIndex((entry) => entry.id === message.id);
  if (index < 0) return null;
  const summaries = runSummaries.filter((summary) =>
    ["completed", "awaiting-approval", "applied"].includes(summary.status),
  );
  return summaries[index] ?? null;
}
