/**
 * Active `@query` range in composer text for Cursor-style mentions.
 */
export interface MentionQueryRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/**
 * Detects an open `@mention` query ending at the caret.
 *
 * @example activeMentionQuery("see @gui", 8) // { start: 4, end: 8, query: "gui" }
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): MentionQueryRange | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0) {
    const prev = before[at - 1];
    if (prev && !/\s/.test(prev)) return null;
  }
  const query = before.slice(at + 1);
  if (/[\n\r]/.test(query)) return null;
  if (/\s/.test(query)) return null;
  return { start: at, end: caret, query };
}

/**
 * Replaces the active `@query` span with a display label and trailing space.
 *
 * @example applyMentionLabel("see @gui", range, "Guide")
 */
export function applyMentionLabel(
  text: string,
  range: MentionQueryRange,
  label: string,
): string {
  const safe = label.trim() || "Untitled";
  return `${text.slice(0, range.start)}@${safe} ${text.slice(range.end)}`;
}

/**
 * Appends Cursor-style `@Title` tokens to composer text.
 *
 * @example appendMentionLabels("Hi", ["Guide"]) // "Hi @Guide "
 */
export function appendMentionLabels(
  text: string,
  labels: readonly string[],
): string {
  let result = text;
  for (const label of labels) {
    const token = `@${(label.trim() || "Untitled").replace(/\s+/g, " ")} `;
    if (!result) {
      result = token;
      continue;
    }
    result = /\s$/.test(result) ? `${result}${token}` : `${result} ${token}`;
  }
  return result;
}

/**
 * Appends a `@Title:L12-L40` selection-ref token to composer text.
 *
 * @example appendSelectionRefLabel("Hi", "Guide", 2, 4) // "Hi @Guide:L2-L4 "
 */
export function appendSelectionRefLabel(
  text: string,
  title: string,
  startLine: number,
  endLine: number,
): string {
  const range =
    startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return appendMentionLabels(text, [`${title}:${range}`]);
}
