import type { ToolActivity } from "./sidebarState";

/**
 * Builds the one-line collapsed label for live run activity.
 *
 * @example formatRunActivitySummary("Model step 61 of 200", tools)
 */
export function formatRunActivitySummary(
  progress: string,
  tools: readonly ToolActivity[],
): string {
  const trimmedProgress = progress.trim();
  if (!tools.length) {
    return trimmedProgress;
  }

  const latestTool = findLatestToolName(tools);
  const aggregates = formatToolAggregates(tools);
  const parts = [trimmedProgress, latestTool, aggregates].filter(Boolean);
  return parts.join(" · ");
}

function findLatestToolName(tools: readonly ToolActivity[]): string {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (!tool) continue;
    if (tool.status === "running") {
      return tool.name;
    }
  }
  return tools[tools.length - 1]?.name ?? "";
}

function formatToolAggregates(tools: readonly ToolActivity[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${count}×${name}` : name))
    .join(", ");
}
