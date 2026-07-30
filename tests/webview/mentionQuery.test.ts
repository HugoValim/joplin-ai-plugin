import {
  activeMentionQuery,
  applyMentionLabel,
} from "../../src/webview/mentionQuery";

describe("activeMentionQuery", () => {
  test("detects @query at caret after whitespace or start", () => {
    expect(activeMentionQuery("@", 1)).toEqual({
      start: 0,
      end: 1,
      query: "",
    });
    expect(activeMentionQuery("see @gui", 8)).toEqual({
      start: 4,
      end: 8,
      query: "gui",
    });
  });

  test("ignores email-like @ and closed queries", () => {
    expect(activeMentionQuery("a@b", 3)).toBeNull();
    expect(activeMentionQuery("see @gui more", 13)).toBeNull();
    expect(activeMentionQuery("see @gui ", 9)).toBeNull();
  });
});

describe("applyMentionLabel", () => {
  test("replaces the @query span with a labeled mention", () => {
    const range = activeMentionQuery("see @gui", 8);
    if (!range) throw new Error("expected range");
    expect(applyMentionLabel("see @gui", range, "Guide")).toBe("see @Guide ");
  });
});
