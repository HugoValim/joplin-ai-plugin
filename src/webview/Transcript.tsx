import { useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { safeMarkdownUrlTransform } from "./markdownSecurity";
import { markdownLinkComponents } from "./markdownLinkComponents";
import type { ActiveChatView, PanelRequest } from "../shared/protocol";
import { MessageCard } from "./MessageCard";
import { runSummaryForMessage } from "./runSummaryMatch";
import {
  createPagedTranscriptState,
  decideTranscriptScroll,
  loadEarlierMessages,
  preservePrependOffset,
  TRANSCRIPT_PAGE_SIZE,
  visibleMessageStart,
  type PagedTranscriptState,
  type ScrollMetrics,
  type ScrollTrigger,
} from "./transcriptState";

type ChatMessage = ActiveChatView["messages"][number];
type AssistantAction = Extract<
  PanelRequest,
  { type: "assistant.action" }
>["payload"]["action"];

interface TranscriptProps {
  readonly chatId: string;
  readonly messages: readonly ChatMessage[];
  readonly runSummaries: ActiveChatView["runSummaries"];
  readonly streamingText: string;
  readonly busy: boolean;
  readonly submissionSequence: number;
  readonly onOpenNote: (noteId: string) => void;
  readonly onOpenLink: (url: string) => void;
  readonly onAssistantAction: (
    messageId: string,
    action: AssistantAction,
  ) => void;
  readonly onRegenerate: (messageId: string) => void;
  readonly onSuggestion: (suggestion: string) => void;
  readonly suggestions?: readonly string[];
  readonly noteActionsDisabled: boolean;
  readonly activity?: JSX.Element | null;
}

/**
 * Renders one independently scrollable, paged transcript feed.
 *
 * @example <Transcript chatId={chat.id} messages={chat.messages} {...actions} />
 */
export function Transcript({
  chatId,
  messages,
  runSummaries,
  streamingText,
  busy,
  submissionSequence,
  onOpenNote,
  onOpenLink,
  onAssistantAction,
  onRegenerate,
  onSuggestion,
  suggestions = DEFAULT_SUGGESTIONS,
  noteActionsDisabled,
  activity = null,
}: TranscriptProps): JSX.Element {
  const viewport = useRef<HTMLElement>(null);
  const previous = useRef({
    chatId,
    submissionSequence,
    messageCount: messages.length,
    streamingText,
  });
  const nearBottom = useRef(true);
  const prependMetrics = useRef<ScrollMetrics | null>(null);
  const prependFocusMessageId = useRef<string | null>(null);
  const streamingUnread = useRef(false);
  const [page, setPage] = useState<PagedTranscriptState>(() =>
    createPagedTranscriptState(messages.length),
  );
  const start = visibleMessageStart(messages.length, page);
  const visibleMessages = useMemo(
    () => messages.slice(start),
    [messages, start],
  );
  const latestAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") return message.id;
    }
    return null;
  }, [messages]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const transcriptReset =
      previous.current.chatId !== chatId ||
      messages.length < previous.current.messageCount;
    if (transcriptReset) {
      setPage(createPagedTranscriptState(messages.length));
    } else if (
      page.loadedCount < Math.min(messages.length, TRANSCRIPT_PAGE_SIZE)
    ) {
      setPage((current) => ({
        ...current,
        loadedCount: Math.min(messages.length, TRANSCRIPT_PAGE_SIZE),
      }));
    }
    if (prependMetrics.current) {
      element.scrollTop = preservePrependOffset(
        prependMetrics.current,
        element.scrollHeight,
      );
      prependMetrics.current = null;
      focusAfterFinalPrepend(element, prependFocusMessageId);
      return;
    }
    applyContentScroll(
      element,
      previous.current,
      {
        chatId,
        submissionSequence,
        messageCount: messages.length,
        streamingText,
      },
      nearBottom,
      streamingUnread,
      setPage,
    );
    previous.current = {
      chatId,
      submissionSequence,
      messageCount: messages.length,
      streamingText,
    };
  }, [
    chatId,
    messages.length,
    page.loadedCount,
    streamingText,
    submissionSequence,
  ]);

  function loadEarlier(): void {
    const element = viewport.current;
    if (element) prependMetrics.current = readMetrics(element);
    if (start <= TRANSCRIPT_PAGE_SIZE) {
      prependFocusMessageId.current = visibleMessages[0]?.id ?? null;
    }
    setPage((current) => loadEarlierMessages(current, messages.length));
  }

  function jumpToLatest(): void {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    nearBottom.current = true;
    streamingUnread.current = false;
    setPage((current) => ({ ...current, unreadCount: 0 }));
  }

  return (
    <section className="transcript-pane" aria-label="Chat transcript">
      <section
        ref={viewport}
        className="transcript"
        role="feed"
        aria-label="Messages"
        aria-busy={busy}
        onScroll={(event) => {
          const decision = decideTranscriptScroll(
            readMetrics(event.currentTarget),
            "content-update",
          );
          nearBottom.current = decision === "scroll-to-latest";
          if (nearBottom.current && page.unreadCount > 0) {
            setPage((current) => ({ ...current, unreadCount: 0 }));
          }
        }}
      >
        {start > 0 ? (
          <article className="load-earlier" aria-label="Earlier messages">
            <button type="button" onClick={loadEarlier}>
              Load {Math.min(TRANSCRIPT_PAGE_SIZE, start)} earlier
            </button>
          </article>
        ) : null}
        {!messages.length && !streamingText ? (
          <EmptyTranscript
            suggestions={suggestions}
            onSuggestion={onSuggestion}
          />
        ) : null}
        {visibleMessages.map((message, index) => (
          <MessageCard
            key={message.id}
            message={message}
            position={start + index + 1}
            total={messages.length}
            runSummary={runSummaryForMessage(message, messages, runSummaries)}
            canRegenerate={
              !busy &&
              message.id === latestAssistantId &&
              message.role === "assistant"
            }
            onOpenNote={onOpenNote}
            onOpenLink={onOpenLink}
            onAssistantAction={onAssistantAction}
            onRegenerate={onRegenerate}
            noteActionsDisabled={noteActionsDisabled}
          />
        ))}
        {streamingText ? (
          <StreamingMessage
            content={streamingText}
            position={messages.length + 1}
            onOpenLink={onOpenLink}
          />
        ) : null}
        {activity ? (
          <article
            className="activity-feed-item"
            aria-label="Current run activity"
            tabIndex={0}
          >
            {activity}
          </article>
        ) : null}
      </section>
      {page.unreadCount > 0 ? (
        <button
          type="button"
          className="jump-latest"
          aria-label={`Jump to latest (${page.unreadCount} unread)`}
          onClick={jumpToLatest}
        >
          Jump to latest · {page.unreadCount}
        </button>
      ) : null}
    </section>
  );
}

interface TranscriptSnapshot {
  readonly chatId: string;
  readonly submissionSequence: number;
  readonly messageCount: number;
  readonly streamingText: string;
}

function applyContentScroll(
  element: HTMLElement,
  before: TranscriptSnapshot,
  after: TranscriptSnapshot,
  nearBottom: React.MutableRefObject<boolean>,
  streamingUnread: React.MutableRefObject<boolean>,
  setPage: React.Dispatch<React.SetStateAction<PagedTranscriptState>>,
): void {
  const trigger = scrollTrigger(before, after);
  if (trigger !== "content-update" || nearBottom.current) {
    element.scrollTop = element.scrollHeight;
    nearBottom.current = true;
    streamingUnread.current = false;
    setPage((current) => ({ ...current, unreadCount: 0 }));
    return;
  }
  const unread = unreadIncrement(before, after, streamingUnread);
  if (unread > 0) {
    setPage((current) => ({
      ...current,
      unreadCount: current.unreadCount + unread,
    }));
  }
}

function scrollTrigger(
  before: TranscriptSnapshot,
  after: TranscriptSnapshot,
): ScrollTrigger {
  if (before.chatId !== after.chatId) return "chat-switch";
  if (before.submissionSequence !== after.submissionSequence)
    return "local-submit";
  return "content-update";
}

function unreadIncrement(
  before: TranscriptSnapshot,
  after: TranscriptSnapshot,
  streamingUnread: React.MutableRefObject<boolean>,
): number {
  const addedMessages = Math.max(0, after.messageCount - before.messageCount);
  if (!before.streamingText && after.streamingText) {
    streamingUnread.current = true;
    return addedMessages + 1;
  }
  if (addedMessages && streamingUnread.current) {
    streamingUnread.current = false;
    return Math.max(0, addedMessages - 1);
  }
  return addedMessages;
}

function readMetrics(element: HTMLElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

function focusAfterFinalPrepend(
  element: HTMLElement,
  messageId: React.MutableRefObject<string | null>,
): void {
  if (!messageId.current) return;
  const candidates = element.querySelectorAll<HTMLElement>("[data-message-id]");
  const target = [...candidates].find(
    (candidate) => candidate.dataset.messageId === messageId.current,
  );
  target?.focus({ preventScroll: true });
  messageId.current = null;
}

function StreamingMessage({
  content,
  position,
  onOpenLink,
}: {
  readonly content: string;
  readonly position: number;
  readonly onOpenLink: (url: string) => void;
}): JSX.Element {
  return (
    <article
      className="message message-assistant streaming"
      aria-label={`Assistant response streaming, message ${position}`}
      aria-posinset={position}
      tabIndex={0}
    >
      <header>
        <strong>Assistant</strong>
        <span>Writing…</span>
      </header>
      <div className="message-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize]}
          urlTransform={safeMarkdownUrlTransform}
          components={markdownLinkComponents(onOpenLink)}
        >
          {content}
        </ReactMarkdown>
      </div>
    </article>
  );
}

function EmptyTranscript({
  suggestions,
  onSuggestion,
}: {
  readonly suggestions: readonly string[];
  readonly onSuggestion: (suggestion: string) => void;
}): JSX.Element {
  return (
    <article
      className="empty-transcript"
      aria-label="Empty chat suggestions"
      tabIndex={0}
    >
      <p>Start with enabled context, or ask a general question.</p>
      <div aria-label="Prompt suggestions">
        {suggestions.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            onClick={() => onSuggestion(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </article>
  );
}

const DEFAULT_SUGGESTIONS = [
  "Summarise my active note",
  "Find related ideas",
  "Draft next steps",
] as const;
