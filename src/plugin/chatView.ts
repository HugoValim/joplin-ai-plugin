import type { ProviderMessage } from "../providers/types";
import type {
  ChangeSet,
  ChangeSetStore,
  ProposedChange,
} from "../persistence/changeSetStore";
import type {
  PersistedChat,
  PersistedChatMessage,
} from "../persistence/chatStore";
import type { ActiveChatView, ChangeSetView } from "../shared/protocol";

export function mergeHistory(
  context: readonly ProviderMessage[],
  history: readonly PersistedChatMessage[],
): ProviderMessage[] {
  const [system, ...turnContext] = context;
  if (!system) return [...turnContext];
  return [
    system,
    ...history
      .filter((message) => message.role !== "tool")
      .map((message) => ({ role: message.role, content: message.content })),
    ...turnContext,
  ];
}

export function toActiveChat(
  chat: PersistedChat,
  changes: ChangeSetStore,
): ActiveChatView {
  const pending = chat.pendingChangeSet;
  if (pending) changes.restore(pending);
  return {
    id: chat.id,
    title: chat.title,
    messages: chat.messages,
    context: chat.context,
    externalRoot: chat.externalRoot,
    pendingChangeSet: pending ? toChangeSetView(pending) : null,
  };
}

export function toChangeSetView(changeSet: ChangeSet): ChangeSetView {
  return {
    changeSetId: changeSet.id,
    runId: changeSet.runId,
    changes: changeSet.changes.map(toChangeView),
  };
}

function toChangeView(
  change: ProposedChange,
): ChangeSetView["changes"][number] {
  const targetId =
    change.kind === "file"
      ? change.relativePath
      : change.operation === "update"
        ? change.noteId
        : change.parentId;
  return {
    id: change.id,
    kind: change.kind,
    targetId,
    targetLabel: change.targetLabel,
    before: change.before,
    after: change.after,
    diff: change.diff,
    status: change.status,
    ...(change.message ? { message: change.message } : {}),
  };
}
