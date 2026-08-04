import { useEffect, useRef, useState } from "react";
import type { ChangeSetView } from "../shared/protocol";
import { countDiffStats } from "./diffStats";

type ChangeView = ChangeSetView["changes"][number];

export type ChangeReviewIntent =
  | ReviewApplyIntent
  | ReviewKeepIntent
  | ReviewUndoIntent
  | ReviewDiscardIntent
  | ReviewDenyIntent
  | ReviewOpenIntent;

interface ReviewApplyIntent extends ReviewIntentContext {
  readonly type: "apply";
  readonly phase: "Applying changes";
  readonly acceptedIds: readonly string[];
  readonly applyToken: string;
}

interface ReviewKeepIntent extends ReviewIntentContext {
  readonly type: "keep";
  readonly phase: "Keeping changes";
  readonly changeIds: readonly string[];
}

interface ReviewUndoIntent extends ReviewIntentContext {
  readonly type: "undo";
  readonly phase: "Undoing changes";
  readonly changeIds: readonly string[];
}

interface ReviewDiscardIntent extends ReviewIntentContext {
  readonly type: "discard";
  readonly phase: "Discarding changes";
}

interface ReviewDenyIntent extends ReviewIntentContext {
  readonly type: "deny";
  readonly phase: "Denying and restoring changes";
}

interface ReviewIntentContext {
  readonly changeSetId: string;
  readonly runId: string;
}

interface ReviewOpenIntent extends ReviewIntentContext {
  readonly type: "open";
}

export interface ChangeReviewTransport {
  readonly send: (intent: ChangeReviewIntent) => void;
}

interface ChangeReviewProps {
  readonly changeSet: ChangeSetView;
  readonly disabled: boolean;
  readonly phase: string;
  readonly transport: ChangeReviewTransport;
}

/**
 * Compact sidebar review strip; full diffs live in the Joplin Review Note.
 *
 * @example <ChangeReview changeSet={pending} transport={transport} />
 */
export function ChangeReview(props: ChangeReviewProps): JSX.Element {
  const postApply = isPostApplyReview(props.changeSet);
  const [acceptedIds, setAcceptedIds] = useAcceptedChanges(props.changeSet);
  const commands = reviewCommands(
    props.changeSet,
    acceptedIds,
    props.transport,
  );
  useAutoOpenReviewNote(props.changeSet.changeSetId, commands.open);

  return (
    <section
      className="change-review change-review-compact"
      aria-labelledby="change-review-title"
    >
      <ReviewHeader
        {...props}
        postApply={postApply}
        onOpenReview={commands.open}
        onSelectAll={() => setAcceptedIds(proposedIds(props.changeSet))}
        onSelectNone={() => setAcceptedIds(new Set())}
      />
      <div className="review-list" aria-label="Proposed changes" role="list">
        {props.changeSet.changes.map((change) => (
          <ChangeRow
            key={change.id}
            change={change}
            accepted={acceptedIds.has(change.id)}
            disabled={props.disabled}
            postApply={postApply}
            onToggle={(changeId) =>
              setAcceptedIds((current) => toggleId(current, changeId))
            }
            onKeep={() => commands.keep([change.id])}
            onUndo={() => commands.undo([change.id])}
          />
        ))}
      </div>
      <ReviewFooter
        {...props}
        acceptedIds={acceptedIds}
        postApply={postApply}
        onApply={commands.apply}
        onDiscard={commands.discard}
        onDeny={commands.deny}
        onKeepAll={() =>
          commands.keep(props.changeSet.changes.map(({ id }) => id))
        }
        onUndoAll={commands.deny}
      />
    </section>
  );
}

function useAcceptedChanges(
  changeSet: ChangeSetView,
): readonly [
  ReadonlySet<string>,
  React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
] {
  const [acceptedIds, setAcceptedIds] = useState<ReadonlySet<string>>(
    proposedIds(changeSet),
  );
  useEffect(
    () => setAcceptedIds(proposedIds(changeSet)),
    [changeSet.changeSetId],
  );
  return [acceptedIds, setAcceptedIds];
}

function proposedIds(changeSet: ChangeSetView): ReadonlySet<string> {
  return new Set(
    changeSet.changes
      .filter(({ status }) => status === "proposed")
      .map(({ id }) => id),
  );
}

function toggleId(
  current: ReadonlySet<string>,
  changeId: string,
): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(changeId)) next.delete(changeId);
  else next.add(changeId);
  return next;
}

function reviewCommands(
  changeSet: ChangeSetView,
  acceptedIds: ReadonlySet<string>,
  transport: ChangeReviewTransport,
): ReviewCommands {
  const base = {
    changeSetId: changeSet.changeSetId,
    runId: reviewRunId(changeSet),
  };
  return {
    open: () => transport.send({ ...base, type: "open" }),
    apply: () =>
      transport.send({
        ...base,
        type: "apply",
        phase: "Applying changes",
        acceptedIds: [...acceptedIds],
        applyToken: changeSet.applyToken,
      }),
    discard: () =>
      transport.send({ ...base, type: "discard", phase: "Discarding changes" }),
    deny: () =>
      transport.send({
        ...base,
        type: "deny",
        phase: "Denying and restoring changes",
      }),
    keep: (changeIds) =>
      transport.send({
        ...base,
        type: "keep",
        phase: "Keeping changes",
        changeIds,
      }),
    undo: (changeIds) =>
      transport.send({
        ...base,
        type: "undo",
        phase: "Undoing changes",
        changeIds,
      }),
  };
}

interface ReviewCommands {
  readonly open: () => void;
  readonly apply: () => void;
  readonly discard: () => void;
  readonly deny: () => void;
  readonly keep: (changeIds: readonly string[]) => void;
  readonly undo: (changeIds: readonly string[]) => void;
}

function reviewRunId(changeSet: ChangeSetView): string {
  return changeSet.runId ?? changeSet.changeSetId;
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
}: ChangeReviewProps & {
  readonly postApply: boolean;
  readonly onOpenReview: () => void;
  readonly onSelectAll: () => void;
  readonly onSelectNone: () => void;
}): JSX.Element {
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
}: Pick<ChangeReviewProps, "disabled"> & {
  readonly acceptedIds: ReadonlySet<string>;
  readonly postApply: boolean;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly onDeny: () => void;
  readonly onKeepAll: () => void;
  readonly onUndoAll: () => void;
}): JSX.Element {
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
