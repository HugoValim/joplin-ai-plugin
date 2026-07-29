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
  applyTokenForPending?: (changeSetId: string) => string,
): ActiveChatView {
  const pending = chat.pendingChangeSet;
  if (pending) changes.restore(pending);
  return {
    id: chat.id,
    title: chat.title,
    messages: chat.messages,
    context: chat.context,
    externalRoot: chat.externalRoot,
    pendingChangeSet: pending
      ? toChangeSetView(pending, applyTokenForPending?.(pending.id) ?? "")
      : null,
    runSummaries: chat.runSummaries,
  };
}

export function toChangeSetView(
  changeSet: ChangeSet,
  applyToken: string,
): ChangeSetView {
  return {
    changeSetId: changeSet.id,
    runId: changeSet.runId,
    applyToken,
    ...(changeSet.reviewNoteId ? { reviewNoteId: changeSet.reviewNoteId } : {}),
    changes: changeSet.changes.map(toChangeView),
  };
}

function toChangeView(
  change: ProposedChange,
): ChangeSetView["changes"][number] {
  const base = {
    id: change.id,
    kind: change.kind,
    targetId: changeTargetId(change),
    targetLabel: change.targetLabel,
    before: change.before,
    after: change.after,
    diff: change.diff,
    status: change.status,
    undoable: isChangeUndoable(change),
    ...(change.message ? { message: change.message } : {}),
  };
  if (change.kind === "file") {
    return { ...base, operation: "replace" as const };
  }
  return { ...base, operation: change.operation };
}

function isChangeUndoable(change: ProposedChange): boolean {
  if (change.status !== "applied") return false;
  if (change.kind === "file") return true;
  return change.operation === "update";
}

function changeTargetId(change: ProposedChange): string {
  if (change.kind === "file") return change.relativePath;
  if (change.kind === "note") {
    return change.operation === "create" ? change.parentId : change.noteId;
  }
  if (change.operation === "create") return change.parentId || change.id;
  return change.notebookId;
}
