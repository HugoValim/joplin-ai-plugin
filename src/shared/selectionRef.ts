/**
 * 1-based inclusive line range inside a note body.
 */
export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Persisted pointer to selected lines in a note (no body text).
 */
export interface NoteSelectionRef {
  readonly noteId: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Editor selection plus owning note, used to build a durable line-range ref.
 */
export interface SelectionRefInput {
  readonly noteId: string;
  readonly title: string;
  readonly body: string;
  readonly selection: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * Resolves the 1-based line range of `selection` inside `body`.
 *
 * Tries exact match, trimmed match, per-line trimEnd alignment, then anchoring
 * on the first and last selected lines with Markdown syntax stripped. The last
 * step is what lets Rich Text `selectedText` (plain text with no `**`, list
 * bullets or link targets) resolve against a Markdown source body.
 *
 * @example lineRangeForSelection("a\nb\nc", "b\nc") // { startLine: 2, endLine: 3 }
 */
export function lineRangeForSelection(
  body: string,
  selection: string,
): LineRange | null {
  if (!selection) return null;
  const normalizedBody = normalizeNewlines(body);
  const normalizedSelection = normalizeNewlines(selection);
  const exact = indexRange(normalizedBody, normalizedSelection);
  if (exact) return exact;
  const trimmed = normalizedSelection.replace(/^\n+|\n+$/g, "");
  if (trimmed && trimmed !== normalizedSelection) {
    const trimmedRange = indexRange(normalizedBody, trimmed);
    if (trimmedRange) return trimmedRange;
  }
  const target = trimmed || normalizedSelection;
  return (
    fuzzyLineRange(normalizedBody, target) ??
    anchorLineRange(normalizedBody, target)
  );
}

/**
 * Uses explicit editor line numbers when present; otherwise resolves from body.
 *
 * @example resolveSelectionRange(input)
 */
export function resolveSelectionRange(
  input: SelectionRefInput,
): LineRange | null {
  const { startLine, endLine } = input;
  if (
    isPositiveLine(startLine) &&
    isPositiveLine(endLine) &&
    startLine <= endLine
  ) {
    return { startLine, endLine };
  }
  return lineRangeForSelection(input.body, input.selection);
}

/**
 * Builds a composer label for a note selection (without the leading `@`).
 *
 * @example selectionRefLabel("Guide", { startLine: 2, endLine: 4 }) // "Guide:L2-L4"
 */
export function selectionRefLabel(title: string, range: LineRange): string {
  const safe = (title.trim() || "Untitled").replace(/\s+/g, " ");
  if (range.startLine === range.endLine) return `${safe}:L${range.startLine}`;
  return `${safe}:L${range.startLine}-L${range.endLine}`;
}

/**
 * Extracts inclusive 1-based lines from a note body.
 *
 * @example extractBodyLines("a\nb\nc", { startLine: 2, endLine: 3 }) // "b\nc"
 */
export function extractBodyLines(body: string, range: LineRange): string {
  const lines = normalizeNewlines(body).split("\n");
  const start = Math.max(1, range.startLine);
  const end = Math.min(lines.length, range.endLine);
  if (start > end) return "";
  return lines.slice(start - 1, end).join("\n");
}

function indexRange(body: string, selection: string): LineRange | null {
  if (!selection) return null;
  const index = body.indexOf(selection);
  if (index < 0) return null;
  return rangeFromIndex(body, index, selection.length);
}

function fuzzyLineRange(body: string, selection: string): LineRange | null {
  const selLines = trimBlankEdges(
    selection.split("\n").map((line) => line.trimEnd()),
  );
  if (selLines.length === 0) return null;
  const first = selLines[0];
  if (first === undefined || first === "") return null;
  const bodyLines = body.split("\n").map((line) => line.trimEnd());
  for (let i = 0; i < bodyLines.length; i += 1) {
    if (bodyLines[i] !== first) continue;
    if (!linesMatchAt(bodyLines, selLines, i)) continue;
    return { startLine: i + 1, endLine: i + selLines.length };
  }
  return null;
}

/**
 * Locates the selection by its first and last lines, ignoring Markdown syntax.
 *
 * Rich Text hands us rendered plain text, so intermediate lines routinely
 * differ from the source body; anchoring on the outer lines still yields the
 * correct range.
 */
function anchorLineRange(body: string, selection: string): LineRange | null {
  const selLines = strippedNonEmptyLines(selection);
  const first = selLines[0];
  const last = selLines[selLines.length - 1];
  if (first === undefined || last === undefined) return null;
  const bodyLines = body.split("\n").map(stripMarkdownSyntax);
  const start = bodyLines.indexOf(first);
  if (start < 0) return null;
  const end = bodyLines.indexOf(last, start);
  if (end < 0) return null;
  return { startLine: start + 1, endLine: end + 1 };
}

function strippedNonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map(stripMarkdownSyntax)
    .filter((line) => line !== "");
}

function stripMarkdownSyntax(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function linesMatchAt(
  bodyLines: readonly string[],
  selLines: readonly string[],
  start: number,
): boolean {
  for (let j = 1; j < selLines.length; j += 1) {
    if (bodyLines[start + j] !== selLines[j]) return false;
  }
  return true;
}

function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start += 1;
  while (end > start && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end);
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function rangeFromIndex(
  body: string,
  index: number,
  length: number,
): LineRange {
  const startLine = body.slice(0, index).split("\n").length;
  const selected = body.slice(index, index + length);
  const endLine = startLine + selected.split("\n").length - 1;
  return { startLine, endLine };
}

function isPositiveLine(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
