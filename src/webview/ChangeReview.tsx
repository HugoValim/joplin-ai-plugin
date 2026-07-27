import type { ChangeSetView } from "../shared/protocol";

interface ChangeReviewProps {
  readonly changeSet: ChangeSetView;
  readonly acceptedIds: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly phase: string;
  readonly onToggle: (changeId: string) => void;
  readonly onSelectAll: () => void;
  readonly onSelectNone: () => void;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
}

/**
 * Renders one bounded approval workspace with fixed batch actions.
 *
 * @example <ChangeReview changeSet={pending} acceptedIds={ids} {...actions} />
 */
export function ChangeReview(props: ChangeReviewProps): JSX.Element {
  return (
    <section className="change-review" aria-labelledby="change-review-title">
      <ReviewHeader {...props} />
      <div className="review-list" aria-label="Proposed changes">
        {props.changeSet.changes.map((change) => (
          <ChangeDiff
            key={change.id}
            change={change}
            accepted={props.acceptedIds.has(change.id)}
            disabled={props.disabled}
            onToggle={props.onToggle}
          />
        ))}
      </div>
      <ReviewFooter {...props} />
    </section>
  );
}

function ReviewHeader(props: ChangeReviewProps): JSX.Element {
  return (
    <header className="review-header">
      <div>
        <p className="eyebrow">Approval required</p>
        <h2 id="change-review-title">
          Review {props.changeSet.changes.length} changes
        </h2>
        <p>{props.phase}</p>
      </div>
      <div className="selection-controls" aria-label="Batch selection">
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onSelectAll}
        >
          Select all
        </button>
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onSelectNone}
        >
          Select none
        </button>
      </div>
    </header>
  );
}

function ChangeDiff({
  change,
  accepted,
  disabled,
  onToggle,
}: {
  readonly change: ChangeSetView["changes"][number];
  readonly accepted: boolean;
  readonly disabled: boolean;
  readonly onToggle: (changeId: string) => void;
}): JSX.Element {
  return (
    <details className={`change change-${change.status}`} open>
      <summary>
        <input
          type="checkbox"
          checked={accepted}
          disabled={disabled || change.status !== "proposed"}
          onChange={() => onToggle(change.id)}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Accept ${change.targetLabel}`}
        />
        <span title={change.targetLabel}>{change.targetLabel}</span>
        <small>{change.kind}</small>
        <StatusBadge status={change.status} />
      </summary>
      {change.message ? (
        <p className="change-message">{change.message}</p>
      ) : null}
      <pre
        className="diff"
        tabIndex={0}
        aria-label={`Diff for ${change.targetLabel}`}
      >
        {change.diff}
      </pre>
    </details>
  );
}

function StatusBadge({
  status,
}: {
  readonly status: ChangeSetView["changes"][number]["status"];
}): JSX.Element {
  return <span className={`change-status status-${status}`}>{status}</span>;
}

function ReviewFooter(props: ChangeReviewProps): JSX.Element {
  return (
    <footer className="review-footer">
      <span>{props.acceptedIds.size} accepted</span>
      <div>
        <button
          type="button"
          className="primary"
          onClick={props.onApply}
          disabled={props.disabled || props.acceptedIds.size === 0}
        >
          Apply
        </button>
        <button
          type="button"
          onClick={props.onDiscard}
          disabled={props.disabled}
        >
          Discard
        </button>
      </div>
    </footer>
  );
}
