import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ActiveChatView } from "../shared/protocol";

type ChatMessage = ActiveChatView["messages"][number];

interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly streamingText: string;
  readonly onOpenNote: (noteId: string) => void;
  readonly onAssistantAction: (
    messageId: string,
    action:
      | "insert-at-cursor"
      | "replace-selection"
      | "append-to-note"
      | "create-note",
  ) => void;
  readonly actionsDisabled: boolean;
}

export function MessageList({
  messages,
  streamingText,
  onOpenNote,
  onAssistantAction,
  actionsDisabled,
}: MessageListProps): JSX.Element {
  return (
    <section
      className="transcript"
      aria-label="Chat transcript"
      aria-live="polite"
    >
      {messages.map((message) => (
        <article className={`message message-${message.role}`} key={message.id}>
          <header>{message.role === "user" ? "You" : "Assistant"}</header>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
          {message.citations?.length ? (
            <footer className="citations" aria-label="Citations">
              {message.citations.map((citation) => (
                <button
                  type="button"
                  key={`${citation.id}:${citation.lineStart ?? 0}`}
                  disabled={citation.kind !== "note"}
                  onClick={() => onOpenNote(citation.id)}
                >
                  {citation.label}
                  {citation.lineStart
                    ? ` · L${citation.lineStart}–${citation.lineEnd ?? citation.lineStart}`
                    : ""}
                </button>
              ))}
            </footer>
          ) : null}
          {message.role === "assistant" ? (
            <footer className="message-actions" aria-label="Output actions">
              {OUTPUT_ACTIONS.map(([action, label]) => (
                <button
                  type="button"
                  key={action}
                  disabled={actionsDisabled}
                  onClick={() => onAssistantAction(message.id, action)}
                >
                  {label}
                </button>
              ))}
            </footer>
          ) : null}
        </article>
      ))}
      {streamingText ? (
        <article className="message message-assistant streaming">
          <header>Assistant</header>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {streamingText}
          </ReactMarkdown>
        </article>
      ) : null}
    </section>
  );
}

const OUTPUT_ACTIONS = [
  ["insert-at-cursor", "Insert"],
  ["replace-selection", "Replace selection"],
  ["append-to-note", "Append"],
  ["create-note", "Create note"],
] as const;
