import {
  activeMentionQuery,
  appendMentionLabels,
  appendSelectionRefLabel,
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

describe("appendMentionLabels", () => {
  test("appends @Title tokens with spacing", () => {
    expect(appendMentionLabels("", ["Guide"])).toBe("@Guide ");
    expect(appendMentionLabels("Hi", ["Guide", "Spec"])).toBe(
      "Hi @Guide @Spec ",
    );
    expect(appendMentionLabels("Hi ", ["Guide"])).toBe("Hi @Guide ");
  });
});

describe("appendSelectionRefLabel", () => {
  test("appends @Title:L# tokens for single and multi-line ranges", () => {
    expect(appendSelectionRefLabel("", "Guide", 3, 3)).toBe("@Guide:L3 ");
    expect(appendSelectionRefLabel("Hi", "Guide", 2, 5)).toBe(
      "Hi @Guide:L2-L5 ",
    );
  });
});
