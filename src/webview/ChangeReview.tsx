import { useEffect, useRef } from "react";
import type { ChangeSetView } from "../shared/protocol";
import { countDiffStats } from "./diffStats";

type ChangeView = ChangeSetView["changes"][number];

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
  readonly onKeep: (changeId: string) => void;
  readonly onKeepAll: () => void;
  readonly onUndoChange: (changeId: string) => void;
  readonly onUndoAll: () => void;
}

/**
 * Compact sidebar review strip; full diffs live in the Joplin Review Note.
 *
 * @example <ChangeReview changeSet={pending} acceptedIds={ids} {...actions} />
 */
export function ChangeReview(props: ChangeReviewProps): JSX.Element {
  const postApply = isPostApplyReview(props.changeSet);
  useAutoOpenReviewNote(props.changeSet.changeSetId, props.onOpenReview);

  return (
    <section
      className="change-review change-review-compact"
      aria-labelledby="change-review-title"
    >
      <ReviewHeader {...props} postApply={postApply} />
      <div className="review-list" aria-label="Proposed changes" role="list">
        {props.changeSet.changes.map((change) => (
          <ChangeRow
            key={change.id}
            change={change}
            accepted={props.acceptedIds.has(change.id)}
            disabled={props.disabled}
            postApply={postApply}
            onToggle={props.onToggle}
            onKeep={() => props.onKeep(change.id)}
            onUndo={() => props.onUndoChange(change.id)}
          />
        ))}
      </div>
      <ReviewFooter {...props} postApply={postApply} />
    </section>
  );
}

function useAutoOpenReviewNote(
  changeSetId: string,
  onOpenReview: () => void,
): void {
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (openedFor.current === changeSetId) return;
    openedFor.current = changeSetId;
    onOpenReview();
  }, [changeSetId, onOpenReview]);
}

function isPostApplyReview(changeSet: ChangeSetView): boolean {
  return (
    changeSet.changes.length > 0 &&
    changeSet.changes.every((change) => change.status !== "proposed")
  );
}

function ReviewHeader({
  changeSet,
  phase,
  disabled,
  postApply,
  onOpenReview,
  onSelectAll,
  onSelectNone,
}: ChangeReviewProps & { readonly postApply: boolean }): JSX.Element {
  return (
    <header className="review-header">
      <div>
        <p className="eyebrow">
          {postApply ? "Applied changes" : "Approval required"}
        </p>
        <h2 id="change-review-title">
          Review {changeSet.changes.length} changes
        </h2>
        <p>
          {phase}. Diffs open in the note editor — use{" "}
          <strong>Open review</strong> if focus is lost.
        </p>
      </div>
      <div className="selection-controls" aria-label="Review controls">
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={onOpenReview}
        >
          Open review
        </button>
        {postApply ? null : (
          <>
            <button type="button" disabled={disabled} onClick={onSelectAll}>
              Select all
            </button>
            <button type="button" disabled={disabled} onClick={onSelectNone}>
              Select none
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function ChangeRow({
  change,
  accepted,
  disabled,
  postApply,
  onToggle,
  onKeep,
  onUndo,
}: {
  readonly change: ChangeView;
  readonly accepted: boolean;
  readonly disabled: boolean;
  readonly postApply: boolean;
  readonly onToggle: (changeId: string) => void;
  readonly onKeep: () => void;
  readonly onUndo: () => void;
}): JSX.Element {
  const stats = countDiffStats(change.diff);
  return (
    <div className={`change-row change-${change.status}`} role="listitem">
      {postApply ? null : (
        <input
          type="checkbox"
          checked={accepted}
          disabled={disabled || change.status !== "proposed"}
          onChange={() => onToggle(change.id)}
          aria-label={`Accept ${change.targetLabel}`}
        />
      )}
      <div className="change-row-body">
        <span className="change-label" title={change.targetLabel}>
          {change.targetLabel}
        </span>
        <small className="change-meta">
          {change.operation ?? "change"} · {change.kind}
        </small>
        <span className="change-stats">{formatStats(stats)}</span>
        <StatusBadge status={change.status} />
      </div>
      {postApply ? (
        <div className="change-row-actions">
          <button type="button" disabled={disabled} onClick={onKeep}>
            Keep
          </button>
          <button
            type="button"
            className="danger-action"
            disabled={disabled || !change.undoable}
            onClick={onUndo}
            title={
              change.undoable
                ? "Restore this change"
                : "No rollback for this change"
            }
          >
            Undo
          </button>
        </div>
      ) : null}
      {change.message ? (
        <span className="change-message" title={change.message}>
          {change.message}
        </span>
      ) : null}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  readonly status: ChangeView["status"];
}): JSX.Element {
  return <span className={`change-status status-${status}`}>{status}</span>;
}

function ReviewFooter({
  acceptedIds,
  disabled,
  postApply,
  onApply,
  onDiscard,
  onDeny,
  onKeepAll,
  onUndoAll,
}: ChangeReviewProps & { readonly postApply: boolean }): JSX.Element {
  if (postApply) {
    return (
      <footer className="review-footer">
        <span>Review in note editor</span>
        <div>
          <button
            type="button"
            className="primary"
            onClick={onKeepAll}
            disabled={disabled}
          >
            Keep all
          </button>
          <button
            type="button"
            className="danger-action"
            onClick={onUndoAll}
            disabled={disabled}
          >
            Undo all
          </button>
        </div>
      </footer>
    );
  }

  return (
    <footer className="review-footer">
      <span>{acceptedIds.size} accepted</span>
      <div>
        <button
          type="button"
          className="primary"
          onClick={onApply}
          disabled={disabled || acceptedIds.size === 0}
        >
          Apply
        </button>
        <button type="button" onClick={onDiscard} disabled={disabled}>
          Discard
        </button>
        <button
          type="button"
          className="danger-action"
          onClick={onDeny}
          disabled={disabled}
        >
          Deny &amp; Restore
        </button>
      </div>
    </footer>
  );
}

function formatStats(stats: { added: number; removed: number }): string {
  return `+${stats.added}/−${stats.removed}`;
}
