export const NEAR_BOTTOM_PX = 80;
export const TRANSCRIPT_PAGE_SIZE = 100;

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export type ScrollDecision = "scroll-to-latest" | "preserve-position";
export type ScrollTrigger = "content-update" | "local-submit" | "chat-switch";

export interface PagedTranscriptState {
  readonly loadedCount: number;
  readonly unreadCount: number;
}

/**
 * Decides whether a transcript update should follow latest content.
 *
 * @example decideTranscriptScroll(metrics, "content-update")
 */
export function decideTranscriptScroll(
  metrics: ScrollMetrics,
  trigger: ScrollTrigger,
): ScrollDecision {
  if (trigger !== "content-update") return "scroll-to-latest";
  const distance =
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return distance <= NEAR_BOTTOM_PX ? "scroll-to-latest" : "preserve-position";
}

/**
 * Creates the bounded latest-message window for one chat.
 *
 * @example createPagedTranscriptState(messages.length)
 */
export function createPagedTranscriptState(
  messageCount: number,
): PagedTranscriptState {
  return {
    loadedCount: Math.min(messageCount, TRANSCRIPT_PAGE_SIZE),
    unreadCount: 0,
  };
}

/**
 * Extends the visible transcript by one 100-message page.
 *
 * @example loadEarlierMessages(state, messages.length)
 */
export function loadEarlierMessages(
  state: PagedTranscriptState,
  messageCount: number,
): PagedTranscriptState {
  return {
    ...state,
    loadedCount: Math.min(
      messageCount,
      state.loadedCount + TRANSCRIPT_PAGE_SIZE,
    ),
  };
}

/**
 * Returns the first visible index for the bounded latest-message window.
 *
 * @example visibleMessageStart(messages.length, state)
 */
export function visibleMessageStart(
  messageCount: number,
  state: PagedTranscriptState,
): number {
  return Math.max(0, messageCount - state.loadedCount);
}

/**
 * Calculates scrollTop after content is prepended above the current view.
 *
 * @example preservePrependOffset(previousMetrics, nextScrollHeight)
 */
export function preservePrependOffset(
  previous: ScrollMetrics,
  nextScrollHeight: number,
): number {
  return previous.scrollTop + nextScrollHeight - previous.scrollHeight;
}
