import { useRef } from "react";
import type { SidebarSnapshot } from "./sidebarState";

interface SidebarHeaderProps {
  readonly snapshot: SidebarSnapshot;
  readonly busy: boolean;
  readonly onSelectChat: (chatId: string) => void;
  readonly onCreateChat: () => void;
  readonly onClearChat: () => void;
  readonly onDeleteChat: () => void;
  readonly onRenameChat: (title: string) => void;
  readonly onSelectModel: (model: string) => void;
}

/**
 * Renders compact chat navigation, provider identity, and secondary actions.
 *
 * @example <SidebarHeader snapshot={snapshot} {...actions} />
 */
export function SidebarHeader(props: SidebarHeaderProps): JSX.Element {
  const activeChat = props.snapshot.activeChat;
  return (
    <header className="sidebar-header">
      <div className="topbar">
        <label className="chat-picker">
          <span className="sr-only">Current chat</span>
          <select
            aria-label="Current chat"
            value={activeChat?.id ?? ""}
            disabled={props.busy}
            onChange={(event) => props.onSelectChat(event.target.value)}
          >
            {props.snapshot.chats.map((chat) => (
              <option value={chat.id} key={chat.id}>
                {chat.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onCreateChat}
        >
          New
        </button>
        <HeaderMenu {...props} />
      </div>
      <ModelStatus {...props} />
    </header>
  );
}

function ModelStatus(props: SidebarHeaderProps): JSX.Element {
  const picker = useRef<HTMLDetailsElement>(null);
  const models = props.snapshot.availableModels;
  const current = props.snapshot.modelName || "model not set";
  const close = (): void => {
    if (picker.current) picker.current.open = false;
  };
  return (
    <details
      ref={picker}
      className={`connection-status status-${props.snapshot.endpointStatus} model-picker`}
      onKeyDown={(event) => closeOnEscape(event, picker, close)}
    >
      <summary aria-label={`Connection ${props.snapshot.endpointStatus}, model ${current}`}>
        <span aria-hidden="true">●</span>
        {statusText(props.snapshot)}
      </summary>
      {models.length ? (
        <div className="model-picker-popover" role="listbox" aria-label="Available models">
          {models.map((model) => (
            <button
              type="button"
              key={model}
              role="option"
              aria-selected={model === props.snapshot.modelName}
              disabled={props.busy}
              onClick={() => {
                close();
                props.onSelectModel(model);
              }}
            >
              {model}
            </button>
          ))}
        </div>
      ) : (
        <p className="model-picker-empty">
          Start Ollama (or set a model in plugin settings) to list models here.
        </p>
      )}
    </details>
  );
}

function HeaderMenu(props: SidebarHeaderProps): JSX.Element {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = (): void => {
    if (menu.current) menu.current.open = false;
  };
  return (
    <details
      ref={menu}
      className="header-menu"
      onKeyDown={(event) => closeOnEscape(event, menu, close)}
    >
      <summary aria-label="More options">•••</summary>
      <div className="header-menu-popover">
        <button
          type="button"
          disabled={!props.snapshot.activeChat || props.busy}
          onClick={() => renameChat(close, props.onRenameChat)}
        >
          Rename chat
        </button>
        <button
          type="button"
          disabled={!props.snapshot.activeChat || props.busy}
          onClick={() => confirmClear(close, props.onClearChat)}
        >
          Clear chat
        </button>
        <button
          type="button"
          className="danger-action"
          disabled={!props.snapshot.activeChat || props.busy}
          onClick={() => confirmDelete(close, props.onDeleteChat)}
        >
          Delete chat
        </button>
        <details className="privacy">
          <summary>Privacy &amp; safety</summary>
          <p>{props.snapshot.privacyNotice}</p>
        </details>
      </div>
    </details>
  );
}

function closeOnEscape(
  event: React.KeyboardEvent<HTMLDetailsElement>,
  menu: React.RefObject<HTMLDetailsElement>,
  close: () => void,
): void {
  if (event.key !== "Escape") return;
  close();
  menu.current?.querySelector("summary")?.focus();
}

function renameChat(close: () => void, rename: (title: string) => void): void {
  close();
  const title = prompt("Rename chat:", "")?.trim();
  if (title) rename(title);
}

function confirmClear(close: () => void, clear: () => void): void {
  close();
  if (confirm("Clear this chat transcript?")) clear();
}

function confirmDelete(close: () => void, remove: () => void): void {
  close();
  if (confirm("Delete this local chat? This cannot be undone.")) remove();
}

function statusText(snapshot: SidebarSnapshot): string {
  const status =
    snapshot.endpointStatus[0]?.toUpperCase() +
    snapshot.endpointStatus.slice(1);
  return `${status} · ${snapshot.modelName || "model not set"}`;
}
