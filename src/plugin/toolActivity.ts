import type { ToolExecutionResult } from "../tools/toolRegistry";

/**
 * Produces a bounded, credential-free status label for sidebar tool activity.
 *
 * @example summarizeToolResult(reviewResult)
 */
export function summarizeToolResult(result: ToolExecutionResult): string {
  const preflight = readReviewPreflight(result);
  if (preflight) {
    return `Preflight: ${preflight.fileCount} files, ${preflight.totalBytes} bytes`;
  }
  const subagent = readSubAgentSummary(result);
  if (subagent) return subagent;
  return result.risk === "propose-write"
    ? "Added to proposed batch"
    : "Completed";
}

function readSubAgentSummary(result: ToolExecutionResult): string | null {
  if (result.name !== "start_subagent" && result.name !== "complete_subagent") {
    return null;
  }
  const output = result.output;
  if (typeof output !== "object" || output === null) return null;
  if (!("status" in output) || typeof output.status !== "string") return null;
  const id =
    "subagent_id" in output && typeof output.subagent_id === "string"
      ? output.subagent_id
      : "subagent";
  const preview =
    "result_text" in output &&
    typeof output.result_text === "string" &&
    output.result_text.trim().length > 0
      ? `: ${output.result_text.trim().slice(0, 80)}`
      : "";
  return `Subagent ${id}: ${output.status}${preview}`;
}

function readReviewPreflight(
  result: ToolExecutionResult,
): { readonly fileCount: number; readonly totalBytes: number } | null {
  if (result.name !== "review_text_files") return null;
  const output = result.output;
  if (typeof output !== "object" || output === null) return null;
  if (!("file_count" in output) || !("total_bytes" in output)) return null;
  if (
    typeof output.file_count !== "number" ||
    typeof output.total_bytes !== "number"
  ) {
    return null;
  }
  return { fileCount: output.file_count, totalBytes: output.total_bytes };
}
