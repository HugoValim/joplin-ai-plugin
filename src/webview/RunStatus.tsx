import { useEffect, useState } from "react";
import type { RunFailure, ToolActivity } from "./sidebarState";

interface RunActivityProps {
  readonly tools: readonly ToolActivity[];
  readonly progress: string;
  readonly failure: RunFailure | null;
}

/**
 * Renders tool progress and concise expandable failures near the active run.
 *
 * @example <RunActivity tools={tools} progress={progress} failure={failure} />
 */
export function RunActivity({
  tools,
  progress,
  failure,
}: RunActivityProps): JSX.Element | null {
  if (!tools.length && !progress && !failure) return null;
  return (
    <aside className="run-activity" aria-label="Run activity">
      {progress ? <p>{progress}</p> : null}
      {tools.length ? <ToolActivityList tools={tools} /> : null}
      {failure ? <RunError failure={failure} /> : null}
    </aside>
  );
}

function ToolActivityList({
  tools,
}: {
  readonly tools: readonly ToolActivity[];
}): JSX.Element {
  return (
    <details>
      <summary>Tool activity ({tools.length})</summary>
      <ul>
        {tools.map((tool) => (
          <li key={tool.id}>
            <strong>{tool.name}</strong>
            <span>{tool.summary ?? tool.status}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function RunError({ failure }: { readonly failure: RunFailure }): JSX.Element {
  return (
    <div className="run-error" role="alert">
      <strong>Run failed.</strong>
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
