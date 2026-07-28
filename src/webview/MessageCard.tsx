import { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { safeMarkdownUrlTransform } from "./markdownSecurity";
import type { ActiveChatView, PanelRequest } from "../shared/protocol";
import { RunTimeline } from "./RunTimeline";

type ChatMessage = ActiveChatView["messages"][number];
type RunSummary = ActiveChatView["runSummaries"][number];
type AssistantAction = Extract<
  PanelRequest,
  { type: "assistant.action" }
>["payload"]["action"];

interface MessageCardProps {
  readonly message: ChatMessage;
  readonly position: number;
  readonly total: number;
  readonly runSummary: RunSummary | null;
  readonly canRegenerate: boolean;
  readonly onOpenNote: (noteId: string) => void;
  readonly onAssistantAction: (
    messageId: string,
    action: AssistantAction,
  ) => void;
  readonly onRegenerate?: (messageId: string) => void;
  readonly noteActionsDisabled: boolean;
}

/**
 * Renders one completed transcript message and its keyboard-safe actions.
 *
 * @example <MessageCard message={message} position={1} total={1} {...actions} />
 */
export const MessageCard = memo(function MessageCard(
  props: MessageCardProps,
): JSX.Element {
  const {
    message,
    position,
    total,
    onOpenNote,
    onAssistantAction,
    noteActionsDisabled,
  } = props;
  const actionMenu = useRef<HTMLDetailsElement>(null);
  const [copyLabel, setCopyLabel] = useState("Copy");
  const author = authorName(message.role);
  const timestamp = formatTimestamp(message.createdAt);
  const headingId = `message-heading-${message.id}`;

  function closeActionMenu(): void {
    if (actionMenu.current) actionMenu.current.open = false;
  }

  function runAction(action: AssistantAction): void {
    closeActionMenu();
    onAssistantAction(message.id, action);
  }

  function copyContent(): void {
    if (!navigator.clipboard) {
      setCopyLabel("Copy unavailable");
      return;
    }
    void navigator.clipboard.writeText(message.content).then(
      () => updateCopyLabel(setCopyLabel, "Copied"),
      () => updateCopyLabel(setCopyLabel, "Copy failed"),
    );
  }

  return (
    <article
      className={`message message-${message.role}`}
      aria-label={`${author} message ${position} of ${total}, sent ${timestamp}`}
      aria-posinset={position}
      aria-setsize={total}
      data-message-id={message.id}
      tabIndex={0}
    >
      <header id={headingId}>
        <strong>{author}</strong>
        <time
          dateTime={new Date(message.createdAt).toISOString()}
          aria-label={`${author} sent at ${timestamp}`}
        >
          {timestamp}
        </time>
      </header>
      <div className="message-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize]}
          urlTransform={safeMarkdownUrlTransform}
        >
          {message.content}
        </ReactMarkdown>
      </div>
      {message.citations?.length ? (
        <SourceList citations={message.citations} onOpenNote={onOpenNote} />
      ) : null}
      {message.role === "assistant" ? (
        <footer className="message-actions" aria-label="Response actions">
          <button type="button" onClick={copyContent}>
            {copyLabel}
          </button>
          {props.canRegenerate && props.onRegenerate ? (
            <button
              type="button"
              disabled={props.noteActionsDisabled}
              onClick={() => props.onRegenerate?.(message.id)}
            >
              Regenerate
            </button>
          ) : null}
          <details
            ref={actionMenu}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              closeActionMenu();
              actionMenu.current?.querySelector("summary")?.focus();
            }}
          >
            <summary>More actions</summary>
            <div className="action-menu">
              {OUTPUT_ACTIONS.map(([action, label]) => (
                <button
                  type="button"
                  key={action}
                  disabled={noteActionsDisabled}
                  onClick={() => runAction(action)}
                >
                  {label}
                </button>
              ))}
            </div>
          </details>
        </footer>
      ) : null}
      {message.role === "assistant" && props.runSummary ? (
        <RunTimeline summary={props.runSummary} />
      ) : null}
    </article>
  );
}, sameMessageCard);

function SourceList({
  citations,
  onOpenNote,
}: {
  readonly citations: NonNullable<ChatMessage["citations"]>;
  readonly onOpenNote: (noteId: string) => void;
}): JSX.Element {
  return (
    <details className="citations">
      <summary>Sources ({citations.length})</summary>
      <div>
        {citations.map((citation) =>
          citation.kind === "note" ? (
            <button
              type="button"
              key={citationKey(citation)}
              onClick={() => onOpenNote(citation.id)}
            >
              {citationLabel(citation)}
            </button>
          ) : (
            <span className="source-label" key={citationKey(citation)}>
              {citationLabel(citation)}
            </span>
          ),
        )}
      </div>
    </details>
  );
}

function updateCopyLabel(
  setCopyLabel: React.Dispatch<React.SetStateAction<string>>,
  label: string,
): void {
  setCopyLabel(label);
  window.setTimeout(() => setCopyLabel("Copy"), 1_500);
}

function authorName(role: ChatMessage["role"]): string {
  if (role === "user") return "You";
  if (role === "tool") return "Tool";
  return "Assistant";
}

function formatTimestamp(createdAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(createdAt);
}

function citationKey(
  citation: NonNullable<ChatMessage["citations"]>[number],
): string {
  return `${citation.kind}:${citation.id}:${citation.lineStart ?? 0}`;
}

function citationLabel(
  citation: NonNullable<ChatMessage["citations"]>[number],
): string {
  if (!citation.lineStart) return citation.label;
  return `${citation.label} · L${citation.lineStart}–${
    citation.lineEnd ?? citation.lineStart
  }`;
}

function sameMessageCard(
  previous: MessageCardProps,
  next: MessageCardProps,
): boolean {
  return (
    previous.message.id === next.message.id &&
    previous.message.content === next.message.content &&
    previous.message.createdAt === next.message.createdAt &&
    previous.message.citations === next.message.citations &&
    previous.position === next.position &&
    previous.total === next.total &&
    previous.runSummary === next.runSummary &&
    previous.canRegenerate === next.canRegenerate &&
    previous.noteActionsDisabled === next.noteActionsDisabled
  );
}

const OUTPUT_ACTIONS = [
  ["insert-at-cursor", "Insert"],
  ["replace-selection", "Replace selection"],
  ["append-to-note", "Append"],
  ["create-note", "Create note"],
] as const;
