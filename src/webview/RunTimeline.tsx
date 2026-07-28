import type { ActiveChatView } from "../shared/protocol";
import { formatUsageSummary } from "./usageFormat";

type RunSummary = ActiveChatView["runSummaries"][number];

interface RunTimelineProps {
  readonly summary: RunSummary;
}

/**
 * Renders a collapsed durable run record under an assistant turn.
 *
 * @example <RunTimeline summary={summary} />
 */
export function RunTimeline({ summary }: RunTimelineProps): JSX.Element {
  const usage = formatUsageSummary(summary);
  const tools = summary.toolNames?.length
    ? summary.toolNames.join(", ")
    : "none";
  return (
    <details className="run-timeline">
      <summary>
        Run · {summary.status}
        {usage ? ` · ${usage}` : ""}
      </summary>
      <p>{summary.summary}</p>
      <p className="run-timeline-tools">Tools: {tools}</p>
    </details>
  );
}
