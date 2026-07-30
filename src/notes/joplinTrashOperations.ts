import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "../shared/errors";
import type { JoplinDataPort } from "./joplinNoteRepository";
import type {
  RestoreNotebookInput,
  RestoreNoteInput,
  TrashListing,
  TrashNotebookInput,
  TrashNoteInput,
  TrashedNotebookRecord,
  TrashedNoteRecord,
} from "./retriever";

const TrashedNoteSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    parent_id: Type.String({ maxLength: 128 }),
    title: Type.String({ maxLength: 100_000 }),
    updated_time: Type.Number({ minimum: 0 }),
    order: Type.Number(),
    deleted_time: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);
const TrashedNotebookSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ maxLength: 100_000 }),
    parent_id: Type.String({ maxLength: 128 }),
    updated_time: Type.Number({ minimum: 0 }),
    deleted_time: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);
const TrashedNotePageSchema = Type.Object(
  {
    items: Type.Array(TrashedNoteSchema),
    has_more: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
const TrashedNotebookPageSchema = Type.Object(
  {
    items: Type.Array(TrashedNotebookSchema),
    has_more: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

/**
 * Soft-delete listing and restore operations against Joplin Trash.
 */
export class JoplinTrashOperations {
  public constructor(private readonly dataPort: JoplinDataPort) {}

  /**
   * Moves a note to Joplin Trash after a version check.
   *
   * @example await trash.trashNote(input, currentUpdatedTime)
   */
  public async trashNote(
    input: TrashNoteInput,
    currentUpdatedTime: number,
  ): Promise<void> {
    assertVersion(input.noteId, currentUpdatedTime, input.expectedUpdatedTime);
    await this.dataPort.delete(["notes", input.noteId]);
  }

  /**
   * Moves a notebook and its contents to Joplin Trash after a version check.
   *
   * @example await trash.trashNotebook(input, currentUpdatedTime)
   */
  public async trashNotebook(
    input: TrashNotebookInput,
    currentUpdatedTime: number,
  ): Promise<void> {
    assertVersion(
      input.notebookId,
      currentUpdatedTime,
      input.expectedUpdatedTime,
    );
    await this.dataPort.delete(["folders", input.notebookId]);
  }

  /**
   * Lists soft-deleted notes and notebooks from Joplin Trash.
   *
   * @example await trash.listTrash(25)
   */
  public async listTrash(limit: number): Promise<TrashListing> {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const [notesPage, notebooksPage] = await Promise.all([
      this.dataPort.get(["notes"], trashNoteListQuery(boundedLimit)),
      this.dataPort.get(["folders"], trashNotebookListQuery(boundedLimit)),
    ]);
    const notes = parseExternal(
      TrashedNotePageSchema,
      notesPage,
      "a Joplin trashed note page",
    );
    const notebooks = parseExternal(
      TrashedNotebookPageSchema,
      notebooksPage,
      "a Joplin trashed notebook page",
    );
    return {
      notes: notes.items
        .filter((note) => note.deleted_time > 0)
        .map(toTrashedNote)
        .slice(0, boundedLimit),
      notebooks: notebooks.items
        .filter((notebook) => notebook.deleted_time > 0)
        .map(toTrashedNotebook)
        .slice(0, boundedLimit),
    };
  }

  /**
   * Reads one trashed note and rejects items not in Joplin Trash.
   *
   * @example await trash.readTrashedNote('8f1c...')
   */
  public async readTrashedNote(noteId: string): Promise<TrashedNoteRecord> {
    assertIdentifier(noteId, "note ID");
    const input = await this.dataPort.get(["notes", noteId], {
      fields: [
        "id",
        "parent_id",
        "title",
        "updated_time",
        "order",
        "deleted_time",
      ],
    });
    const note = parseExternal(
      TrashedNoteSchema,
      input,
      "Joplin trashed note metadata",
    );
    assertTrashed(noteId, note.deleted_time);
    return toTrashedNote(note);
  }

  /**
   * Reads one trashed notebook and rejects items not in Joplin Trash.
   *
   * @example await trash.readTrashedNotebook('folder-id')
   */
  public async readTrashedNotebook(
    notebookId: string,
  ): Promise<TrashedNotebookRecord> {
    assertIdentifier(notebookId, "notebook ID");
    const input = await this.dataPort.get(["folders", notebookId], {
      fields: ["id", "title", "parent_id", "updated_time", "deleted_time"],
    });
    const notebook = parseExternal(
      TrashedNotebookSchema,
      input,
      "Joplin trashed notebook metadata",
    );
    assertTrashed(notebookId, notebook.deleted_time);
    return toTrashedNotebook(notebook);
  }

  /**
   * Restores a soft-deleted note from Joplin Trash after a version check.
   *
   * @example await trash.restoreNote({ noteId, expectedUpdatedTime })
   */
  public async restoreNote(input: RestoreNoteInput): Promise<void> {
    const current = await this.readTrashedNote(input.noteId);
    assertVersion(input.noteId, current.updatedTime, input.expectedUpdatedTime);
    if (input.parentId !== undefined) {
      assertOptionalIdentifier(input.parentId, "parent notebook ID");
    }
    const parentId =
      input.parentId !== undefined
        ? input.parentId
        : await this.resolveRestoreParentId(current.parentId);
    await this.dataPort.put(["notes", input.noteId], null, {
      deleted_time: 0,
      ...(parentId !== current.parentId ? { parent_id: parentId } : {}),
    });
  }

  /**
   * Restores a soft-deleted notebook and its trashed contents after a version check.
   *
   * @example await trash.restoreNotebook({ notebookId, expectedUpdatedTime })
   */
  public async restoreNotebook(input: RestoreNotebookInput): Promise<void> {
    const current = await this.readTrashedNotebook(input.notebookId);
    assertVersion(
      input.notebookId,
      current.updatedTime,
      input.expectedUpdatedTime,
    );
    if (input.parentId !== undefined) {
      assertOptionalIdentifier(input.parentId, "parent notebook ID");
      if (input.parentId === input.notebookId) {
        throw new DomainError(
          "VALIDATION",
          `Invalid parent notebook ID ${safeValue(input.parentId)}; expected a different notebook ID or root`,
        );
      }
    }
    const parentId =
      input.parentId !== undefined
        ? input.parentId
        : await this.resolveRestoreParentId(current.parentId);
    await this.dataPort.put(["folders", input.notebookId], null, {
      deleted_time: 0,
      ...(parentId !== current.parentId ? { parent_id: parentId } : {}),
    });
    await this.restoreTrashedNotebookChildren(input.notebookId);
  }

  private async resolveRestoreParentId(parentId: string): Promise<string> {
    if (!parentId) return "";
    try {
      const parent = await this.readNotebookDeletedTime(parentId);
      return parent.deletedTime > 0 ? "" : parentId;
    } catch {
      return "";
    }
  }

  private async readNotebookDeletedTime(
    notebookId: string,
  ): Promise<{ readonly deletedTime: number }> {
    const input = await this.dataPort.get(["folders", notebookId], {
      fields: ["id", "title", "parent_id", "updated_time", "deleted_time"],
    });
    const notebook = parseExternal(
      TrashedNotebookSchema,
      input,
      "Joplin notebook deleted_time metadata",
    );
    return { deletedTime: notebook.deleted_time };
  }

  private async restoreTrashedNotebookChildren(
    notebookId: string,
  ): Promise<void> {
    const [foldersPage, notesPage] = await Promise.all([
      this.dataPort.get(["folders"], trashNotebookListQuery(100)),
      this.dataPort.get(["folders", notebookId, "notes"], {
        ...trashNoteListQuery(100),
        include_deleted: 1,
      }),
    ]);
    const folders = parseExternal(
      TrashedNotebookPageSchema,
      foldersPage,
      "a Joplin trashed notebook page",
    );
    const notes = parseExternal(
      TrashedNotePageSchema,
      notesPage,
      "a Joplin trashed notebook note page",
    );
    for (const folder of folders.items) {
      if (folder.parent_id !== notebookId || folder.deleted_time <= 0) continue;
      await this.restoreNotebook({
        notebookId: folder.id,
        expectedUpdatedTime: folder.updated_time,
      });
    }
    for (const note of notes.items) {
      if (note.deleted_time <= 0) continue;
      await this.restoreNote({
        noteId: note.id,
        expectedUpdatedTime: note.updated_time,
      });
    }
  }
}

function toTrashedNote(
  input: Static<typeof TrashedNoteSchema>,
): TrashedNoteRecord {
  return {
    id: input.id,
    parentId: input.parent_id,
    title: input.title,
    updatedTime: input.updated_time,
    order: input.order,
    deletedTime: input.deleted_time,
  };
}

function toTrashedNotebook(
  input: Static<typeof TrashedNotebookSchema>,
): TrashedNotebookRecord {
  return {
    id: input.id,
    title: input.title,
    parentId: input.parent_id,
    updatedTime: input.updated_time,
    deletedTime: input.deleted_time,
  };
}

function trashNoteListQuery(limit: number): Record<string, unknown> {
  return {
    fields: [
      "id",
      "parent_id",
      "title",
      "updated_time",
      "order",
      "deleted_time",
    ],
    limit,
    include_deleted: 1,
  };
}

function trashNotebookListQuery(limit: number): Record<string, unknown> {
  return {
    fields: ["id", "title", "parent_id", "updated_time", "deleted_time"],
    limit,
    include_deleted: 1,
  };
}

function assertTrashed(itemId: string, deletedTime: number): void {
  if (deletedTime > 0) return;
  throw new DomainError(
    "VALIDATION",
    `Item ${itemId} has deleted_time ${deletedTime}; expected a trashed Joplin item with deleted_time > 0`,
  );
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

function assertOptionalIdentifier(value: string, label: string): void {
  if (!value) return;
  assertIdentifier(value, label);
}

function assertVersion(itemId: string, actual: number, expected: number): void {
  if (actual === expected) return;
  throw new DomainError(
    "CONFLICT",
    `Item ${itemId} has updated_time ${actual}; expected updated_time ${expected}`,
  );
}
