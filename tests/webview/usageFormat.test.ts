import { formatUsageSummary, formatTokenCount } from "../../src/webview/usageFormat";

describe("formatUsageSummary", () => {
  test("formats prompt, output, and total tokens", () => {
    expect(
      formatUsageSummary({
        promptTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
      }),
    ).toBe("120 in · 45 out · 165 total");
  });

  test("returns empty text when usage is missing", () => {
    expect(formatUsageSummary(null)).toBe("");
  });
});

describe("formatTokenCount", () => {
  test("keeps whole numbers below 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("uses one-decimal k at exactly 1000", () => {
    expect(formatTokenCount(1000)).toBe("1k");
  });

  test("uses one-decimal k for large totals", () => {
    expect(formatTokenCount(12400)).toBe("12.4k");
    expect(formatTokenCount(13600)).toBe("13.6k");
  });

  test("drops the decimal for whole thousands", () => {
    expect(formatTokenCount(5000)).toBe("5k");
  });
});

describe("formatUsageSummary context window", () => {
  test("appends context window max when provided", () => {
    expect(
      formatUsageSummary(
        { promptTokens: 12000, outputTokens: 1600, totalTokens: 13600 },
        { contextWindowMax: 128000 },
      ),
    ).toBe("12k in · 1.6k out · 13.6k total · 13.6k / 128k");
  });

  test("omits context window when max is missing or zero", () => {
    expect(
      formatUsageSummary({ totalTokens: 13600 }),
    ).toBe("0 in · 0 out · 13.6k total");
    expect(
      formatUsageSummary({ totalTokens: 13600 }, { contextWindowMax: 0 }),
    ).toBe("0 in · 0 out · 13.6k total");
  });

  test("handles missing window gracefully with small usage", () => {
    expect(
      formatUsageSummary(
        { promptTokens: 120, outputTokens: 45, totalTokens: 165 },
      ),
    ).toBe("120 in · 45 out · 165 total");
  });
});
