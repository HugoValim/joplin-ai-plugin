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
  readonly cancel: () => void;
  readonly selectChat: (chatId: string) => void;
  readonly createChat: () => void;
  readonly clearChat: () => void;
  readonly deleteChat: () => void;
  readonly updateContext: (next: Partial<ActiveChat["context"]>) => void;
  readonly toggleAttachedNote: () => void;
  readonly selectFolder: () => void;
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
  readonly undo: () => void;
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
  usePanelEvents(dispatch, submissionLock);
  const actions = useSidebarActions(
    state,
    draft,
    setDraft,
    dispatch,
    submissionLock,
    acceptedIds,
    setAcceptedIds,
  );
  return { state, draft, acceptedIds, setDraft, ...actions };
}

function usePanelEvents(
  dispatch: StateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
): void {
  useEffect(() => {
    webviewApi.onMessage((input) => {
      try {
        const event = parseWebviewPluginEvent(input);
        if (isTerminalEvent(event)) submissionLock.current = false;
        dispatch({ type: "plugin", event });
      } catch (error: unknown) {
        submissionLock.current = false;
        dispatch({ type: "post-failed", message: errorMessage(error) });
      }
    });
    postRequest(readyRequest(), dispatch, submissionLock);
  }, [dispatch, submissionLock]);
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
    undo: () => undoRun(input),
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
