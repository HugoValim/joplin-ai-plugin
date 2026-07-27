import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "../shared/errors";
import type {
  CreateNoteInput,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NotebookRecord,
  UpdateNoteBodyInput,
} from "./retriever";

export interface JoplinDataPort {
  get(path: string[], query?: Record<string, unknown>): Promise<unknown>;
  post(
    path: string[],
    query?: Record<string, unknown> | null,
    body?: Record<string, unknown>,
  ): Promise<unknown>;
  put(
    path: string[],
    query?: Record<string, unknown> | null,
    body?: Record<string, unknown>,
  ): Promise<unknown>;
}

const NoteSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    parent_id: Type.String({ maxLength: 128 }),
    title: Type.String({ maxLength: 100_000 }),
    body: Type.String({ maxLength: 10_000_000 }),
    updated_time: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);
const SearchHitSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ maxLength: 100_000 }),
    updated_time: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);
const NotebookSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ maxLength: 100_000 }),
    parent_id: Type.String({ maxLength: 128 }),
  },
  { additionalProperties: true },
);
const SearchPageSchema = Type.Object(
  {
    items: Type.Array(SearchHitSchema),
    has_more: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
const NotebookPageSchema = Type.Object(
  {
    items: Type.Array(NotebookSchema),
    has_more: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

export class JoplinNoteRepository implements NoteRepository {
  public constructor(private readonly dataPort: JoplinDataPort) {}

  /**
   * Searches note metadata through Joplin's bounded search endpoint.
   *
   * @example await repository.searchNotes('deployment', 20)
   */
  public async searchNotes(
    query: string,
    limit: number,
  ): Promise<readonly NoteSearchHit[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const input = await this.dataPort.get(["search"], {
      query,
      type: "note",
      fields: ["id", "title", "updated_time"],
      limit: boundedLimit,
    });
    const page = parseExternal(SearchPageSchema, input, "a Joplin search page");
    return page.items.map(toSearchHit);
  }

  /**
   * Reads a note using an opaque Joplin ID.
   *
   * @example await repository.readNote('8f1c...')
   */
  public async readNote(noteId: string): Promise<NoteRecord> {
    assertIdentifier(noteId, "note ID");
    const input = await this.dataPort.get(["notes", noteId], {
      fields: ["id", "parent_id", "title", "body", "updated_time"],
    });
    return toNote(parseExternal(NoteSchema, input, "a Joplin note"));
  }

  /**
   * Lists notebooks without exposing internal storage paths.
   *
   * @example await repository.listNotebooks()
   */
  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    const input = await this.dataPort.get(["folders"], {
      fields: ["id", "title", "parent_id"],
      limit: 100,
    });
    const page = parseExternal(
      NotebookPageSchema,
      input,
      "a Joplin folder page",
    );
    return page.items.map((folder) => ({
      id: folder.id,
      title: folder.title,
      parentId: folder.parent_id,
    }));
  }

  /**
   * Creates one Markdown note in a selected notebook.
   *
   * @example await repository.createNote({ parentId, title, body })
   */
  public async createNote(input: CreateNoteInput): Promise<NoteRecord> {
    assertIdentifier(input.parentId, "parent notebook ID");
    const created = await this.dataPort.post(["notes"], null, {
      parent_id: input.parentId,
      title: input.title,
      body: input.body,
    });
    return toNote(parseExternal(NoteSchema, created, "a created Joplin note"));
  }

  /**
   * Updates a note only when its `updated_time` still matches the proposal.
   *
   * @example await repository.updateNoteBody({ noteId, body, expectedUpdatedTime })
   */
  public async updateNoteBody(input: UpdateNoteBodyInput): Promise<NoteRecord> {
    const current = await this.readNote(input.noteId);
    if (current.updatedTime !== input.expectedUpdatedTime) {
      throw new DomainError(
        "CONFLICT",
        `Note ${input.noteId} has updated_time ${current.updatedTime}; expected updated_time ${input.expectedUpdatedTime}`,
      );
    }
    await this.dataPort.put(["notes", input.noteId], null, {
      body: input.body,
    });
    return this.readNote(input.noteId);
  }
}

function toSearchHit(input: Static<typeof SearchHitSchema>): NoteSearchHit {
  return { id: input.id, title: input.title, updatedTime: input.updated_time };
}

function toNote(input: Static<typeof NoteSchema>): NoteRecord {
  return {
    ...toSearchHit(input),
    parentId: input.parent_id,
    body: input.body,
  };
}

function parseExternal<T extends TSchema>(
  schema: T,
  input: unknown,
  expected: string,
): Static<T> {
  if (Value.Check(schema, input)) return input;
  throw new DomainError(
    "VALIDATION",
    `Invalid Joplin response ${safeValue(input)}; expected ${expected}`,
  );
}

function assertIdentifier(value: string, label: string): void {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(value)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid ${label} ${safeValue(value)}; expected 1..128 letters, numbers, underscores, or hyphens`,
  );
}
