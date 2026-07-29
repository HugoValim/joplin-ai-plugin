/**
 * Detects near-duplicate assistant intent text across consecutive steps
 * during an active Agent Plan. When N of the last M steps repeat the same
 * intent prose, the run is considered stuck. Text-only steps (no tools)
 * under a pending plan also count via a shared synthetic token.
 */

const DEFAULT_WINDOW = 5;
const DEFAULT_THRESHOLD = 3;
const MIN_TEXT_LENGTH = 20;
/** Synthetic token so varied "I'll propose now" narration still trips stuck. */
const TEXT_ONLY_TOKEN = "__text_only__";

export interface StuckLoopConfig {
  readonly window: number;
  readonly threshold: number;
}

export const DEFAULT_STUCK_LOOP_CONFIG: StuckLoopConfig = {
  window: DEFAULT_WINDOW,
  threshold: DEFAULT_THRESHOLD,
};

/**
 * Tracks recent assistant step texts and detects near-duplicate loops.
 *
 * @example const detector = new StuckLoopDetector(); detector.addStep(text)
 */
export class StuckLoopDetector {
  private readonly recent: string[] = [];
  private readonly config: StuckLoopConfig;

  public constructor(config: StuckLoopConfig = DEFAULT_STUCK_LOOP_CONFIG) {
    this.config = config;
  }

  /**
   * Records one assistant step text and returns true if a stuck loop is detected.
   *
   * @example if (detector.addStep(stepText)) abortRun()
   */
  public addStep(text: string): boolean {
    const normalized = normalizeText(text);
    if (normalized.length >= MIN_TEXT_LENGTH) {
      this.pushRecent(normalized);
    }
    return this.isStuck();
  }

  /**
   * Records a text-only (no tool calls) step under an active plan.
   * Varied narration still counts toward the stuck threshold.
   *
   * @example if (detector.addTextOnlyStep()) abortRun()
   */
  public addTextOnlyStep(): boolean {
    this.pushRecent(TEXT_ONLY_TOKEN);
    return this.isStuck();
  }

  private pushRecent(token: string): void {
    this.recent.push(token);
    if (this.recent.length > this.config.window) this.recent.shift();
  }

  /**
   * Reports whether the current window contains enough duplicates to be stuck.
   *
   * @example if (detector.isStuck()) breakLoop()
   */
  public isStuck(): boolean {
    if (this.recent.length < this.config.threshold) return false;
    const counts = new Map<string, number>();
    for (const text of this.recent) {
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= this.config.threshold) return true;
    }
    return false;
  }

  public reset(): void {
    this.recent.length = 0;
  }
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);
}
