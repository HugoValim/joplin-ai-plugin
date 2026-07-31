import type { MentionCandidate } from "../shared/protocol";
import type { NoteRepository } from "../notes/retriever";

/**
 * Searches notes and notebooks for the @-mention picker.
 *
 * @example const candidates = await port.searchMentions('deploy')
 */
export interface MentionSearchPort {
  searchMentions(query: string): Promise<readonly MentionCandidate[]>;
}

const MENTION_LIMIT = 20;

function matchesQuery(title: string, query: string): boolean {
  return title.toLowerCase().includes(query.toLowerCase());
}

function toNoteCandidate(note: NoteRepositoryResult): MentionCandidate {
  return {
    kind: "note",
    id: note.id,
    title: note.title,
    parentId: note.parentId,
  };
}

function toNotebookCandidate(notebook: NotebookResult): MentionCandidate {
  return {
    kind: "notebook",
    id: notebook.id,
    title: notebook.title,
    parentId: notebook.parentId,
  };
}

/**
 * Combines note search and notebook listing into mention candidates.
 *
 * @example const candidates = await searchMentions(repo, 'deploy')
 */
export async function searchMentions(
  repository: NoteRepository,
  query: string,
): Promise<readonly MentionCandidate[]> {
  const trimmed = query.trim();
  const noteHits = await repository.searchNotes(trimmed || " ", MENTION_LIMIT);
  const allNotebooks = await repository.listNotebooks();
  const matchedNotebooks = trimmed
    ? allNotebooks.filter((nb) => matchesQuery(nb.title, trimmed))
    : allNotebooks;
  return [
    ...noteHits.slice(0, MENTION_LIMIT).map(toNoteCandidate),
    ...matchedNotebooks.slice(0, MENTION_LIMIT).map(toNotebookCandidate),
  ];
}

interface NoteRepositoryResult {
  readonly id: string;
  readonly title: string;
  readonly parentId?: string;
}

interface NotebookResult {
  readonly id: string;
  readonly title: string;
  readonly parentId: string;
}
