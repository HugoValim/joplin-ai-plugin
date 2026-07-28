export interface UsageSummary {
  readonly promptTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface UsageFormatOptions {
  readonly contextWindowMax?: number;
}

/**
 * Formats a token count with a `k` suffix above 999.
 *
 * @example formatTokenCount(0) === "0"
 * @example formatTokenCount(999) === "999"
 * @example formatTokenCount(1000) === "1.0k"
 * @example formatTokenCount(12400) === "12.4k"
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const kilo = tokens / 1000;
  return `${kilo.toFixed(1)}k`.replace(".0k", "k");
}

/**
 * Formats token usage for the always-on composer footer, with an optional
 * context-window maximum shown as `total / windowMax`.
 *
 * @example formatUsageSummary({ promptTokens: 120, outputTokens: 45, totalTokens: 165 })
 * @example formatUsageSummary({ totalTokens: 13600 }, { contextWindowMax: 128000 })
 */
export function formatUsageSummary(
  usage: UsageSummary | null,
  options: UsageFormatOptions = {},
): string {
  if (!usage?.totalTokens && !usage?.promptTokens && !usage?.outputTokens) {
    return "";
  }
  const prompt = formatTokenCount(usage.promptTokens ?? 0);
  const output = formatTokenCount(usage.outputTokens ?? 0);
  const total = formatTokenCount(
    usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.outputTokens ?? 0),
  );
  const base = `${prompt} in · ${output} out · ${total} total`;
  if (options.contextWindowMax && options.contextWindowMax > 0) {
    return `${base} · ${total} / ${formatTokenCount(options.contextWindowMax)}`;
  }
  return base;
}
