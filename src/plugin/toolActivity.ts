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
  return result.risk === "propose-write"
    ? "Added to approval batch"
    : "Completed";
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
