export interface MentionHitView {
  readonly kind: "note" | "notebook";
  readonly id: string;
  readonly title: string;
}

interface MentionPickerProps {
  readonly hits: readonly MentionHitView[];
  readonly activeIndex: number;
  readonly onSelect: (hit: MentionHitView) => void;
  readonly onHover: (index: number) => void;
}

/**
 * Lists note/notebook hits for the composer @ picker.
 *
 * @example <MentionPicker hits={hits} activeIndex={0} onSelect={select} onHover={set} />
 */
export function MentionPicker(props: MentionPickerProps): JSX.Element {
  return (
    <ul className="mention-picker" role="listbox" aria-label="Mention results">
      {props.hits.length === 0 ? (
        <li className="mention-empty" role="option" aria-disabled="true">
          No matching notes or notebooks
        </li>
      ) : (
        props.hits.map((hit, index) => (
          <li key={`${hit.kind}:${hit.id}`} role="option">
            <button
              type="button"
              className={
                index === props.activeIndex ? "mention-active" : undefined
              }
              aria-selected={index === props.activeIndex}
              onMouseEnter={() => props.onHover(index)}
              onClick={() => props.onSelect(hit)}
            >
              <span className="mention-kind">{hit.kind}</span>
              <span>{hit.title}</span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}
