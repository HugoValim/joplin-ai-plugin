export type DiffLineType = "add" | "del" | "ctx";

export interface DiffLineToken {
  readonly type: DiffLineType;
  readonly text: string;
}

export interface DiffLineStats {
  readonly added: number;
  readonly removed: number;
}

/**
 * Parses a unified diff body into display tokens, skipping headers/hunk marks.
 *
 * @example parseUnifiedDiffLines("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new")
 */
export function parseUnifiedDiffLines(diff: string): readonly DiffLineToken[] {
  if (!diff) return [];
  const tokens: DiffLineToken[] = [];
  for (const raw of diff.split("\n")) {
    const token = classifyDiffLine(raw);
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * Counts added and removed content lines in a unified diff.
 *
 * @example countDiffStats(change.diff) // { added: 3, removed: 1 }
 */
export function countDiffStats(diff: string): DiffLineStats {
  let added = 0;
  let removed = 0;
  for (const line of parseUnifiedDiffLines(diff)) {
    if (line.type === "add") added += 1;
    if (line.type === "del") removed += 1;
  }
  return { added, removed };
}

function classifyDiffLine(raw: string): DiffLineToken | null {
  if (
    raw.startsWith("Index:") ||
    raw.startsWith("===") ||
    raw.startsWith("---") ||
    raw.startsWith("+++") ||
    raw.startsWith("@@")
  ) {
    return null;
  }
  if (raw.startsWith("+")) return { type: "add", text: raw };
  if (raw.startsWith("-")) return { type: "del", text: raw };
  if (raw.startsWith("\\")) return null;
  return { type: "ctx", text: raw };
}
