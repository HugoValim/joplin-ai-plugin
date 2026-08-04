import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { PanelRequest } from "../shared/protocol";
import {
  ChangeReviewTransportAdapter,
  type ChangeReviewTransportPorts,
} from "./changeReviewTransport";
import type { ChangeReviewTransport } from "./ChangeReview";
import {
  hasProposedPending,
  postPanelRequest,
  requestEnvelope,
  type SidebarStateDispatch,
  usePanelEvents,
  useQueuedFollowUp,
} from "./sidebarPanelTransport";
import {
  INITIAL_SIDEBAR_STATE,
  sidebarReducer,
  type MentionHit,
  type SidebarState,
} from "./sidebarState";

type ActiveChat = NonNullable<SidebarState["snapshot"]["activeChat"]>;
type AssistantAction = Extract<
  PanelRequest,
  { type: "assistant.action" }
>["payload"]["action"];

export interface SidebarController {
  readonly state: SidebarState;
  readonly draft: string;
  readonly changeReviewTransport: ChangeReviewTransport;
  readonly setDraft: (value: string) => void;
  readonly submit: () => void;
  readonly queueMessage: (text: string) => void;
  readonly cancel: () => void;
  readonly selectChat: (chatId: string) => void;
  readonly createChat: () => void;
  readonly clearChat: () => void;
  readonly deleteChat: () => void;
  readonly updateContext: (next: Partial<ActiveChat["context"]>) => void;
  readonly toggleAttachedNote: () => void;
  readonly selectFolder: () => void;
  readonly markSecretNotebook: (notebookId: string) => void;
  readonly unmarkSecretNotebook: (notebookId: string) => void;
  readonly openNote: (noteId: string) => void;
  readonly openLink: (url: string) => void;
  readonly runAssistantAction: (
    messageId: string,
    action: AssistantAction,
  ) => void;
  readonly undo: () => void;
  readonly retry: () => void;
  readonly regenerate: (messageId: string) => void;
  readonly renameChat: (title: string) => void;
  readonly selectModel: (model: string) => void;
  readonly useSuggestion: (suggestion: string) => void;
  readonly mentionHits: readonly MentionHit[];
  readonly onMentionQueryChange: (query: string | null) => void;
  readonly attachMention: (hit: MentionHit) => void;
  readonly attachDropped: (
    kind: "note" | "notebook" | "auto",
    ids?: readonly string[],
  ) => void;
}

/**
 * Owns sidebar state and all typed requests crossing the webview boundary.
 *
 * @example const controller = useSidebarController()
 */
export function useSidebarController(): SidebarController {
  const [state, dispatch] = useReducer(sidebarReducer, INITIAL_SIDEBAR_STATE);
  const [draft, setDraft] = useState("");
  const submissionLock = useRef(false);
  usePanelEvents(dispatch, submissionLock, setDraft);
  const actions = useSidebarActions(
    state,
    draft,
    setDraft,
    dispatch,
    submissionLock,
  );
  useQueuedFollowUp(
    state,
    dispatch,
    setDraft,
    submissionLock,
    state.snapshot.activeChat?.id ?? null,
    actions.submit,
  );
  return { state, draft, setDraft, ...actions };
}

type StateDispatch = SidebarStateDispatch;

function useSidebarActions(
  state: SidebarState,
  draft: string,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
  dispatch: StateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
): Omit<SidebarController, "state" | "draft" | "setDraft"> {
  const activeChat = state.snapshot.activeChat;
  const pending = activeChat?.pendingChangeSet ?? null;
  const envelope = useCallback(
    (chatId = activeChat?.id ?? "bootstrap") => requestEnvelope(chatId),
    [activeChat?.id],
  );
  const send = useCallback(
    (request: PanelRequest) =>
      postPanelRequest(request, dispatch, submissionLock),
    [dispatch, submissionLock],
  );
  const submit = useSubmitAction(
    state,
    draft,
    setDraft,
    dispatch,
    submissionLock,
    activeChat,
    envelope,
    send,
  );
  return useMemo(
    () =>
      createActions({
        state,
        activeChat,
        pending,
        setDraft,
        dispatch,
        envelope,
        send,
        submit,
      }),
    [activeChat, dispatch, envelope, pending, send, setDraft, state, submit],
  );
}

interface ActionInput {
  readonly state: SidebarState;
  readonly activeChat: ActiveChat | null;
  readonly pending: ActiveChat["pendingChangeSet"] | null;
  readonly setDraft: React.Dispatch<React.SetStateAction<string>>;
  readonly dispatch: StateDispatch;
  readonly envelope: (
    chatId?: string,
  ) => Pick<PanelRequest, "version" | "messageId" | "chatId">;
  readonly send: (request: PanelRequest) => void;
  readonly submit: () => void;
}

function createActions(
  input: ActionInput,
): Omit<SidebarController, "state" | "draft" | "setDraft"> {
  return {
    changeReviewTransport: new ChangeReviewTransportAdapter(
      reviewTransportPorts(input),
    ),
    submit: input.submit,
    queueMessage: (text) => queueMessage(input, text),
    cancel: () => cancelRun(input),
    selectChat: (chatId) => selectChat(input, chatId),
    createChat: () =>
      input.send({ ...input.envelope(), type: "chat.create", payload: {} }),
    clearChat: () =>
      input.send({ ...input.envelope(), type: "chat.clear", payload: {} }),
    deleteChat: () =>
      input.send({ ...input.envelope(), type: "chat.delete", payload: {} }),
    updateContext: (next) => updateContext(input, next),
    toggleAttachedNote: () => toggleAttachedNote(input),
    selectFolder: () =>
      input.send({ ...input.envelope(), type: "folder.select", payload: {} }),
    markSecretNotebook: (notebookId) =>
      input.send({
        ...input.envelope(),
        type: "secrets.mark",
        payload: { notebookId },
      }),
    unmarkSecretNotebook: (notebookId) =>
      input.send({
        ...input.envelope(),
        type: "secrets.unmark",
        payload: { notebookId },
      }),
    openNote: (noteId) =>
      input.send({
        ...input.envelope(),
        type: "note.open",
        payload: { noteId },
      }),
    openLink: (url) =>
      input.send({
        ...input.envelope(),
        type: "link.open",
        payload: { url },
      }),
    runAssistantAction: (messageId, action) =>
      runAssistantAction(input, messageId, action),
    undo: () => undoRun(input),
    retry: () => retryRun(input),
    regenerate: (messageId) => regenerateMessage(input, messageId),
    renameChat: (title) => renameChat(input, title),
    selectModel: (model) => selectModel(input, model),
    useSuggestion: (suggestion) => {
      input.setDraft(suggestion);
      input.dispatch({ type: "focus" });
    },
    mentionHits: input.state.mentionHits,
    onMentionQueryChange: (query) => requestMentionSearch(input, query),
    attachMention: (hit) => attachMention(input, hit),
    attachDropped: (kind, ids) => attachDropped(input, kind, ids),
  };
}

function reviewTransportPorts(input: ActionInput): ChangeReviewTransportPorts {
  return {
    envelope: () => input.envelope(),
    begin: (runId, phase) =>
      input.dispatch({ type: "begin", runId, phase, submission: false }),
    post: input.send,
  };
}

function useSubmitAction(
  state: SidebarState,
  draft: string,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
  dispatch: StateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
  activeChat: ActiveChat | null,
  envelope: ActionInput["envelope"],
  send: ActionInput["send"],
): () => void {
  return useCallback(() => {
    const text = draft.trim();
    if (
      !text ||
      !activeChat ||
      state.busy ||
      hasProposedPending(activeChat.pendingChangeSet) ||
      submissionLock.current
    )
      return;
    submissionLock.current = true;
    const runId = identifier();
    dispatch({ type: "begin", runId, phase: "Sending", submission: true });
    setDraft("");
    send({
      ...envelope(),
      runId,
      type: "chat.submit",
      payload: { text },
    });
  }, [
    activeChat,
    dispatch,
    draft,
    envelope,
    send,
    setDraft,
    state.busy,
    submissionLock,
  ]);
}

function queueMessage(input: ActionInput, text: string): void {
  const trimmed = text.trim();
  if (!trimmed || !input.activeChat) return;
  input.dispatch({ type: "queue", text: trimmed });
}

function cancelRun(input: ActionInput): void {
  if (!input.state.activeRunId || !input.activeChat) return;
  input.dispatch({ type: "cancelling" });
  input.send({
    ...input.envelope(),
    runId: input.state.activeRunId,
    type: "run.cancel",
    payload: {},
  });
  input.dispatch({ type: "focus" });
}

function selectChat(input: ActionInput, chatId: string): void {
  input.send({
    ...input.envelope(chatId),
    type: "chat.select",
    payload: {},
  });
}

function updateContext(
  input: ActionInput,
  next: Partial<ActiveChat["context"]>,
): void {
  if (!input.activeChat) return;
  const context = input.activeChat.context;
  input.send({
    ...input.envelope(),
    type: "context.update",
    payload: {
      ...context,
      attachedNotebookIds: context.attachedNotebookIds ?? [],
      selectionRefs: context.selectionRefs ?? [],
      ...next,
    },
  });
}

const MAX_ATTACHED_NOTES = 50;
const MAX_ATTACHED_NOTEBOOKS = 20;

function attachMention(input: ActionInput, hit: MentionHit): void {
  if (!input.activeChat) return;
  const context = input.activeChat.context;
  if (hit.kind === "note") {
    updateContext(input, {
      attachedNoteIds: addMentionId(
        context.attachedNoteIds,
        hit.id,
        MAX_ATTACHED_NOTES,
      ),
    });
    return;
  }
  updateContext(input, {
    attachedNotebookIds: addMentionId(
      context.attachedNotebookIds ?? [],
      hit.id,
      MAX_ATTACHED_NOTEBOOKS,
    ),
  });
}

function attachDropped(
  input: ActionInput,
  kind: "note" | "notebook" | "auto",
  ids?: readonly string[],
): void {
  if (!input.activeChat) return;
  input.send({
    ...input.envelope(),
    type: "context.attachDropped",
    payload: ids && ids.length > 0 ? { kind, ids: [...ids] } : { kind },
  });
}

function addMentionId(
  ids: readonly string[],
  id: string,
  max: number,
): string[] {
  if (ids.includes(id) || ids.length >= max) return [...ids];
  return [...ids, id];
}

function requestMentionSearch(input: ActionInput, query: string | null): void {
  if (query === null) {
    input.dispatch({ type: "mention-query", requestId: null });
    return;
  }
  const requestId = identifier();
  input.dispatch({ type: "mention-query", requestId });
  input.send({
    ...input.envelope(),
    type: "context.search",
    payload: { requestId, query },
  });
}

function toggleAttachedNote(input: ActionInput): void {
  if (!input.activeChat || !input.state.activeNote) return;
  const noteId = input.state.activeNote.id;
  const current = input.activeChat.context.attachedNoteIds;
  const attachedNoteIds = current.includes(noteId)
    ? current.filter((id) => id !== noteId)
    : [...current, noteId];
  updateContext(input, { attachedNoteIds });
}

function runAssistantAction(
  input: ActionInput,
  messageId: string,
  action: AssistantAction,
): void {
  if (!input.activeChat || input.state.busy || input.pending) return;
  const title =
    action === "create-note"
      ? prompt("Title for the new note:", "AI response")?.trim()
      : undefined;
  if (action === "create-note" && !title) return;
  const runId = identifier();
  input.dispatch({
    type: "begin",
    runId,
    phase: "Applying action",
    submission: false,
  });
  input.send({
    ...input.envelope(),
    runId,
    type: "assistant.action",
    payload: { messageId, action, ...(title ? { title } : {}) },
  });
}

function undoRun(input: ActionInput): void {
  if (!input.state.lastRunId) return;
  const runId = identifier();
  input.dispatch({
    type: "begin",
    runId,
    phase: "Undoing changes",
    submission: false,
  });
  input.send({
    ...input.envelope(),
    runId,
    type: "run.undo",
    payload: { targetRunId: input.state.lastRunId },
  });
}

function retryRun(input: ActionInput): void {
  if (
    !input.activeChat ||
    input.state.busy ||
    hasProposedPending(input.pending)
  )
    return;
  const runId = identifier();
  input.dispatch({
    type: "begin",
    runId,
    phase: "Retrying",
    submission: false,
  });
  input.send({
    ...input.envelope(),
    runId,
    type: "chat.retry",
    payload: {},
  });
}

function regenerateMessage(input: ActionInput, messageId: string): void {
  if (!input.activeChat || input.state.busy || input.pending) return;
  const runId = identifier();
  input.dispatch({
    type: "begin",
    runId,
    phase: "Regenerating",
    submission: false,
  });
  input.send({
    ...input.envelope(),
    runId,
    type: "chat.regenerate",
    payload: { messageId },
  });
}

function renameChat(input: ActionInput, title: string): void {
  if (!input.activeChat || input.state.busy) return;
  input.send({
    ...input.envelope(),
    type: "chat.rename",
    payload: { title },
  });
}

function selectModel(input: ActionInput, model: string): void {
  if (input.state.busy) return;
  input.send({
    ...input.envelope(),
    type: "model.select",
    payload: { model },
  });
}

function identifier(): string {
  return crypto.randomUUID();
}
