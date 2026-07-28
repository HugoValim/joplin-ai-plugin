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
  readonly onDeny: () => void;
  readonly onOpenReview: () => void;
}

/**
 * Renders a slim approval strip; diffs live in the Review Note.
 *
 * @example <ChangeReview changeSet={pending} acceptedIds={ids} {...actions} />
 */
export function ChangeReview(props: ChangeReviewProps): JSX.Element {
  return (
    <section className="change-review" aria-labelledby="change-review-title">
      <ReviewHeader {...props} />
      <div className="review-list" aria-label="Proposed changes">
        {props.changeSet.changes.map((change) => (
          <ChangeRow
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
      <div className="selection-controls" aria-label="Review controls">
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onOpenReview}
        >
          Open review
        </button>
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

function ChangeRow({
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
    <label className={`change-row change-${change.status}`}>
      <input
        type="checkbox"
        checked={accepted}
        disabled={disabled || change.status !== "proposed"}
        onChange={() => onToggle(change.id)}
        aria-label={`Accept ${change.targetLabel}`}
      />
      <span className="change-label" title={change.targetLabel}>
        {change.targetLabel}
      </span>
      <small className="change-meta">
        {change.operation ?? "change"} · {change.kind}
      </small>
      <StatusBadge status={change.status} />
      {change.message ? (
        <span className="change-message" title={change.message}>
          {change.message}
        </span>
      ) : null}
    </label>
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
        <button
          type="button"
          className="danger-action"
          onClick={props.onDeny}
          disabled={props.disabled}
        >
          Deny &amp; Restore
        </button>
      </div>
    </footer>
  );
}
