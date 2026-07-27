import { randomUUID } from "crypto";
import type { AgentRunOutcome } from "../agent/agentRunner";
import type { ContextCitation } from "../agent/contextBuilder";
import type { ChatStore, PersistedChat } from "../persistence/chatStore";
import { DomainError, safeValue } from "../shared/errors";
import type { PerChatWorkspaceResolver } from "./workspaceAdapters";

export async function requireChat(
  chats: ChatStore,
  chatId: string,
): Promise<PersistedChat> {
  const chat = await chats.get(chatId);
  if (chat) return chat;
  throw new DomainError(
    "NOT_AVAILABLE",
    `Unknown chat ${safeValue(chatId)}; expected a persisted chat`,
  );
}

export async function deleteChatAndChooseNext(
  chats: ChatStore,
  workspaces: PerChatWorkspaceResolver,
  chatId: string,
): Promise<string> {
  await chats.delete(chatId);
  workspaces.setRoot(chatId, null);
  const remaining = await chats.list();
  const next = remaining[0] ?? (await chats.create());
  return next.id;
}

/**
 * Saves a model outcome without retaining streamed or retrieved context.
 *
 * @example await persistRunOutcome(chats, chat, runId, outcome, citations)
 */
export async function persistRunOutcome(
  chats: ChatStore,
  chat: PersistedChat,
  runId: string,
  outcome: AgentRunOutcome,
  citations: readonly ContextCitation[],
): Promise<void> {
  const current = await requireChat(chats, chat.id);
  assertLatestTurn(current, chat);
  await chats.save({
    ...current,
    updatedAt: Date.now(),
    messages: appendAssistantMessage(current, outcome, citations),
    references: [...current.references, ...citations],
    runSummaries: [...current.runSummaries, toRunSummary(runId, outcome)],
    pendingChangeSet: outcome.changeSet,
  });
}

function appendAssistantMessage(
  chat: PersistedChat,
  outcome: AgentRunOutcome,
  citations: readonly ContextCitation[],
): PersistedChat["messages"] {
  if (!outcome.assistantText) return chat.messages;
  return [
    ...chat.messages,
    {
      id: randomUUID(),
      role: "assistant",
      content: outcome.assistantText,
      createdAt: Date.now(),
      citations: [...citations],
    },
  ];
}

function toRunSummary(
  runId: string,
  outcome: AgentRunOutcome,
): PersistedChat["runSummaries"][number] {
  return {
    runId,
    status: outcome.status,
    summary:
      outcome.status === "awaiting-approval" ? "Changes proposed" : "Completed",
    completedAt: Date.now(),
  };
}

function assertLatestTurn(
  current: PersistedChat,
  submitted: PersistedChat,
): void {
  const currentMessage = current.messages.at(-1)?.id;
  const submittedMessage = submitted.messages.at(-1)?.id;
  if (currentMessage === submittedMessage) return;
  throw new DomainError(
    "CONFLICT",
    `Chat ${current.id} changed during model run; expected latest message ${safeValue(submittedMessage)}`,
  );
}
