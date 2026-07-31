import { useEffect, useRef } from "react";
import type { MentionCandidate } from "../shared/protocol";

interface MentionPickerProps {
  readonly query: string;
  readonly candidates: readonly MentionCandidate[];
  readonly loading: boolean;
  readonly onSelect: (candidate: MentionCandidate) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onDismiss: () => void;
}

/**
 * Renders a searchable note/notebook list for @-mentions.
 *
 * @example <MentionPicker query="d" candidates={hits} onSelect={attach} onQueryChange={setQuery} onDismiss={close} />
 */
export function MentionPicker(props: MentionPickerProps): JSX.Element | null {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  if (!props.query && props.candidates.length === 0 && !props.loading)
    return null;
  return (
    <div
      className="mention-picker"
      role="dialog"
      aria-label="Mention notes or notebooks"
    >
      <input
        ref={input}
        className="mention-picker-input"
        type="text"
        aria-label="Filter mentions"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => dismissOnEscape(event, props.onDismiss)}
      />
      <ul
        className="mention-picker-list"
        role="listbox"
        aria-label="Mention candidates"
      >
        {props.loading && props.candidates.length === 0 ? (
          <li className="mention-picker-empty">Searching…</li>
        ) : null}
        {props.candidates.map((candidate) => (
          <li
            key={`${candidate.kind}:${candidate.id}`}
            role="option"
            aria-selected={false}
          >
            <button
              type="button"
              className="mention-picker-item"
              onClick={() => props.onSelect(candidate)}
            >
              <span className="mention-picker-kind">{candidate.kind}</span>
              <span className="mention-picker-title">{candidate.title}</span>
            </button>
          </li>
        ))}
        {!props.loading && props.candidates.length === 0 && props.query ? (
          <li className="mention-picker-empty">No matches</li>
        ) : null}
      </ul>
    </div>
  );
}

function dismissOnEscape(
  event: React.KeyboardEvent<HTMLInputElement>,
  onDismiss: () => void,
): void {
  if (event.key === "Escape") onDismiss();
}
