import type { MentionHitView } from "./MentionPicker";

const FOLDER_MIME = "text/x-jop-folder-ids";
const NOTE_MIME_TYPES = [
  "text/x-jop-note-ids",
  "application/x-jop-note-ids",
] as const;

export type NoteDropKind = "note" | "notebook" | "auto";

export interface NoteDropPayload {
  readonly kind: "note" | "notebook";
  readonly ids: readonly string[];
}

/**
 * Lists MIME types from a DataTransfer (DOMStringList or string[]).
 *
 * @example listDataTransferTypes(event.dataTransfer)
 */
export function listDataTransferTypes(
  data: DataTransfer | null,
): readonly string[] {
  if (!data) return [];
  return Array.from(data.types);
}

function dataTransferHasMime(data: DataTransfer, mime: string): boolean {
  return data.types.indexOf(mime) >= 0;
}

/**
 * True when a drag can become a note/notebook attach.
 * Empty types → accept (isolated iframe may strip Joplin MIME types).
 *
 * @example canAcceptNoteDrop(event.dataTransfer)
 */
export function canAcceptNoteDrop(data: DataTransfer | null): boolean {
  if (!data) return false;
  const types = listDataTransferTypes(data);
  if (types.length === 0) return true;
  if (dataTransferHasMime(data, FOLDER_MIME)) return true;
  if (NOTE_MIME_TYPES.some((mime) => dataTransferHasMime(data, mime))) {
    return true;
  }
  return parseNoteDropPayload(data) !== null;
}

/**
 * Infers attach kind from drag MIME types when the payload is stripped.
 *
 * @example dropKindFromDataTransfer(event.dataTransfer)
 */
export function dropKindFromDataTransfer(
  data: DataTransfer | null,
): NoteDropKind {
  if (!data) return "auto";
  if (dataTransferHasMime(data, FOLDER_MIME)) return "notebook";
  if (NOTE_MIME_TYPES.some((mime) => dataTransferHasMime(data, mime))) {
    return "note";
  }
  return "auto";
}

/**
 * Parses Joplin note/notebook drag payloads into ids (MIME may be empty).
 *
 * @example parseNoteDropPayload(event.dataTransfer)
 */
export function parseNoteDropPayload(
  data: DataTransfer | null,
): NoteDropPayload | null {
  if (!data) return null;
  const folderRaw = data.getData(FOLDER_MIME);
  const noteRaw =
    data.getData("text/x-jop-note-ids") ||
    data.getData("application/x-jop-note-ids");
  const raw = folderRaw || noteRaw || data.getData("text/plain");
  if (!raw.trim()) return null;
  const kind: NoteDropPayload["kind"] = folderRaw ? "notebook" : "note";
  const ids = parseIdList(raw);
  if (ids.length === 0) return null;
  return { kind, ids };
}

/**
 * Parses Joplin note/notebook drag payloads into a mention hit.
 *
 * @example mentionHitFromDataTransfer(event.dataTransfer)
 */
export function mentionHitFromDataTransfer(
  data: DataTransfer | null,
): MentionHitView | null {
  const parsed = parseNoteDropPayload(data);
  if (!parsed) return null;
  const id = parsed.ids[0];
  if (!id) return null;
  return { kind: parsed.kind, id, title: id };
}

function parseIdList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
    }
  } catch {
    // plain ids
  }
  return raw
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
