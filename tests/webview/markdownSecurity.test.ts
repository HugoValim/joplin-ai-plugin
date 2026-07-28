import { safeMarkdownUrlTransform } from "../../src/webview/markdownSecurity";

describe("safeMarkdownUrlTransform", () => {
  test("allows in-page anchors only", () => {
    expect(safeMarkdownUrlTransform("#section")).toBe("#section");
  });

  test("blocks remote and dangerous URLs", () => {
    expect(safeMarkdownUrlTransform("https://evil.test/track")).toBe("");
    expect(safeMarkdownUrlTransform("//evil.test/track")).toBe("");
    expect(safeMarkdownUrlTransform("javascript:alert(1)")).toBe("");
  });
});
