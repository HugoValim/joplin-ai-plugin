import { useEffect, useRef } from "react";
import { formatUsageSummary } from "./usageFormat";
import type { UsageSnapshot } from "./sidebarState";

interface ComposerProps {
  readonly draft: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly phase: string;
  readonly focusSequence: number;
  readonly lastRunId: string | null;
  readonly lastUsage: UsageSnapshot | null;
  readonly contextWindowMax: number | null;
  readonly queuedMessage: string | null;
  readonly onQueue: (text: string) => void;
  readonly history: readonly string[];
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly onUndo: () => void;
}

interface HistoryBrowse {
  readonly index: number;
  readonly stashedDraft: string;
}

/**
 * Renders one-to-six-line prompt input with stable Send/Stop placement.
 *
 * @example <Composer draft={draft} history={userTexts} onSubmit={submit} {...runState} />
 */
export function Composer(props: ComposerProps): JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const browse = useRef<HistoryBrowse | null>(null);
  useEffect(() => {
    textarea.current?.focus();
  }, [props.focusSequence]);
  useEffect(() => {
    if (textarea.current) resizeTextarea(textarea.current);
  }, [props.draft]);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        browse.current = null;
        if (props.busy) {
          const text = props.draft.trim();
          if (text) props.onQueue(text);
          return;
        }
        if (!props.disabled) props.onSubmit();
      }}
    >
      <div className="composer-status" id="composer-status">
        <span>{props.phase}</span>
        {!props.busy && formatUsageSummary(props.lastUsage, { contextWindowMax: props.contextWindowMax ?? undefined }) ? (
          <span className="usage-summary" aria-label="Token usage">
            {formatUsageSummary(props.lastUsage, { contextWindowMax: props.contextWindowMax ?? undefined })}
          </span>
        ) : null}
        {props.queuedMessage ? (
          <span className="queued-indicator" aria-label="Queued follow-up">
            Queued: {props.queuedMessage}
          </span>
        ) : null}
        {props.lastRunId && !props.busy ? (
          <button type="button" onClick={props.onUndo}>
            Undo
          </button>
        ) : null}
      </div>
      <div className="composer-input">
        <label className="sr-only" htmlFor="prompt">
          Message
        </label>
        <textarea
          ref={textarea}
          id="prompt"
          rows={1}
          value={props.draft}
          disabled={props.disabled}
          aria-describedby="composer-status"
          placeholder="Ask about enabled context…"
          onChange={(event) => {
            browse.current = null;
            props.onDraftChange(event.target.value);
          }}
          onInput={(event) => resizeTextarea(event.currentTarget)}
          onKeyDown={(event) => handleComposerKey(event, props, browse)}
        />
        {props.busy ? (
          <button
            type="button"
            className="composer-submit"
            onClick={props.onCancel}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="primary composer-submit"
            disabled={props.disabled || !props.draft.trim()}
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}

function handleComposerKey(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  props: ComposerProps,
  browse: React.MutableRefObject<HistoryBrowse | null>,
): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    browse.current = null;
    if (props.busy) {
      const text = props.draft.trim();
      if (text) props.onQueue(text);
      return;
    }
    if (!props.disabled) props.onSubmit();
    return;
  }
  if (event.key === "ArrowUp") {
    recallOlderHistory(event, props, browse);
    return;
  }
  if (event.key === "ArrowDown") {
    recallNewerHistory(event, props, browse);
  }
}

function recallOlderHistory(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  props: ComposerProps,
  browse: React.MutableRefObject<HistoryBrowse | null>,
): void {
  if (!props.history.length) return;
  if (browse.current === null) {
    if (event.currentTarget.selectionStart !== 0) return;
    if (event.currentTarget.selectionEnd !== 0) return;
  }
  event.preventDefault();
  const next = stepOlderBrowse(browse.current, props.draft, props.history.length);
  browse.current = next;
  props.onDraftChange(historyEntry(props.history, next.index));
}

function recallNewerHistory(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  props: ComposerProps,
  browse: React.MutableRefObject<HistoryBrowse | null>,
): void {
  if (browse.current === null) return;
  event.preventDefault();
  if (browse.current.index < props.history.length - 1) {
    const next = {
      index: browse.current.index + 1,
      stashedDraft: browse.current.stashedDraft,
    };
    browse.current = next;
    props.onDraftChange(historyEntry(props.history, next.index));
    return;
  }
  const stashed = browse.current.stashedDraft;
  browse.current = null;
  props.onDraftChange(stashed);
}

function stepOlderBrowse(
  current: HistoryBrowse | null,
  draft: string,
  historyLength: number,
): HistoryBrowse {
  if (current === null) {
    return { index: historyLength - 1, stashedDraft: draft };
  }
  if (current.index === 0) return current;
  return { index: current.index - 1, stashedDraft: current.stashedDraft };
}

function historyEntry(history: readonly string[], index: number): string {
  const entry = history[index];
  if (entry !== undefined) return entry;
  throw new Error(
    `Invalid history index ${index}; expected 0..${history.length - 1}`,
  );
}

function resizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const style = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight) || 20;
  const padding =
    (Number.parseFloat(style.paddingTop) || 0) +
    (Number.parseFloat(style.paddingBottom) || 0);
  const maxHeight = lineHeight * 6 + padding;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}
