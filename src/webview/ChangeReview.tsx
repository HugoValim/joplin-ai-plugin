import type { ChangeSetView } from "../shared/protocol";

interface ChangeReviewProps {
  readonly changeSet: ChangeSetView;
  readonly acceptedIds: ReadonlySet<string>;
  readonly onToggle: (changeId: string) => void;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly disabled: boolean;
}

export function ChangeReview({
  changeSet,
  acceptedIds,
  onToggle,
  onApply,
  onDiscard,
  disabled,
}: ChangeReviewProps): JSX.Element {
  return (
    <section className="change-review" aria-labelledby="change-review-title">
      <header>
        <div>
          <p className="eyebrow">Approval required</p>
          <h2 id="change-review-title">
            Review {changeSet.changes.length} changes
          </h2>
        </div>
        <span className="batch-badge">No files written yet</span>
      </header>
      {changeSet.changes.map((change) => (
        <details
          className={`change change-${change.status}`}
          key={change.id}
          open
        >
          <summary>
            <input
              type="checkbox"
              checked={acceptedIds.has(change.id)}
              disabled={disabled || change.status !== "proposed"}
              onChange={() => onToggle(change.id)}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Accept ${change.targetLabel}`}
            />
            <span>{change.targetLabel}</span>
            <small>{change.kind}</small>
          </summary>
          {change.message ? (
            <p className="error-text">{change.message}</p>
          ) : null}
          <pre className="diff" tabIndex={0}>
            {change.diff}
          </pre>
        </details>
      ))}
      <div className="review-actions">
        <button
          type="button"
          className="primary"
          onClick={onApply}
          disabled={disabled || acceptedIds.size === 0}
        >
          Apply accepted ({acceptedIds.size})
        </button>
        <button type="button" onClick={onDiscard} disabled={disabled}>
          Discard
        </button>
      </div>
    </section>
  );
}
