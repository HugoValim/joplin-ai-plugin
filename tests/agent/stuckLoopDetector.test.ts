import {
  StuckLoopDetector,
  DEFAULT_STUCK_LOOP_CONFIG,
} from "../../src/agent/stuckLoopDetector";

describe("StuckLoopDetector", () => {
  test("does not flag varied steps as stuck", () => {
    const detector = new StuckLoopDetector();
    expect(detector.addStep("Reading note about project roadmap")).toBe(false);
    expect(detector.addStep("Searching for related meeting notes")).toBe(false);
    expect(detector.addStep("Proposing edits to the first note")).toBe(false);
    expect(detector.isStuck()).toBe(false);
  });

  test("flags repeated identical intent text as stuck", () => {
    const detector = new StuckLoopDetector();
    const repeated = "Propose X and read remaining notes";
    expect(detector.addStep(repeated)).toBe(false);
    expect(detector.addStep(repeated)).toBe(false);
    expect(detector.addStep(repeated)).toBe(true);
  });

  test("normalizes whitespace and case before comparing", () => {
    const detector = new StuckLoopDetector();
    expect(detector.addStep("  PROPOSE X  and read remaining notes  ")).toBe(false);
    expect(detector.addStep("propose x  AND read remaining notes")).toBe(false);
    expect(detector.addStep("Propose X and  read  remaining notes")).toBe(true);
  });

  test("respects the sliding window — old duplicates age out", () => {
    const detector = new StuckLoopDetector({ window: 4, threshold: 3 });
    const repeated = "Same intent text repeated across steps";
    detector.addStep(repeated);
    detector.addStep(repeated);
    // Two varied steps push the first duplicate out of the window
    detector.addStep("A different step now");
    detector.addStep("Another different step");
    expect(detector.isStuck()).toBe(false);
  });

  test("ignores very short texts", () => {
    const detector = new StuckLoopDetector();
    expect(detector.addStep("hi")).toBe(false);
    expect(detector.addStep("hi")).toBe(false);
    expect(detector.addStep("hi")).toBe(false);
    expect(detector.isStuck()).toBe(false);
  });

  test("flags repeated text-only steps even when narration varies", () => {
    const detector = new StuckLoopDetector();
    expect(detector.addTextOnlyStep()).toBe(false);
    expect(detector.addTextOnlyStep()).toBe(false);
    expect(detector.addTextOnlyStep()).toBe(true);
  });

  test("reset clears the window", () => {
    const detector = new StuckLoopDetector();
    const repeated = "Propose X and read remaining notes";
    detector.addStep(repeated);
    detector.addStep(repeated);
    detector.reset();
    expect(detector.isStuck()).toBe(false);
  });

  test("default config has window 5 and threshold 3", () => {
    expect(DEFAULT_STUCK_LOOP_CONFIG.window).toBe(5);
    expect(DEFAULT_STUCK_LOOP_CONFIG.threshold).toBe(3);
  });
});