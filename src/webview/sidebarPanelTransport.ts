import { useEffect, useRef } from "react";
import {
  PROTOCOL_VERSION,
  type PanelRequest,
  type PluginEvent,
} from "../shared/protocol";
import { appendMentionLabels, appendSelectionRefLabel } from "./mentionQuery";
import { parseWebviewPluginEvent } from "./pluginEventTransport";
import type { sidebarReducer, SidebarState } from "./sidebarState";

type ActiveChat = NonNullable<SidebarState["snapshot"]["activeChat"]>;
export type SidebarStateDispatch = React.Dispatch<
  Parameters<typeof sidebarReducer>[1]
>;

export function useQueuedFollowUp(
  state: SidebarState,
  dispatch: SidebarStateDispatch,
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
  // proposed changes, load it into the draft and submit.
  useEffect(() => {
    if (state.busy || !state.queuedMessage) return;
    if (hasProposedPending(state.snapshot.activeChat?.pendingChangeSet)) return;
    if (submissionLock.current) return;
    dispatch({ type: "clear-queue" });
    setDraft(state.queuedMessage);
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

export function usePanelEvents(
  dispatch: SidebarStateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
): void {
  useEffect(() => {
    webviewApi.onMessage((input) =>
      receivePanelEvent(input, dispatch, submissionLock, setDraft),
    );
    postPanelRequest(readyRequest(), dispatch, submissionLock);
  }, [dispatch, setDraft, submissionLock]);
}

function receivePanelEvent(
  input: unknown,
  dispatch: SidebarStateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
): void {
  try {
    const event = parseWebviewPluginEvent(input);
    updateDraftFromEvent(event, setDraft);
    if (isTerminalEvent(event)) submissionLock.current = false;
    dispatch({ type: "plugin", event });
  } catch (error: unknown) {
    submissionLock.current = false;
    dispatch({ type: "post-failed", message: errorMessage(error) });
  }
}

function updateDraftFromEvent(
  event: PluginEvent,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
): void {
  if (event.type === "composer.prefill") {
    setDraft((current) => appendComposerSelection(current, event.payload.text));
  }
  if (event.type === "composer.selectionRef") {
    setDraft((current) =>
      appendSelectionRefLabel(
        current,
        event.payload.title,
        event.payload.startLine,
        event.payload.endLine,
      ),
    );
  }
  if (event.type === "context.dropped") {
    setDraft((current) =>
      appendMentionLabels(
        current,
        event.payload.hits.map((hit) => hit.title),
      ),
    );
  }
}

function appendComposerSelection(current: string, selection: string): string {
  return current ? `${current}\n\n${selection}` : selection;
}

export function requestEnvelope(
  chatId: string,
): Pick<PanelRequest, "version" | "messageId" | "chatId"> {
  return { version: PROTOCOL_VERSION, messageId: identifier(), chatId };
}

export function postPanelRequest(
  request: PanelRequest,
  dispatch: SidebarStateDispatch,
  submissionLock: React.MutableRefObject<boolean>,
): void {
  void webviewApi.postMessage(request).catch((error: unknown) => {
    submissionLock.current = false;
    dispatch({ type: "post-failed", message: errorMessage(error) });
  });
}

export function hasProposedPending(
  pending: ActiveChat["pendingChangeSet"] | null | undefined,
): boolean {
  return Boolean(
    pending?.changes.some((change) => change.status === "proposed"),
  );
}

function readyRequest(): Extract<PanelRequest, { type: "panel.ready" }> {
  return {
    ...requestEnvelope("bootstrap"),
    type: "panel.ready",
    payload: {},
  };
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
