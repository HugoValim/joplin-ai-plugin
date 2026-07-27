import type { PluginEvent } from "../shared/protocol";

export type SidebarSnapshot = Extract<
  PluginEvent,
  { type: "state.snapshot" }
>["payload"];
export type ActiveNoteSummary = Extract<
  PluginEvent,
  { type: "workspace.changed" }
>["payload"]["activeNote"];

export interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "completed" | "failed";
  readonly summary?: string;
}

export interface RunFailure {
  readonly code: string;
  readonly message: string;
}

export interface SidebarState {
  readonly snapshot: SidebarSnapshot;
  readonly activeNote: ActiveNoteSummary;
  readonly activeRunId: string | null;
  readonly lastRunId: string | null;
  readonly streamingText: string;
  readonly busy: boolean;
  readonly failure: RunFailure | null;
  readonly progress: string;
  readonly phase: string;
  readonly tools: readonly ToolActivity[];
  readonly submissionSequence: number;
  readonly focusSequence: number;
}

export type SidebarAction =
  | { readonly type: "plugin"; readonly event: PluginEvent }
  | {
      readonly type: "begin";
      readonly runId: string;
      readonly phase: string;
      readonly submission: boolean;
    }
  | { readonly type: "cancelling" }
  | { readonly type: "focus" }
  | { readonly type: "post-failed"; readonly message: string };

export const EMPTY_SNAPSHOT: SidebarSnapshot = {
  chats: [],
  activeChat: null,
  endpointStatus: "unconfigured",
  modelName: "",
  privacyNotice: "Loading privacy information…",
};

export const INITIAL_SIDEBAR_STATE: SidebarState = {
  snapshot: EMPTY_SNAPSHOT,
  activeNote: null,
  activeRunId: null,
  lastRunId: null,
  streamingText: "",
  busy: false,
  failure: null,
  progress: "",
  phase: "Ready",
  tools: [],
  submissionSequence: 0,
  focusSequence: 0,
};

/**
 * Reduces trusted plugin events and local run transitions into shell state.
 *
 * @example sidebarReducer(state, { type: "plugin", event })
 */
export function sidebarReducer(
  state: SidebarState,
  action: SidebarAction,
): SidebarState {
  if (action.type === "plugin") return reducePluginEvent(state, action.event);
  if (action.type === "begin") return beginRun(state, action);
  if (action.type === "cancelling")
    return { ...state, phase: "Cancellation requested" };
  if (action.type === "focus")
    return { ...state, focusSequence: state.focusSequence + 1 };
  return failPost(state, action.message);
}

function reducePluginEvent(
  state: SidebarState,
  event: PluginEvent,
): SidebarState {
  if (event.type === "state.snapshot") return receiveSnapshot(state, event);
  if (event.type === "workspace.changed")
    return { ...state, activeNote: event.payload.activeNote };
  if (event.type === "composer.prefill")
    return { ...state, focusSequence: state.focusSequence + 1 };
  if (event.type === "run.started") return startRun(state, event.runId);
  if (event.type === "assistant.delta")
    return {
      ...state,
      streamingText: state.streamingText + event.payload.delta,
    };
  if (event.type === "run.progress")
    return {
      ...state,
      progress: event.payload.label,
      phase: event.payload.label,
    };
  return reduceToolOrTerminalEvent(state, event);
}

function reduceToolOrTerminalEvent(
  state: SidebarState,
  event: Exclude<
    PluginEvent,
    {
      type:
        | "state.snapshot"
        | "workspace.changed"
        | "composer.prefill"
        | "run.started"
        | "assistant.delta"
        | "run.progress";
    }
  >,
): SidebarState {
  if (event.type === "tool.started") return startTool(state, event);
  if (event.type === "tool.completed") return completeTool(state, event);
  if (event.type === "changes.proposed")
    return finishRun(state, "Waiting for approval", null);
  if (event.type === "run.failed") return failRun(state, event);
  return finishRun(
    state,
    event.payload.summary,
    event.payload.undoRunId ?? null,
  );
}

function receiveSnapshot(
  state: SidebarState,
  event: Extract<PluginEvent, { type: "state.snapshot" }>,
): SidebarState {
  const previousChatId = state.snapshot.activeChat?.id ?? null;
  const nextChatId = event.payload.activeChat?.id ?? null;
  if (previousChatId !== nextChatId) {
    return {
      ...state,
      snapshot: event.payload,
      activeRunId: null,
      lastRunId: null,
      streamingText: "",
      busy: false,
      failure: null,
      progress: "",
      phase: "Ready",
      tools: [],
      focusSequence: state.focusSequence + 1,
    };
  }
  return {
    ...state,
    snapshot: event.payload,
    focusSequence: state.focusSequence,
  };
}

function beginRun(
  state: SidebarState,
  action: Extract<SidebarAction, { type: "begin" }>,
): SidebarState {
  return {
    ...state,
    activeRunId: action.runId,
    busy: true,
    failure: null,
    progress: "",
    phase: action.phase,
    streamingText: "",
    tools: [],
    submissionSequence: state.submissionSequence + (action.submission ? 1 : 0),
    focusSequence: state.focusSequence + 1,
  };
}

function startRun(state: SidebarState, runId: string): SidebarState {
  return {
    ...state,
    activeRunId: runId,
    busy: true,
    failure: null,
    phase: "Thinking",
    streamingText: "",
    tools: [],
  };
}

function startTool(
  state: SidebarState,
  event: Extract<PluginEvent, { type: "tool.started" }>,
): SidebarState {
  return {
    ...state,
    phase: `Using ${event.payload.name}`,
    tools: [
      ...state.tools,
      {
        id: event.payload.toolCallId,
        name: event.payload.name,
        status: "running",
      },
    ],
  };
}

function completeTool(
  state: SidebarState,
  event: Extract<PluginEvent, { type: "tool.completed" }>,
): SidebarState {
  return {
    ...state,
    tools: state.tools.map((tool) =>
      tool.id === event.payload.toolCallId
        ? {
            ...tool,
            status: event.payload.ok ? "completed" : "failed",
            summary: event.payload.summary,
          }
        : tool,
    ),
  };
}

function failRun(
  state: SidebarState,
  event: Extract<PluginEvent, { type: "run.failed" }>,
): SidebarState {
  const cancelled = event.payload.code === "ABORTED";
  return {
    ...finishRun(state, cancelled ? "Cancelled" : "Run failed", null),
    failure: cancelled ? null : event.payload,
  };
}

function finishRun(
  state: SidebarState,
  summary: string,
  lastRunId: string | null,
): SidebarState {
  return {
    ...state,
    activeRunId: null,
    busy: false,
    lastRunId,
    streamingText: "",
    progress: summary,
    phase: summary,
    focusSequence: state.focusSequence + 1,
  };
}

function failPost(state: SidebarState, message: string): SidebarState {
  return {
    ...finishRun(state, "Request failed", null),
    failure: { code: "WEBVIEW", message },
  };
}
