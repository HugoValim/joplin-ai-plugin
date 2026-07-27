import {
  createPagedTranscriptState,
  decideTranscriptScroll,
  loadEarlierMessages,
  preservePrependOffset,
  visibleMessageStart,
} from "../../src/webview/transcriptState";

describe("transcript scroll policy", () => {
  test("follows content at the 80px near-bottom threshold", () => {
    expect(
      decideTranscriptScroll(
        { scrollTop: 320, scrollHeight: 800, clientHeight: 400 },
        "content-update",
      ),
    ).toBe("scroll-to-latest");
    expect(
      decideTranscriptScroll(
        { scrollTop: 319, scrollHeight: 800, clientHeight: 400 },
        "content-update",
      ),
    ).toBe("preserve-position");
  });

  test.each(["local-submit", "chat-switch"] as const)(
    "always follows after %s",
    (trigger) => {
      expect(
        decideTranscriptScroll(
          { scrollTop: 0, scrollHeight: 5_000, clientHeight: 400 },
          trigger,
        ),
      ).toBe("scroll-to-latest");
    },
  );

  test("loads the latest 100 messages in bounded pages", () => {
    const initial = createPagedTranscriptState(1_000);
    const next = loadEarlierMessages(initial, 1_000);

    expect(initial.loadedCount).toBe(100);
    expect(visibleMessageStart(1_000, initial)).toBe(900);
    expect(next.loadedCount).toBe(200);
    expect(visibleMessageStart(1_000, next)).toBe(800);
  });

  test("preserves visual offset when earlier messages are prepended", () => {
    expect(
      preservePrependOffset(
        { scrollTop: 240, scrollHeight: 2_000, clientHeight: 500 },
        3_200,
      ),
    ).toBe(1_440);
  });
});
