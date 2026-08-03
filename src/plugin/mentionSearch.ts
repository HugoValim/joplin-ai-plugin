import type {
  NoteRecord,
  NoteSearchHit,
  NotebookRecord,
  NoteMetadataRecord,
} from "../notes/retriever";

export interface MentionSearchPort {
  searchNotes(query: string, limit: number): Promise<readonly NoteSearchHit[]>;
  listNotebooks(): Promise<readonly NotebookRecord[]>;
  listNotebookNotes(
    notebookId: string,
    limit: number,
  ): Promise<readonly NoteMetadataRecord[]>;
  readNote(noteId: string): Promise<NoteRecord>;
}

export interface MentionHit {
  readonly kind: "note" | "notebook";
  readonly id: string;
  readonly title: string;
}

/**
 * Searches notes and notebooks for Cursor-style @ mentions, excluding secrets.
 *
 * @example await searchMentionHits(notes, "gui", secretIds, 10)
 */
export async function searchMentionHits(
  port: MentionSearchPort,
  query: string,
  secretNotebookIds: ReadonlySet<string>,
  limit: number,
): Promise<readonly MentionHit[]> {
  const capped = Math.min(Math.max(limit, 1), 20);
  const needle = query.trim().toLowerCase();
  const notebooks = await filterNotebooks(
    port,
    needle,
    secretNotebookIds,
    capped,
  );
  const notes = await filterNotes(
    port,
    needle,
    secretNotebookIds,
    Math.max(capped - notebooks.length, 0),
  );
  return [...notebooks, ...notes].slice(0, capped);
}

async function filterNotebooks(
  port: MentionSearchPort,
  needle: string,
  secretNotebookIds: ReadonlySet<string>,
  limit: number,
): Promise<MentionHit[]> {
  if (limit <= 0) return [];
  const hits: MentionHit[] = [];
  for (const notebook of await port.listNotebooks()) {
    if (secretNotebookIds.has(notebook.id)) continue;
    if (needle && !notebook.title.toLowerCase().includes(needle)) continue;
    hits.push({
      kind: "notebook",
      id: notebook.id,
      title: notebook.title.trim() || "Untitled notebook",
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

async function filterNotes(
  port: MentionSearchPort,
  needle: string,
  secretNotebookIds: ReadonlySet<string>,
  limit: number,
): Promise<MentionHit[]> {
  if (limit <= 0) return [];
  const hits: MentionHit[] = [];
  const searched = needle ? await port.searchNotes(needle, limit * 3) : [];
  for (const hit of searched) {
    const parentId = await noteParentId(port, hit);
    if (parentId && secretNotebookIds.has(parentId)) continue;
    hits.push({
      kind: "note",
      id: hit.id,
      title: hit.title.trim() || "Untitled note",
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

async function noteParentId(
  port: MentionSearchPort,
  hit: NoteSearchHit,
): Promise<string | undefined> {
  if (hit.parentId) return hit.parentId;
  try {
    return (await port.readNote(hit.id)).parentId;
  } catch {
    return undefined;
  }
}
