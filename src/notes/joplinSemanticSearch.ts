import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "../shared/errors";
import type {
  NoteRepository,
  NoteSnippet,
  SemanticNoteSearch,
} from "./retriever";

interface JoplinAiSearchPort {
  search(options: {
    readonly query: { readonly text: string };
    readonly relevance: "normal";
  }): Promise<unknown>;
}

const ResultsSchema = Type.Array(
  Type.Object(
    {
      noteId: Type.String({ minLength: 1, maxLength: 128 }),
      chunkIndex: Type.Integer({ minimum: 0 }),
      chunkText: Type.String({ maxLength: 1_000_000 }),
      score: Type.Number({ minimum: 0, maximum: 1 }),
    },
    { additionalProperties: true },
  ),
  { maxItems: 100 },
);

export class JoplinSemanticNoteSearch implements SemanticNoteSearch {
  private constructor(
    private readonly ai: JoplinAiSearchPort,
    private readonly notes: NoteRepository,
  ) {}

  /**
   * Creates an adapter only when Joplin exposes native semantic search.
   *
   * @example JoplinSemanticNoteSearch.create(joplin.ai, repository)
   */
  public static create(
    candidate: unknown,
    notes: NoteRepository,
  ): JoplinSemanticNoteSearch | null {
    if (!hasSearch(candidate)) return null;
    return new JoplinSemanticNoteSearch(candidate, notes);
  }

  /**
   * Maps native semantic chunks to citation-ready note snippets.
   *
   * @example await semantic.search('related deployment notes', 20)
   */
  public async search(
    query: string,
    limit: number,
  ): Promise<readonly NoteSnippet[]> {
    const input = await this.ai.search({
      query: { text: query },
      relevance: "normal",
    });
    if (!Value.Check(ResultsSchema, input)) {
      throw new DomainError(
        "VALIDATION",
        `Invalid semantic response ${safeValue(input)}; expected Joplin search chunks`,
      );
    }
    const output: NoteSnippet[] = [];
    for (const hit of input.slice(0, limit)) {
      const note = await this.notes.readNote(hit.noteId);
      output.push(toSnippet(note.title, note.body, hit));
    }
    return output;
  }
}

function hasSearch(candidate: unknown): candidate is JoplinAiSearchPort {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "search" in candidate &&
    typeof candidate.search === "function"
  );
}

function toSnippet(
  title: string,
  body: string,
  hit: (typeof ResultsSchema.static)[number],
): NoteSnippet {
  const characterIndex = body.indexOf(hit.chunkText);
  const lineStart =
    characterIndex < 0
      ? 1
      : body.slice(0, characterIndex).split(/\r?\n/).length;
  const lineEnd = lineStart + hit.chunkText.split(/\r?\n/).length - 1;
  return {
    noteId: hit.noteId,
    title,
    heading: `Semantic chunk ${hit.chunkIndex + 1}`,
    lineStart,
    lineEnd,
    text: hit.chunkText,
    score: hit.score,
  };
}
