import { formatUsageSummary } from "../../src/webview/usageFormat";

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
