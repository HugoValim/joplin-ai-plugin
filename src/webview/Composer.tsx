import { useEffect, useRef } from "react";

interface ComposerProps {
  readonly draft: string;
  readonly busy: boolean;
  readonly phase: string;
  readonly focusSequence: number;
  readonly lastRunId: string | null;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly onUndo: () => void;
}

/**
 * Renders one-to-six-line prompt input with stable Send/Stop placement.
 *
 * @example <Composer draft={draft} onSubmit={submit} {...runState} />
 */
export function Composer(props: ComposerProps): JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);
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
        props.onSubmit();
      }}
    >
      <div className="composer-status" id="composer-status">
        <span>{props.phase}</span>
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
          aria-describedby="composer-status"
          placeholder="Ask about enabled context…"
          onChange={(event) => props.onDraftChange(event.target.value)}
          onInput={(event) => resizeTextarea(event.currentTarget)}
          onKeyDown={(event) => handleComposerKey(event, props)}
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
            disabled={!props.draft.trim()}
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
): void {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  if (!props.busy) props.onSubmit();
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
