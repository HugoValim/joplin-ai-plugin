import {
  isSafeExternalMarkdownUrl,
  safeMarkdownUrlTransform,
} from "../../src/webview/markdownSecurity";

describe("safeMarkdownUrlTransform", () => {
  test("allows in-page anchors", () => {
    expect(safeMarkdownUrlTransform("#section")).toBe("#section");
  });

  test("allows absolute http and https URLs", () => {
    expect(safeMarkdownUrlTransform("https://example.test/doc")).toBe(
      "https://example.test/doc",
    );
    expect(safeMarkdownUrlTransform("http://example.test/doc")).toBe(
      "http://example.test/doc",
    );
  });

  test("blocks protocol-relative and dangerous URLs", () => {
    expect(safeMarkdownUrlTransform("//evil.test/track")).toBe("");
    expect(safeMarkdownUrlTransform("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrlTransform("data:text/html,hi")).toBe("");
    expect(safeMarkdownUrlTransform("file:///etc/passwd")).toBe("");
  });
});

describe("isSafeExternalMarkdownUrl", () => {
  test("accepts only http and https absolute URLs", () => {
    expect(isSafeExternalMarkdownUrl("https://cern.ch/x")).toBe(true);
    expect(isSafeExternalMarkdownUrl("http://cern.ch/x")).toBe(true);
    expect(isSafeExternalMarkdownUrl("#local")).toBe(false);
    expect(isSafeExternalMarkdownUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalMarkdownUrl("//evil.test")).toBe(false);
  });
});
