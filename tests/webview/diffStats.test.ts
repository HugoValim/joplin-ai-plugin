import {
  countDiffStats,
  parseUnifiedDiffLines,
} from "../../src/webview/diffStats";

const SAMPLE_DIFF = [
  "Index: note:before",
  "===================================================================",
  "--- note:before\tcurrent",
  "+++ note:after\tproposed",
  "@@ -1,3 +1,3 @@",
  " context",
  "-removed",
  "+added",
  " trailing",
].join("\n");

describe("diffStats", () => {
  test("parses unified diff into add/del/ctx line tokens", () => {
    const lines = parseUnifiedDiffLines(SAMPLE_DIFF);

    expect(lines).toEqual([
      { type: "ctx", text: " context" },
      { type: "del", text: "-removed" },
      { type: "add", text: "+added" },
      { type: "ctx", text: " trailing" },
    ]);
  });

  test("counts added and removed content lines", () => {
    expect(countDiffStats(SAMPLE_DIFF)).toEqual({ added: 1, removed: 1 });
  });

  test("treats empty diff as zero stats and no lines", () => {
    expect(parseUnifiedDiffLines("")).toEqual([]);
    expect(countDiffStats("")).toEqual({ added: 0, removed: 0 });
  });
});
