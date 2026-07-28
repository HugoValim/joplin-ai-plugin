export interface UsageSummary {
  readonly promptTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Formats token usage for the always-on composer footer.
 *
 * @example formatUsageSummary({ promptTokens: 120, outputTokens: 45, totalTokens: 165 })
 */
export function formatUsageSummary(usage: UsageSummary | null): string {
  if (!usage?.totalTokens && !usage?.promptTokens && !usage?.outputTokens) {
    return "";
  }
  const prompt = usage.promptTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? prompt + output;
  return `${prompt} in · ${output} out · ${total} total`;
}
