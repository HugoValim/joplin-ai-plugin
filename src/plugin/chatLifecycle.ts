import { randomUUID } from "crypto";
import type { AgentRunOutcome } from "../agent/agentRunner";
import type { ContextCitation } from "../agent/contextBuilder";
import type {
  ChatStore,
  PersistedChat,
  PersistedChatMessage,
} from "../persistence/chatStore";
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

export function lastUserMessage(
  chat: PersistedChat,
): PersistedChatMessage | null {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (message?.role === "user") return message;
  }
  return null;
}

/**
 * Removes the target assistant message and every message after it.
 *
 * @example truncateForRegenerate(chat, assistantMessageId)
 */
export function truncateForRegenerate(
  chat: PersistedChat,
  messageId: string,
): PersistedChat {
  const index = chat.messages.findIndex((message) => message.id === messageId);
  if (index < 0) {
    throw new DomainError(
      "NOT_AVAILABLE",
      `Unknown message ${safeValue(messageId)}; expected an existing transcript message`,
    );
  }
  const target = chat.messages[index];
  if (!target || target.role !== "assistant") {
    throw new DomainError(
      "VALIDATION",
      `Message ${safeValue(messageId)} is not an assistant message; expected assistant role for regenerate`,
    );
  }
  return {
    ...chat,
    updatedAt: Date.now(),
    messages: chat.messages.slice(0, index),
  };
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
    pendingChangeSet: nextPendingChangeSet(
      current.pendingChangeSet,
      outcome.changeSet,
    ),
  });
}

function nextPendingChangeSet(
  current: PersistedChat["pendingChangeSet"],
  outcome: NonNullable<PersistedChat["pendingChangeSet"]> | null,
): PersistedChat["pendingChangeSet"] {
  if (outcome) return outcome;
  if (
    current &&
    (current.status === "applied" || current.status === "partial")
  ) {
    return current;
  }
  return null;
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
    ...(outcome.usage
      ? {
          promptTokens: outcome.usage.promptTokens,
          outputTokens: outcome.usage.outputTokens,
          totalTokens: outcome.usage.totalTokens,
        }
      : {}),
    ...(outcome.toolNames.length ? { toolNames: [...outcome.toolNames] } : {}),
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
