import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  PROTOCOL_VERSION,
  type PanelRequest,
  type PluginEvent,
} from "../shared/protocol";
import { parseWebviewPluginEvent } from "./pluginEventTransport";
import {
  INITIAL_SIDEBAR_STATE,
  sidebarReducer,
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
  readonly acceptedIds: ReadonlySet<string>;
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
  readonly runAssistantAction: (
    messageId: string,
    action: AssistantAction,
  ) => void;
  readonly toggleChange: (changeId: string) => void;
  readonly selectAllChanges: () => void;
  readonly selectNoChanges: () => void;
  readonly applyChanges: () => void;
  readonly discardChanges: () => void;
  readonly openReview: () => void;
  readonly undo: () => void;
  readonly retry: () => void;
  readonly regenerate: (messageId: string) => void;
  readonly renameChat: (title: string) => void;
  readonly selectModel: (model: string) => void;
  readonly useSuggestion: (suggestion: string) => void;
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
  const [acceptedIds, setAcceptedIds] = useAcceptedChanges(
    state.snapshot.activeChat?.pendingChangeSet ?? null,
  );
  usePanelEvents(dispatch, submissionLock, setDraft);
  const actions = useSidebarActions(
    state,
    draft,
    setDraft,
    dispatch,
    submissionLock,
    acceptedIds,
    setAcceptedIds,
  );
  useQueuedFollowUp(
    state,
    dispatch,
    draft,
    setDraft,
    submissionLock,
    state.snapshot.activeChat?.id ?? null,
    actions.submit,
  );
  return { state, draft, acceptedIds, setDraft, ...actions };
}


function useQueuedFollowUp(
  state: SidebarState,
  dispatch: StateDispatch,
  draft: string,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
  submissionLock: React.MutableRefObject<boolean>,
  activeChatId: string | null,
  submit: () => void,
): void {
  const queuedRef = useRef<string | null>(null);
  queuedRef.current = state.queuedMessage;

  useEffect(() => {
    if (state.busy || state.queuedMessage || !activeChatId) return;
    // Nothing queued — nothing to fire.
    if (!queuedRef.current) return;
  }, [state.busy, state.queuedMessage, activeChatId]);

  // When a run finishes (busy false) and there is a queued message with no
  // pending changes, load it into the draft and submit.
  useEffect(() => {
    if (state.busy || !state.queuedMessage) return;
    if (state.snapshot.activeChat?.pendingChangeSet) return;
    if (submissionLock.current) return;
    const text = state.queuedMessage;
    dispatch({ type: "clear-queue" });
    setDraft(text);
    // Submit on the next tick so the draft is set before submit reads it.
    // useSubmitAction reads draft from its closure, so we use a microtask.
    void Promise.resolve().then(() => submit());
  }, [
    state.busy,
    state.queuedMessage,
    state.snapshot.activeChat?.pendingChangeSet,
    dispatch,
    setDraft,
    submissionLock,
    submit,
  ]);
}

function usePanelEvents(
  dispatch: StateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
): void {
  useEffect(() => {
    webviewApi.onMessage((input) =>
      receivePanelEvent(input, dispatch, submissionLock, setDraft),
    );
    postRequest(readyRequest(), dispatch, submissionLock);
  }, [dispatch, setDraft, submissionLock]);
}

function receivePanelEvent(
  input: unknown,
  dispatch: StateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
): void {
  try {
    const event = parseWebviewPluginEvent(input);
    if (event.type === "composer.prefill") {
      setDraft((current) =>
        appendComposerSelection(current, event.payload.text),
      );
    }
    if (isTerminalEvent(event)) submissionLock.current = false;
    dispatch({ type: "plugin", event });
  } catch (error: unknown) {
    submissionLock.current = false;
    dispatch({ type: "post-failed", message: errorMessage(error) });
  }
}

function appendComposerSelection(current: string, selection: string): string {
  return current ? `${current}\n\n${selection}` : selection;
}

function useAcceptedChanges(
  pending: ActiveChat["pendingChangeSet"] | null,
): [
  ReadonlySet<string>,
  React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
] {
  const [acceptedIds, setAcceptedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  useEffect(() => {
    const proposed =
      pending?.changes
        .filter((change) => change.status === "proposed")
        .map((change) => change.id) ?? [];
    setAcceptedIds(new Set(proposed));
  }, [pending?.changeSetId]);
  return [acceptedIds, setAcceptedIds];
}

type StateDispatch = React.Dispatch<Parameters<typeof sidebarReducer>[1]>;
type AcceptedDispatch = React.Dispatch<
  React.SetStateAction<ReadonlySet<string>>
>;

function useSidebarActions(
  state: SidebarState,
  draft: string,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
  dispatch: StateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
  acceptedIds: ReadonlySet<string>,
  setAcceptedIds: AcceptedDispatch,
): Omit<SidebarController, "state" | "draft" | "acceptedIds" | "setDraft"> {
  const activeChat = state.snapshot.activeChat;
  const pending = activeChat?.pendingChangeSet ?? null;
  const envelope = useCallback(
    (chatId = activeChat?.id ?? "bootstrap") => requestEnvelope(chatId),
    [activeChat?.id],
  );
  const send = useCallback(
    (request: PanelRequest) => postRequest(request, dispatch, submissionLock),
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
        acceptedIds,
        setAcceptedIds,
        setDraft,
        dispatch,
        envelope,
        send,
        submit,
      }),
    [
      acceptedIds,
      activeChat,
      dispatch,
      envelope,
      pending,
      send,
      setAcceptedIds,
      setDraft,
      state,
      submit,
    ],
  );
}

interface ActionInput {
  readonly state: SidebarState;
  readonly activeChat: ActiveChat | null;
  readonly pending: ActiveChat["pendingChangeSet"] | null;
  readonly acceptedIds: ReadonlySet<string>;
  readonly setAcceptedIds: AcceptedDispatch;
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
): Omit<SidebarController, "state" | "draft" | "acceptedIds" | "setDraft"> {
  return {
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
    runAssistantAction: (messageId, action) =>
      runAssistantAction(input, messageId, action),
    toggleChange: (changeId) => toggleChange(input, changeId),
    selectAllChanges: () => selectAllChanges(input),
    selectNoChanges: () => input.setAcceptedIds(new Set()),
    applyChanges: () => applyChanges(input),
    discardChanges: () => discardChanges(input),
    openReview: () => openReview(input),
    undo: () => undoRun(input),
    retry: () => retryRun(input),
    regenerate: (messageId) => regenerateMessage(input, messageId),
    renameChat: (title) => renameChat(input, title),
    selectModel: (model) => selectModel(input, model),
    useSuggestion: (suggestion) => {
      input.setDraft(suggestion);
      input.dispatch({ type: "focus" });
    },
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
      activeChat.pendingChangeSet ||
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
  input.send({
    ...input.envelope(),
    type: "context.update",
    payload: { ...input.activeChat.context, ...next },
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

function toggleChange(input: ActionInput, changeId: string): void {
  input.setAcceptedIds((current) => {
    const next = new Set(current);
    if (next.has(changeId)) next.delete(changeId);
    else next.add(changeId);
    return next;
  });
}

function selectAllChanges(input: ActionInput): void {
  const proposed =
    input.pending?.changes
      .filter((change) => change.status === "proposed")
      .map((change) => change.id) ?? [];
  input.setAcceptedIds(new Set(proposed));
}

function applyChanges(input: ActionInput): void {
  if (!input.pending) return;
  const runId = input.pending.runId ?? input.pending.changeSetId;
  input.dispatch({
    type: "begin",
    runId,
    phase: "Applying changes",
    submission: false,
  });
  input.send({
    ...input.envelope(),
    runId,
    type: "changes.apply",
    payload: {
      changeSetId: input.pending.changeSetId,
      acceptedIds: [...input.acceptedIds],
      applyToken: input.pending.applyToken,
    },
  });
}

function discardChanges(input: ActionInput): void {
  if (!input.pending) return;
  const runId = input.pending.runId ?? input.pending.changeSetId;
  input.dispatch({
    type: "begin",
    runId,
    phase: "Discarding changes",
    submission: false,
  });
  input.send({
    ...input.envelope(),
    runId,
    type: "changes.discard",
    payload: { changeSetId: input.pending.changeSetId },
  });
}

function openReview(input: ActionInput): void {
  if (!input.pending) return;
  const runId = input.pending.runId ?? input.pending.changeSetId;
  input.send({
    ...input.envelope(),
    runId,
    type: "review.open",
    payload: { changeSetId: input.pending.changeSetId },
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
  if (!input.activeChat || input.state.busy || input.pending) return;
  const runId = identifier();
  input.dispatch({ type: "begin", runId, phase: "Retrying", submission: false });
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

function requestEnvelope(
  chatId: string,
): Pick<PanelRequest, "version" | "messageId" | "chatId"> {
  return { version: PROTOCOL_VERSION, messageId: identifier(), chatId };
}

function readyRequest(): Extract<PanelRequest, { type: "panel.ready" }> {
  return {
    ...requestEnvelope("bootstrap"),
    type: "panel.ready",
    payload: {},
  };
}

function postRequest(
  request: PanelRequest,
  dispatch: StateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
): void {
  void webviewApi.postMessage(request).catch((error: unknown) => {
    submissionLock.current = false;
    dispatch({ type: "post-failed", message: errorMessage(error) });
  });
}

function isTerminalEvent(event: PluginEvent): boolean {
  return ["changes.proposed", "run.failed", "run.completed"].includes(
    event.type,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identifier(): string {
  return crypto.randomUUID();
}
