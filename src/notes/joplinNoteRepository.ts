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
  TrashNotebookInput,
  TrashNoteInput,
  UpdateNoteBodyInput,
  UpdateNoteMetadataInput,
  UpdateNotebookMetadataInput,
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

  /**
   * Moves a note to Joplin Trash after a version check.
   *
   * @example await repository.trashNote({ noteId, expectedUpdatedTime })
   */
  public async trashNote(input: TrashNoteInput): Promise<void> {
    const current = await this.readNoteMetadata(input.noteId);
    assertVersion(input.noteId, current.updatedTime, input.expectedUpdatedTime);
    await this.dataPort.delete(["notes", input.noteId]);
  }

  /**
   * Moves a notebook and its contents to Joplin Trash after a version check.
   *
   * @example await repository.trashNotebook({ notebookId, expectedUpdatedTime })
   */
  public async trashNotebook(input: TrashNotebookInput): Promise<void> {
    const current = await this.readNotebook(input.notebookId);
    assertVersion(
      input.notebookId,
      current.updatedTime,
      input.expectedUpdatedTime,
    );
    await this.dataPort.delete(["folders", input.notebookId]);
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

function noteMetadataUpdateBody(
  input: UpdateNoteMetadataInput,
): Record<string, unknown> {
  validateNoteMetadataUpdate(input);
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
  };
}

function validateNoteMetadataUpdate(input: UpdateNoteMetadataInput): void {
  if (input.title !== undefined) assertTitle(input.title, "note title");
  if (input.parentId !== undefined)
    assertIdentifier(input.parentId, "parent notebook ID");
  if (input.order !== undefined) assertFiniteOrder(input.order);
  if (
    input.title !== undefined ||
    input.parentId !== undefined ||
    input.order !== undefined
  )
    return;
  throw new DomainError(
    "VALIDATION",
    `Invalid note metadata update ${safeValue(input)}; expected title, parentId, or order`,
  );
}

function assertFiniteOrder(order: number): void {
  if (Number.isFinite(order)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid note order ${safeValue(order)}; expected a finite number`,
  );
}

function notebookMetadataUpdateBody(
  input: UpdateNotebookMetadataInput,
): Record<string, unknown> {
  validateNotebookMetadataUpdate(input);
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
  };
}

function validateNotebookMetadataUpdate(
  input: UpdateNotebookMetadataInput,
): void {
  if (input.title !== undefined) assertTitle(input.title, "notebook title");
  if (input.parentId !== undefined) validateNotebookParent(input);
  if (input.title !== undefined || input.parentId !== undefined) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid notebook metadata update ${safeValue(input)}; expected title or parentId`,
  );
}

function validateNotebookParent(input: UpdateNotebookMetadataInput): void {
  if (input.parentId === undefined) return;
  assertOptionalIdentifier(input.parentId, "parent notebook ID");
  if (input.parentId !== input.notebookId) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid parent notebook ID ${safeValue(input.parentId)}; expected a different notebook ID or root`,
  );
}
