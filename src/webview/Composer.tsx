import { useEffect, useRef, useState } from "react";
import { formatUsageSummary } from "./usageFormat";
import type { UsageSnapshot } from "./sidebarState";
import { MentionPicker, type MentionHitView } from "./MentionPicker";
import {
  activeMentionQuery,
  applyMentionLabel,
  type MentionQueryRange,
} from "./mentionQuery";

export {
  canAcceptNoteDrop,
  dropKindFromDataTransfer,
  mentionHitFromDataTransfer,
  parseNoteDropPayload,
} from "./noteDrop";

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
  readonly mentionHits: readonly MentionHitView[];
  readonly dropActive?: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly onUndo: () => void;
  readonly onMentionQueryChange: (query: string | null) => void;
  readonly onMentionSelect: (hit: MentionHitView) => void;
}

interface HistoryBrowse {
  readonly index: number;
  readonly stashedDraft: string;
}

/**
 * Renders prompt input with queueing, @ mentions, and drop highlight.
 *
 * @example <Composer draft={draft} history={userTexts} onSubmit={submit} {...runState} />
 */
export function Composer(props: ComposerProps): JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const browse = useRef<HistoryBrowse | null>(null);
  const [mentionRange, setMentionRange] = useState<MentionQueryRange | null>(
    null,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const pickerOpen = mentionRange !== null;
  const dropActive = Boolean(props.dropActive);

  useEffect(() => {
    textarea.current?.focus();
  }, [props.focusSequence]);
  useEffect(() => {
    if (textarea.current) resizeTextarea(textarea.current);
  }, [props.draft]);
  useEffect(() => {
    setActiveIndex(0);
  }, [props.mentionHits]);

  function syncMention(value: string, caret: number): void {
    const range = activeMentionQuery(value, caret);
    setMentionRange(range);
    props.onMentionQueryChange(range ? range.query : null);
  }

  return (
    <form
      className={`composer${dropActive ? " composer-drop-active" : ""}`}
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
        {!props.busy &&
        formatUsageSummary(props.lastUsage, {
          contextWindowMax: props.contextWindowMax ?? undefined,
        }) ? (
          <span className="usage-summary" aria-label="Token usage">
            {formatUsageSummary(props.lastUsage, {
              contextWindowMax: props.contextWindowMax ?? undefined,
            })}
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
        {pickerOpen ? (
          <MentionPicker
            hits={props.mentionHits}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onSelect={(hit) =>
              selectMention(props, mentionRange, setMentionRange, hit)
            }
          />
        ) : null}
        <label className="sr-only" htmlFor="prompt">
          Message
        </label>
        <textarea
          ref={textarea}
          id="prompt"
          aria-label="Message"
          rows={1}
          value={props.draft}
          disabled={props.disabled}
          aria-describedby="composer-status"
          aria-expanded={pickerOpen || undefined}
          placeholder="Ask about enabled context… Use @ to mention notes"
          onChange={(event) => {
            browse.current = null;
            const value = event.target.value;
            const caret = event.target.selectionStart ?? value.length;
            props.onDraftChange(value);
            syncMention(value, caret);
          }}
          onSelect={(event) => {
            const value = event.currentTarget.value;
            const caret = event.currentTarget.selectionStart ?? value.length;
            syncMention(value, caret);
          }}
          onInput={(event) => resizeTextarea(event.currentTarget)}
          onKeyDown={(event) =>
            handleComposerKey(
              event,
              props,
              browse,
              mentionRange,
              setMentionRange,
              activeIndex,
              setActiveIndex,
            )
          }
          onBlur={() => {
            window.setTimeout(() => {
              setMentionRange(null);
              props.onMentionQueryChange(null);
            }, 150);
          }}
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

function selectMention(
  props: ComposerProps,
  mentionRange: MentionQueryRange | null,
  setMentionRange: (range: MentionQueryRange | null) => void,
  hit: MentionHitView,
): void {
  if (mentionRange) {
    props.onDraftChange(
      applyMentionLabel(props.draft, mentionRange, hit.title),
    );
  }
  setMentionRange(null);
  props.onMentionQueryChange(null);
  props.onMentionSelect(hit);
}

function handleComposerKey(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  props: ComposerProps,
  browse: React.MutableRefObject<HistoryBrowse | null>,
  mentionRange: MentionQueryRange | null,
  setMentionRange: (range: MentionQueryRange | null) => void,
  activeIndex: number,
  setActiveIndex: (index: number) => void,
): void {
  if (mentionRange) {
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionRange(null);
      props.onMentionQueryChange(null);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!props.mentionHits.length) return;
      setActiveIndex((activeIndex + 1) % props.mentionHits.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!props.mentionHits.length) return;
      setActiveIndex(
        (activeIndex - 1 + props.mentionHits.length) % props.mentionHits.length,
      );
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const hit = props.mentionHits[activeIndex];
      if (hit) {
        event.preventDefault();
        selectMention(props, mentionRange, setMentionRange, hit);
      }
      return;
    }
  }
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
  const next = stepOlderBrowse(
    browse.current,
    props.draft,
    props.history.length,
  );
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

