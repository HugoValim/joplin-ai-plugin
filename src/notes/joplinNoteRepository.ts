import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "../shared/errors";
import type {
  CreateNotebookInput,
  CreateNoteInput,
  NoteMetadataRecord,
  NoteOrganizationRepository,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NotebookMetadataRecord,
  NotebookRecord,
  RestoreNotebookInput,
  RestoreNoteInput,
  TrashListing,
  TrashNotebookInput,
  TrashNoteInput,
  TrashedNotebookRecord,
  TrashedNoteRecord,
  UpdateNoteBodyInput,
  UpdateNoteMetadataInput,
  UpdateNotebookMetadataInput,
} from "./retriever";
import { JoplinTrashOperations } from "./joplinTrashOperations";
import {
  noteMetadataUpdateBody,
  notebookMetadataUpdateBody,
} from "./joplinMetadataUpdates";

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
  delete(path: string[], query?: Record<string, unknown>): Promise<unknown>;
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
const NoteMetadataSchema = Type.Object(
  {
    ...SearchHitSchema.properties,
    parent_id: Type.String({ maxLength: 128 }),
    order: Type.Number(),
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
const NotebookMetadataSchema = Type.Object(
  {
    ...NotebookSchema.properties,
    updated_time: Type.Number({ minimum: 0 }),
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
const NoteMetadataPageSchema = Type.Object(
  {
    items: Type.Array(NoteMetadataSchema),
    has_more: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

export class JoplinNoteRepository
  implements NoteRepository, NoteOrganizationRepository
{
  private readonly trash: JoplinTrashOperations;

  public constructor(private readonly dataPort: JoplinDataPort) {
    this.trash = new JoplinTrashOperations(dataPort);
  }

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
   * Reads versioned note metadata used by organization proposals.
   *
   * @example await repository.readNoteMetadata('8f1c...')
   */
  public async readNoteMetadata(noteId: string): Promise<NoteMetadataRecord> {
    assertIdentifier(noteId, "note ID");
    const input = await this.dataPort.get(["notes", noteId], {
      fields: ["id", "parent_id", "title", "updated_time", "order"],
    });
    const note = parseExternal(
      NoteMetadataSchema,
      input,
      "Joplin note organization metadata",
    );
    return toNoteMetadata(note);
  }

  /**
   * Lists bounded note metadata in one notebook using manual sort order.
   *
   * @example await repository.listNotebookNotes('folder-id', 25)
   */
  public async listNotebookNotes(
    notebookId: string,
    limit: number,
  ): Promise<readonly NoteMetadataRecord[]> {
    assertIdentifier(notebookId, "notebook ID");
    const input = await this.dataPort.get(
      ["folders", notebookId, "notes"],
      noteListQuery(limit),
    );
    const page = parseExternal(
      NoteMetadataPageSchema,
      input,
      "a Joplin notebook note page",
    );
    return page.items.map(toNoteMetadata);
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
   * Reads versioned notebook metadata for safe organization proposals.
   *
   * @example await repository.readNotebook('folder-id')
   */
  public async readNotebook(
    notebookId: string,
  ): Promise<NotebookMetadataRecord> {
    assertIdentifier(notebookId, "notebook ID");
    const input = await this.dataPort.get(["folders", notebookId], {
      fields: ["id", "title", "parent_id", "updated_time"],
    });
    const notebook = parseExternal(
      NotebookMetadataSchema,
      input,
      "Joplin notebook metadata",
    );
    return {
      id: notebook.id,
      title: notebook.title,
      parentId: notebook.parent_id,
      updatedTime: notebook.updated_time,
    };
  }

  /**
   * Creates one root or nested Joplin notebook.
   *
   * @example await repository.createNotebook({ parentId: '', title: 'Projects' })
   */
  public async createNotebook(
    input: CreateNotebookInput,
  ): Promise<NotebookMetadataRecord> {
    assertOptionalIdentifier(input.parentId, "parent notebook ID");
    assertTitle(input.title, "notebook title");
    const created = await this.dataPort.post(["folders"], null, {
      parent_id: input.parentId,
      title: input.title,
    });
    return parseNotebookMetadata(created, "a created Joplin notebook");
  }

  /**
   * Updates note title, notebook, or manual order after a version check.
   *
   * @example await repository.updateNoteMetadata({ noteId, expectedUpdatedTime, title })
   */
  public async updateNoteMetadata(
    input: UpdateNoteMetadataInput,
  ): Promise<NoteMetadataRecord> {
    const current = await this.readNoteMetadata(input.noteId);
    assertVersion(input.noteId, current.updatedTime, input.expectedUpdatedTime);
    await this.dataPort.put(
      ["notes", input.noteId],
      null,
      noteMetadataUpdateBody(input),
    );
    return this.readNoteMetadata(input.noteId);
  }

  /**
   * Updates notebook title or parent after a version check.
   *
   * @example await repository.updateNotebookMetadata({ notebookId, expectedUpdatedTime, title })
   */
  public async updateNotebookMetadata(
    input: UpdateNotebookMetadataInput,
  ): Promise<NotebookMetadataRecord> {
    const current = await this.readNotebook(input.notebookId);
    assertVersion(
      input.notebookId,
      current.updatedTime,
      input.expectedUpdatedTime,
    );
    await this.dataPort.put(
      ["folders", input.notebookId],
      null,
      notebookMetadataUpdateBody(input),
    );
    return this.readNotebook(input.notebookId);
  }

  /** Soft-deletes a note into Joplin Trash after a version check. */
  public async trashNote(input: TrashNoteInput): Promise<void> {
    const current = await this.readNoteMetadata(input.noteId);
    await this.trash.trashNote(input, current.updatedTime);
  }

  /** Soft-deletes a notebook and its contents into Joplin Trash. */
  public async trashNotebook(input: TrashNotebookInput): Promise<void> {
    const current = await this.readNotebook(input.notebookId);
    await this.trash.trashNotebook(input, current.updatedTime);
  }

  /** Lists soft-deleted notes and notebooks from Joplin Trash. */
  public listTrash(limit: number): Promise<TrashListing> {
    return this.trash.listTrash(limit);
  }

  /** Reads one trashed note; rejects items not in Trash. */
  public readTrashedNote(noteId: string): Promise<TrashedNoteRecord> {
    return this.trash.readTrashedNote(noteId);
  }

  /** Reads one trashed notebook; rejects items not in Trash. */
  public readTrashedNotebook(
    notebookId: string,
  ): Promise<TrashedNotebookRecord> {
    return this.trash.readTrashedNotebook(notebookId);
  }

  /** Restores a soft-deleted note from Joplin Trash. */
  public restoreNote(input: RestoreNoteInput): Promise<void> {
    return this.trash.restoreNote(input);
  }

  /** Restores a soft-deleted notebook and its trashed contents. */
  public restoreNotebook(input: RestoreNotebookInput): Promise<void> {
    return this.trash.restoreNotebook(input);
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

function toNoteMetadata(
  input: Static<typeof NoteMetadataSchema>,
): NoteMetadataRecord {
  return {
    id: input.id,
    parentId: input.parent_id,
    title: input.title,
    updatedTime: input.updated_time,
    order: input.order,
  };
}

function noteListQuery(limit: number): Record<string, unknown> {
  return {
    fields: ["id", "parent_id", "title", "updated_time", "order"],
    limit: Math.min(Math.max(limit, 1), 100),
    order_by: "order",
    order_dir: "ASC",
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

function parseNotebookMetadata(
  input: unknown,
  expected: string,
): NotebookMetadataRecord {
  const notebook = parseExternal(NotebookMetadataSchema, input, expected);
  return {
    id: notebook.id,
    title: notebook.title,
    parentId: notebook.parent_id,
    updatedTime: notebook.updated_time,
  };
}

function assertIdentifier(value: string, label: string): void {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(value)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid ${label} ${safeValue(value)}; expected 1..128 letters, numbers, underscores, or hyphens`,
  );
}

function assertOptionalIdentifier(value: string, label: string): void {
  if (!value) return;
  assertIdentifier(value, label);
}

function assertTitle(value: string, label: string): void {
  if (value.trim() && value.length <= 500) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid ${label} ${safeValue(value)}; expected 1..500 characters with non-whitespace text`,
  );
}

function assertVersion(itemId: string, actual: number, expected: number): void {
  if (actual === expected) return;
  throw new DomainError(
    "CONFLICT",
    `Item ${itemId} has updated_time ${actual}; expected updated_time ${expected}`,
  );
}
