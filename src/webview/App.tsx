import { useEffect, useMemo, useState } from "react";
import {
  PROTOCOL_VERSION,
  parsePluginEvent,
  type PanelRequest,
  type PluginEvent,
} from "../shared/protocol";
import { ChangeReview } from "./ChangeReview";
import { MessageList } from "./MessageList";

type Snapshot = Extract<PluginEvent, { type: "state.snapshot" }>["payload"];
type ToolActivity = {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "completed";
  readonly summary?: string;
};
type AssistantAction = Extract<
  PanelRequest,
  { type: "assistant.action" }
>["payload"]["action"];

const EMPTY_SNAPSHOT: Snapshot = {
  chats: [],
  activeChat: null,
  endpointStatus: "unconfigured",
  modelName: "",
  privacyNotice: "Loading privacy information…",
};

function identifier(): string {
  return crypto.randomUUID();
}

function post(request: PanelRequest): void {
  void webviewApi.postMessage(request);
}

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [draft, setDraft] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [tools, setTools] = useState<readonly ToolActivity[]>([]);
  const [acceptedIds, setAcceptedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const activeChat = snapshot.activeChat;
  const pendingChanges = activeChat?.pendingChangeSet ?? null;

  useEffect(() => {
    webviewApi.onMessage((input) => {
      try {
        handleEvent(parsePluginEvent(input));
      } catch (eventError: unknown) {
        setError(
          eventError instanceof Error ? eventError.message : String(eventError),
        );
      }
    });
    post({
      version: PROTOCOL_VERSION,
      messageId: identifier(),
      chatId: "bootstrap",
      type: "panel.ready",
      payload: {},
    });
  }, []);

  useEffect(() => {
    if (!pendingChanges) {
      setAcceptedIds(new Set());
      return;
    }
    setAcceptedIds(
      new Set(
        pendingChanges.changes
          .filter((change) => change.status === "proposed")
          .map((change) => change.id),
      ),
    );
  }, [pendingChanges?.changeSetId]);

  function handleEvent(event: PluginEvent): void {
    switch (event.type) {
      case "state.snapshot":
        setSnapshot(event.payload);
        return;
      case "workspace.changed":
        setActiveNoteId(event.payload.activeNoteId);
        return;
      case "run.started":
        setBusy(true);
        setError("");
        setProgress("");
        setTools([]);
        setStreamingText("");
        setActiveRunId(event.runId);
        return;
      case "assistant.delta":
        setStreamingText((current) => current + event.payload.delta);
        return;
      case "tool.started":
        setTools((current) => [
          ...current,
          {
            id: event.payload.toolCallId,
            name: event.payload.name,
            status: "running",
          },
        ]);
        return;
      case "tool.completed":
        setTools((current) =>
          current.map((tool) =>
            tool.id === event.payload.toolCallId
              ? {
                  ...tool,
                  status: "completed",
                  summary: event.payload.summary,
                }
              : tool,
          ),
        );
        return;
      case "changes.proposed":
        setBusy(false);
        setStreamingText("");
        setLastRunId(null);
        setActiveRunId(null);
        setProgress("Waiting for approval");
        return;
      case "run.progress":
        setProgress(event.payload.label);
        return;
      case "run.failed":
        setBusy(false);
        setStreamingText("");
        setActiveRunId(null);
        setError(event.payload.message);
        return;
      case "run.completed":
        setBusy(false);
        setStreamingText("");
        setActiveRunId(null);
        setLastRunId(event.payload.undoRunId ?? null);
        setProgress(event.payload.summary);
        return;
    }
  }

  function envelope(): Pick<PanelRequest, "version" | "messageId" | "chatId"> {
    return {
      version: PROTOCOL_VERSION,
      messageId: identifier(),
      chatId: activeChat?.id ?? "bootstrap",
    };
  }

  function submit(): void {
    const text = draft.trim();
    if (!text || !activeChat || busy || pendingChanges) return;
    const runId = identifier();
    post({
      ...envelope(),
      runId,
      type: "chat.submit",
      payload: { text },
    });
    setDraft("");
  }

  function updateContext(
    next: Partial<NonNullable<typeof activeChat>["context"]>,
  ): void {
    if (!activeChat) return;
    post({
      ...envelope(),
      type: "context.update",
      payload: { ...activeChat.context, ...next },
    });
  }

  function toggleAttached(noteId: string): void {
    if (!activeChat) return;
    const current = activeChat.context.attachedNoteIds;
    const attachedNoteIds = current.includes(noteId)
      ? current.filter((id) => id !== noteId)
      : [...current, noteId];
    updateContext({ attachedNoteIds });
  }

  function toggleChange(changeId: string): void {
    setAcceptedIds((current) => {
      const next = new Set(current);
      if (next.has(changeId)) next.delete(changeId);
      else next.add(changeId);
      return next;
    });
  }

  function runAssistantAction(
    messageId: string,
    action: AssistantAction,
  ): void {
    if (!activeChat || busy || pendingChanges) return;
    const title =
      action === "create-note"
        ? prompt("Title for the new note:", "AI response")?.trim()
        : undefined;
    if (action === "create-note" && !title) return;
    setBusy(true);
    post({
      ...envelope(),
      runId: identifier(),
      type: "assistant.action",
      payload: { messageId, action, ...(title ? { title } : {}) },
    });
  }

  const changeRunId = pendingChanges?.runId ?? lastRunId ?? identifier();
  const attachedActive = Boolean(
    activeNoteId && activeChat?.context.attachedNoteIds.includes(activeNoteId),
  );
  const statusLabel = useMemo(
    () =>
      `${snapshot.endpointStatus} · ${snapshot.modelName || "model not set"} · ${
        activeChat ? "chat ready" : "no chat"
      }`,
    [snapshot.endpointStatus, snapshot.modelName, activeChat],
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Joplin AI Agent</p>
          <select
            aria-label="Current chat"
            value={activeChat?.id ?? ""}
            disabled={busy}
            onChange={(event) =>
              post({
                ...envelope(),
                chatId: event.target.value,
                type: "chat.select",
                payload: {},
              })
            }
          >
            {snapshot.chats.map((chat) => (
              <option value={chat.id} key={chat.id}>
                {chat.title}
              </option>
            ))}
          </select>
        </div>
        <div className="chat-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              post({ ...envelope(), type: "chat.create", payload: {} })
            }
          >
            New
          </button>
          <button
            type="button"
            disabled={!activeChat || busy}
            onClick={() => {
              if (confirm("Clear this chat transcript?")) {
                post({ ...envelope(), type: "chat.clear", payload: {} });
              }
            }}
          >
            Clear
          </button>
          <button
            type="button"
            disabled={!activeChat || busy}
            onClick={() => {
              if (confirm("Delete this local chat? This cannot be undone.")) {
                post({ ...envelope(), type: "chat.delete", payload: {} });
              }
            }}
          >
            Delete
          </button>
        </div>
      </header>

      <div className={`status status-${snapshot.endpointStatus}`}>
        <span aria-hidden="true" />
        {statusLabel}
      </div>

      <section className="context-bar" aria-label="Context controls">
        <label>
          <input
            type="checkbox"
            checked={activeChat?.context.activeNote ?? false}
            disabled={busy || Boolean(pendingChanges)}
            onChange={(event) =>
              updateContext({ activeNote: event.target.checked })
            }
          />
          Active note
        </label>
        <label>
          <input
            type="checkbox"
            checked={activeChat?.context.vault ?? false}
            disabled={busy || Boolean(pendingChanges)}
            onChange={(event) => updateContext({ vault: event.target.checked })}
          />
          Vault RAG
        </label>
        <button
          type="button"
          disabled={!activeNoteId || busy || Boolean(pendingChanges)}
          aria-pressed={attachedActive}
          onClick={() => activeNoteId && toggleAttached(activeNoteId)}
        >
          {attachedActive ? "Detach current" : "Attach current"}
        </button>
      </section>

      <section className="folder-card" aria-label="External folder">
        <div>
          <p className="eyebrow">Chat folder</p>
          <strong title={activeChat?.externalRoot ?? undefined}>
            {activeChat?.externalRoot ?? "No folder selected"}
          </strong>
        </div>
        <button
          type="button"
          disabled={busy || Boolean(pendingChanges)}
          onClick={() =>
            post({ ...envelope(), type: "folder.select", payload: {} })
          }
        >
          Add folder
        </button>
      </section>

      {activeChat ? (
        <MessageList
          messages={activeChat.messages}
          streamingText={streamingText}
          onOpenNote={(noteId) =>
            post({
              ...envelope(),
              type: "note.open",
              payload: { noteId },
            })
          }
          onAssistantAction={runAssistantAction}
          actionsDisabled={busy || Boolean(pendingChanges) || !activeNoteId}
        />
      ) : null}

      {tools.length ? (
        <details className="tool-activity">
          <summary>Tool activity · {tools.length}</summary>
          <ul>
            {tools.map((tool) => (
              <li key={tool.id}>
                <strong>{tool.name}</strong> — {tool.summary ?? tool.status}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {progress ? <p className="progress">{progress}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {pendingChanges ? (
        <ChangeReview
          changeSet={pendingChanges}
          acceptedIds={acceptedIds}
          onToggle={toggleChange}
          disabled={busy}
          onApply={() => {
            setBusy(true);
            post({
              ...envelope(),
              runId: changeRunId,
              type: "changes.apply",
              payload: {
                changeSetId: pendingChanges.changeSetId,
                acceptedIds: [...acceptedIds],
              },
            });
          }}
          onDiscard={() => {
            setBusy(true);
            post({
              ...envelope(),
              runId: changeRunId,
              type: "changes.discard",
              payload: { changeSetId: pendingChanges.changeSetId },
            });
          }}
        />
      ) : null}

      {lastRunId && !pendingChanges ? (
        <button
          type="button"
          className="undo-button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            post({
              ...envelope(),
              runId: identifier(),
              type: "run.undo",
              payload: { targetRunId: lastRunId },
            });
          }}
        >
          Undo last applied run
        </button>
      ) : null}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor="prompt">Message</label>
        <textarea
          id="prompt"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about enabled context…"
          disabled={busy || Boolean(pendingChanges)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div>
          {busy && activeRunId ? (
            <button
              type="button"
              onClick={() =>
                post({
                  ...envelope(),
                  runId: activeRunId,
                  type: "run.cancel",
                  payload: {},
                })
              }
            >
              Stop
            </button>
          ) : null}
          <button
            type="submit"
            className="primary"
            disabled={!draft.trim() || busy || Boolean(pendingChanges)}
          >
            Send
          </button>
        </div>
      </form>

      <details className="privacy">
        <summary>Privacy & safety</summary>
        <p>{snapshot.privacyNotice}</p>
      </details>
    </main>
  );
}
