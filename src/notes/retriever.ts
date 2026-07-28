export interface NoteSearchHit {
  readonly id: string;
  readonly title: string;
  readonly updatedTime: number;
  readonly parentId?: string;
}

export interface NoteRecord extends NoteSearchHit {
  readonly parentId: string;
  readonly body: string;
}

export interface NoteMetadataRecord extends NoteSearchHit {
  readonly parentId: string;
  readonly order: number;
}

export interface NotebookRecord {
  readonly id: string;
  readonly title: string;
  readonly parentId: string;
}

export interface NotebookMetadataRecord extends NotebookRecord {
  readonly updatedTime: number;
}

export interface CreateNoteInput {
  readonly parentId: string;
  readonly title: string;
  readonly body: string;
}

export interface CreateNotebookInput {
  readonly parentId: string;
  readonly title: string;
}

export interface UpdateNoteBodyInput {
  readonly noteId: string;
  readonly body: string;
  readonly expectedUpdatedTime: number;
}

export interface UpdateNoteMetadataInput {
  readonly noteId: string;
  readonly expectedUpdatedTime: number;
  readonly title?: string;
  readonly parentId?: string;
  readonly order?: number;
}

export interface UpdateNotebookMetadataInput {
  readonly notebookId: string;
  readonly expectedUpdatedTime: number;
  readonly title?: string;
  readonly parentId?: string;
}

export interface TrashNoteInput {
  readonly noteId: string;
  readonly expectedUpdatedTime: number;
}

export interface TrashNotebookInput {
  readonly notebookId: string;
  readonly expectedUpdatedTime: number;
}

export interface NoteRepository {
  searchNotes(query: string, limit: number): Promise<readonly NoteSearchHit[]>;
  readNote(noteId: string): Promise<NoteRecord>;
  listNotebooks(): Promise<readonly NotebookRecord[]>;
  createNote(input: CreateNoteInput): Promise<NoteRecord>;
  updateNoteBody(input: UpdateNoteBodyInput): Promise<NoteRecord>;
}

export interface NoteOrganizationRepository {
  readNoteMetadata(noteId: string): Promise<NoteMetadataRecord>;
  listNotebookNotes(
    notebookId: string,
    limit: number,
  ): Promise<readonly NoteMetadataRecord[]>;
  readNotebook(notebookId: string): Promise<NotebookMetadataRecord>;
  createNotebook(input: CreateNotebookInput): Promise<NotebookMetadataRecord>;
  updateNoteMetadata(
    input: UpdateNoteMetadataInput,
  ): Promise<NoteMetadataRecord>;
  updateNotebookMetadata(
    input: UpdateNotebookMetadataInput,
  ): Promise<NotebookMetadataRecord>;
  trashNote(input: TrashNoteInput): Promise<void>;
  trashNotebook(input: TrashNotebookInput): Promise<void>;
}

export interface NoteSnippet {
  readonly noteId: string;
  readonly parentNotebookId: string;
  readonly title: string;
  readonly heading: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
  readonly score: number;
}

export interface SemanticNoteSearch {
  search(query: string, limit: number): Promise<readonly NoteSnippet[]>;
}

const MAX_SNIPPETS = 6;
const MAX_CONTEXT_CHARACTERS = 12_000;

export class NoteRetriever {
  public constructor(
    private readonly repository: NoteRepository,
    private readonly semanticSearch?: SemanticNoteSearch,
  ) {}

  /**
   * Retrieves bounded note snippets only when the user enables vault context.
   *
   * @example await retriever.retrieve('deployment notes', true)
   */
  public async retrieve(
    query: string,
    enabled: boolean,
    secretNotebookIds: ReadonlySet<string> = new Set(),
  ): Promise<readonly NoteSnippet[]> {
    if (!enabled) return [];
    const hits = await this.repository.searchNotes(query, 20);
    const allowedHits = hits.filter(
      (hit) => !isSecretParent(secretNotebookIds, hit.parentId),
    );
    const keyword = await this.loadKeywordSnippets(
      allowedHits,
      query,
      secretNotebookIds,
    );
    const semantic = await this.loadSemanticSnippets(query, secretNotebookIds);
    return boundSnippets(mergeRanks(keyword, semantic));
  }

  private async loadKeywordSnippets(
    hits: readonly NoteSearchHit[],
    query: string,
    secretNotebookIds: ReadonlySet<string>,
  ): Promise<NoteSnippet[]> {
    const snippets: NoteSnippet[] = [];
    for (const hit of hits) {
      const note = await this.repository.readNote(hit.id);
      if (isSecretParent(secretNotebookIds, note.parentId)) continue;
      for (const chunk of chunkMarkdown(note.body)) {
        snippets.push(toSnippet(note, chunk, query));
      }
    }
    return snippets.sort((left, right) => right.score - left.score);
  }

  private async loadSemanticSnippets(
    query: string,
    secretNotebookIds: ReadonlySet<string>,
  ): Promise<readonly NoteSnippet[]> {
    if (!this.semanticSearch) return [];
    try {
      const snippets = await this.semanticSearch.search(query, 20);
      return snippets.filter(
        (snippet) => !isSecretParent(secretNotebookIds, snippet.parentNotebookId),
      );
    } catch {
      return [];
    }
  }
}

interface MarkdownChunk {
  readonly heading: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
}

/**
 * Splits Markdown on headings while preserving one-based source line ranges.
 *
 * @example chunkMarkdown('# One\nText\n## Two\nMore')
 */
export function chunkMarkdown(markdown: string): readonly MarkdownChunk[] {
  const lines = markdown.split(/\r?\n/);
  const chunks: MarkdownChunk[] = [];
  let heading = "Document";
  let lineStart = 1;
  let buffered: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (/^#{1,6}\s+/.test(line) && buffered.some((value) => value.trim())) {
      chunks.push(createChunk(heading, lineStart, index, buffered));
      buffered = [];
      lineStart = index + 1;
    }
    if (/^#{1,6}\s+/.test(line))
      heading = line.replace(/^#{1,6}\s+/, "").trim();
    buffered.push(line);
  }
  if (buffered.some((value) => value.trim())) {
    chunks.push(createChunk(heading, lineStart, lines.length, buffered));
  }
  return chunks;
}

function createChunk(
  heading: string,
  lineStart: number,
  lineEnd: number,
  lines: readonly string[],
): MarkdownChunk {
  return { heading, lineStart, lineEnd, text: lines.join("\n").trim() };
}

function toSnippet(
  note: NoteRecord,
  chunk: MarkdownChunk,
  query: string,
): NoteSnippet {
  const terms = tokenize(query);
  const score =
    scoreText(note.title, terms, 2) +
    scoreText(chunk.heading, terms, 4) +
    scoreText(chunk.text, terms, 1);
  return {
    noteId: note.id,
    parentNotebookId: note.parentId,
    title: note.title,
    heading: chunk.heading,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
    text: chunk.text,
    score,
  };
}

function tokenize(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((term) => term.length > 1),
    ),
  ];
}

function scoreText(
  value: string,
  terms: readonly string[],
  weight: number,
): number {
  const normalized = value.toLocaleLowerCase();
  return terms.reduce(
    (score, term) => score + countOccurrences(normalized, term) * weight,
    0,
  );
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let position = value.indexOf(term);
  while (position >= 0) {
    count += 1;
    position = value.indexOf(term, position + term.length);
  }
  return count;
}

function boundSnippets(snippets: readonly NoteSnippet[]): NoteSnippet[] {
  const bounded: NoteSnippet[] = [];
  let remaining = MAX_CONTEXT_CHARACTERS;
  for (const snippet of snippets.slice(0, MAX_SNIPPETS)) {
    if (remaining <= 0) break;
    const text = snippet.text.slice(0, remaining);
    bounded.push({ ...snippet, text });
    remaining -= text.length;
  }
  return bounded;
}

function mergeRanks(
  keyword: readonly NoteSnippet[],
  semantic: readonly NoteSnippet[],
): NoteSnippet[] {
  const fused = new Map<string, NoteSnippet>();
  addRankedSnippets(fused, keyword);
  addRankedSnippets(fused, semantic);
  return [...fused.values()].sort((left, right) => right.score - left.score);
}

function addRankedSnippets(
  fused: Map<string, NoteSnippet>,
  snippets: readonly NoteSnippet[],
): void {
  for (const [rank, snippet] of snippets.entries()) {
    const key = `${snippet.noteId}:${snippet.lineStart}:${snippet.lineEnd}`;
    const contribution = 1 / (60 + rank + 1);
    const existing = fused.get(key);
    fused.set(key, {
      ...(existing ?? snippet),
      score: (existing?.score ?? 0) + contribution,
    });
  }
}

function isSecretParent(
  secretNotebookIds: ReadonlySet<string>,
  parentNotebookId?: string,
): boolean {
  return Boolean(parentNotebookId && secretNotebookIds.has(parentNotebookId));
}
