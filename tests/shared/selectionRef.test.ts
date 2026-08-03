import {
  extractBodyLines,
  lineRangeForSelection,
  resolveSelectionRange,
  selectionRefLabel,
} from "../../src/shared/selectionRef";

describe("lineRangeForSelection", () => {
  test("returns 1-based inclusive lines for a body match", () => {
    expect(lineRangeForSelection("a\nb\nc", "b\nc")).toEqual({
      startLine: 2,
      endLine: 3,
    });
    expect(lineRangeForSelection("only", "only")).toEqual({
      startLine: 1,
      endLine: 1,
    });
  });

  test("normalizes CRLF and returns null when selection is absent", () => {
    expect(lineRangeForSelection("a\r\nb\r\nc", "b\nc")).toEqual({
      startLine: 2,
      endLine: 3,
    });
    expect(lineRangeForSelection("a\nb", "")).toBeNull();
    expect(lineRangeForSelection("a\nb", "missing")).toBeNull();
  });

  test("aligns Rich Text selections that only differ by trailing spaces", () => {
    expect(
      lineRangeForSelection("alpha  \nbeta\ngamma ", "alpha\nbeta\ngamma"),
    ).toEqual({ startLine: 1, endLine: 3 });
  });

  test("anchors Rich Text plain text on Markdown-formatted body lines", () => {
    const body = [
      "# Setup",
      "",
      "Install the **runtime** first.",
      "- Run `npm install`",
      "- Open [the guide](https://example.com/guide)",
      "",
      "Done.",
    ].join("\n");
    const richTextSelection = [
      "Install the runtime first.",
      "Run npm install",
      "Open the guide",
    ].join("\n");

    expect(lineRangeForSelection(body, richTextSelection)).toEqual({
      startLine: 3,
      endLine: 5,
    });
  });

  test("anchors a single Rich Text line onto its Markdown source line", () => {
    expect(
      lineRangeForSelection(
        "# Title\n\n1. First _step_ here",
        "First step here",
      ),
    ).toEqual({ startLine: 3, endLine: 3 });
  });

  test("returns null when the anchor lines are absent from the body", () => {
    expect(
      lineRangeForSelection("# Title\n\nSome text", "unrelated sentence"),
    ).toBeNull();
  });
});

describe("resolveSelectionRange", () => {
  test("prefers explicit editor line numbers over body search", () => {
    expect(
      resolveSelectionRange({
        noteId: "n1",
        title: "Guide",
        body: "a\nb\nc",
        selection: "no-match",
        startLine: 2,
        endLine: 3,
      }),
    ).toEqual({ startLine: 2, endLine: 3 });
  });
});

describe("selectionRefLabel", () => {
  test("formats single and multi-line labels", () => {
    expect(selectionRefLabel("Guide", { startLine: 3, endLine: 3 })).toBe(
      "Guide:L3",
    );
    expect(selectionRefLabel("  My Note  ", { startLine: 2, endLine: 5 })).toBe(
      "My Note:L2-L5",
    );
    expect(selectionRefLabel("   ", { startLine: 1, endLine: 2 })).toBe(
      "Untitled:L1-L2",
    );
  });
});

describe("extractBodyLines", () => {
  test("extracts inclusive lines and clamps to body bounds", () => {
    expect(extractBodyLines("a\nb\nc", { startLine: 2, endLine: 3 })).toBe(
      "b\nc",
    );
    expect(extractBodyLines("a\nb", { startLine: 1, endLine: 9 })).toBe("a\nb");
    expect(extractBodyLines("a\nb", { startLine: 5, endLine: 6 })).toBe("");
  });
});
