import { useEffect, useState } from "react";
import { formatRunActivitySummary } from "./runActivitySummary";
import type {
  AgentPlanItemView,
  RunFailure,
  ToolActivity,
} from "./sidebarState";

interface RunActivityProps {
  readonly tools: readonly ToolActivity[];
  readonly plan: readonly AgentPlanItemView[];
  readonly progress: string;
  readonly failure: RunFailure | null;
  readonly canRetry: boolean;
  readonly onRetry?: () => void;
}

/**
 * Renders tool progress, agent plan checklist, and expandable failures.
 *
 * @example <RunActivity tools={tools} plan={plan} progress={progress} failure={failure} />
 */
export function RunActivity({
  tools,
  plan,
  progress,
  failure,
  canRetry,
  onRetry,
}: RunActivityProps): JSX.Element | null {
  const summary = formatRunActivitySummary(progress, tools);
  const planSummary = formatPlanSummary(plan);
  if (!summary && !planSummary && !failure) return null;
  return (
    <aside className="run-activity" aria-label="Run activity">
      {planSummary ? (
        <details className="run-activity-details run-plan-details">
          <summary className="run-activity-summary">{planSummary}</summary>
          <PlanItemList items={plan} />
        </details>
      ) : null}
      {summary ? (
        <details className="run-activity-details">
          <summary className="run-activity-summary">{summary}</summary>
          {tools.length ? <ToolActivityList tools={tools} /> : null}
        </details>
      ) : null}
      {failure ? (
        <RunError failure={failure} canRetry={canRetry} onRetry={onRetry} />
      ) : null}
    </aside>
  );
}

function formatPlanSummary(plan: readonly AgentPlanItemView[]): string {
  if (!plan.length) return "";
  const completed = plan.filter((item) => item.status === "completed").length;
  const inProgress = plan.filter((item) => item.status === "in_progress").length;
  const pending = plan.filter((item) => item.status === "pending").length;
  return `Plan ${completed}/${plan.length} done · ${inProgress} active · ${pending} pending`;
}

function PlanItemList({
  items,
}: {
  readonly items: readonly AgentPlanItemView[];
}): JSX.Element {
  return (
    <ul className="run-activity-list run-plan-list">
      {items.map((item) => (
        <li key={item.id} data-status={item.status}>
          <strong>{statusMarker(item.status)}</strong>
          <span>{item.content}</span>
        </li>
      ))}
    </ul>
  );
}

function statusMarker(status: AgentPlanItemView["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "…";
  if (status === "cancelled") return "×";
  return "○";
}

function ToolActivityList({
  tools,
}: {
  readonly tools: readonly ToolActivity[];
}): JSX.Element {
  return (
    <ul className="run-activity-list">
      {tools.map((tool) => (
        <li key={tool.id}>
          <strong>{tool.name}</strong>
          <span>{tool.summary ?? tool.status}</span>
        </li>
      ))}
    </ul>
  );
}

function RunError({
  failure,
  canRetry,
  onRetry,
}: {
  readonly failure: RunFailure;
  readonly canRetry: boolean;
  readonly onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="run-error" role="alert">
      <strong>Run failed.</strong>
      {canRetry && onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
      <details>
        <summary>Technical details</summary>
        <p>
          {failure.code}: {failure.message}
        </p>
      </details>
    </div>
  );
}

/**
 * Announces progress through one throttled region instead of the full feed.
 *
 * @example <RunLiveRegion announcement="Thinking" />
 */
export function RunLiveRegion({
  announcement,
}: {
  readonly announcement: string;
}): JSX.Element {
  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSpoken(announcement), 300);
    return () => window.clearTimeout(timer);
  }, [announcement]);
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {spoken}
    </div>
  );
}
