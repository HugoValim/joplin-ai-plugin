import type { MentionCandidate } from "../shared/protocol";

interface DataTransferLike {
  getData(format: string): string;
  types: readonly string[];
}

const NOTE_ID_PATTERN = /[A-Za-z0-9]{16,}/;

/**
 * Parses a dropped Joplin note/notebook reference into a mention candidate.
 *
 * Returns null for invalid or empty drops so the composer state stays intact.
 *
 * @example const candidate = parseDroppedReference(dataTransfer, 'note')
 */
export function parseDroppedReference(
  data: DataTransferLike,
  kind: "note" | "notebook",
): MentionCandidate | null {
  const text = readDropText(data);
  const id = extractId(text);
  if (!id) return null;
  return {
    kind,
    id,
    title: text.trim() || id,
  };
}

function readDropText(data: DataTransferLike): string {
  for (const format of ["text/plain", "text"]) {
    if (data.types.includes(format)) return data.getData(format);
  }
  return data.types.includes("text/plain") ? data.getData("text/plain") : "";
}

function extractId(text: string): string | null {
  if (!text) return null;
  const match = NOTE_ID_PATTERN.exec(text);
  return match ? (match[0] ?? null) : null;
}
