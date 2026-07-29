import { Type } from "@sinclair/typebox";
import type { NoteOrganizationRepository } from "../notes/retriever";
import type { ChangeSetStore } from "../persistence/changeSetStore";
import type { ToolExecutionContext, ToolRegistry } from "./toolRegistry";
import {
  assertNoteOrgAllowed,
  assertNotebookAllowed,
  filterAllowedNotebooks,
  filterAllowedNotes,
} from "./noteAccessPolicy";
import {
  OrganizationIdentifierSchema,
  OrganizationProposalOutputSchema,
  OrganizationTool,
  organizationNoteSummary,
  organizationNotebookSummary,
  readVersionedTrashedNote,
  readVersionedTrashedNotebook,
  type OrganizationProposalOutput,
} from "./organizationTool";

interface ListTrashInput {
  readonly limit?: number;
}

interface ListTrashOutput {
  readonly notes: readonly {
    readonly id: string;
    readonly title: string;
    readonly parent_id: string;
    readonly updated_time: number;
    readonly deleted_time: number;
  }[];
  readonly notebooks: readonly {
    readonly id: string;
    readonly title: string;
    readonly parent_id: string;
    readonly updated_time: number;
    readonly deleted_time: number;
  }[];
}

class ListTrashTool extends OrganizationTool<ListTrashInput, ListTrashOutput> {
  public readonly name = "list_trash";
  public readonly description =
    "List soft-deleted notes and notebooks in Joplin Trash with IDs and versions for restore.";
  public readonly risk = "read" as const;
  public readonly inputSchema = Type.Object(
    {
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object(
    {
      notes: Type.Array(
        Type.Object(
          {
            id: OrganizationIdentifierSchema,
            title: Type.String(),
            parent_id: Type.String({ maxLength: 128 }),
            updated_time: Type.Number(),
            deleted_time: Type.Number(),
          },
          { additionalProperties: false },
        ),
      ),
      notebooks: Type.Array(
        Type.Object(
          {
            id: OrganizationIdentifierSchema,
            title: Type.String(),
            parent_id: Type.String({ maxLength: 128 }),
            updated_time: Type.Number(),
            deleted_time: Type.Number(),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  );

  public constructor(private readonly repository: NoteOrganizationRepository) {
    super();
  }

  public async execute(
    input: ListTrashInput,
    context: ToolExecutionContext,
  ): Promise<ListTrashOutput> {
    const listing = await this.repository.listTrash(input.limit ?? 25);
    const notes = filterAllowedNotes(context, listing.notes);
    const notebooks = filterAllowedNotebooks(context, listing.notebooks);
    return {
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        parent_id: note.parentId,
        updated_time: note.updatedTime,
        deleted_time: note.deletedTime,
      })),
      notebooks: notebooks.map((notebook) => ({
        id: notebook.id,
        title: notebook.title,
        parent_id: notebook.parentId,
        updated_time: notebook.updatedTime,
        deleted_time: notebook.deletedTime,
      })),
    };
  }
}

interface RestoreNoteToolInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
  readonly parent_id?: string;
}

class RestoreNoteTool extends OrganizationTool<
  RestoreNoteToolInput,
  OrganizationProposalOutput
> {
  public readonly name = "restore_note";
  public readonly description =
    "Propose restoring a trashed note to its previous parent or a chosen notebook; manual approval is required.";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: OrganizationIdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
      parent_id: Type.Optional(Type.String({ maxLength: 128 })),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = OrganizationProposalOutputSchema;

  public constructor(
    private readonly repository: NoteOrganizationRepository,
    private readonly changes: ChangeSetStore,
  ) {
    super();
  }

  public async execute(
    input: RestoreNoteToolInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    const note = await readVersionedTrashedNote(this.repository, input);
    const parentId =
      input.parent_id !== undefined ? input.parent_id : note.parentId;
    assertNoteOrgAllowed(context, parentId);
    if (input.parent_id) assertNotebookAllowed(context, input.parent_id);
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "note",
      operation: "restore",
      noteId: note.id,
      expectedUpdatedTime: note.updatedTime,
      ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
      targetLabel: note.title,
      before: "In Joplin Trash (soft-deleted).",
      after: organizationNoteSummary(note.title, parentId, note.order),
    });
    return { change_id: change.id };
  }
}

interface RestoreNotebookToolInput {
  readonly notebook_id: string;
  readonly expected_updated_time: number;
  readonly parent_id?: string;
}

class RestoreNotebookTool extends OrganizationTool<
  RestoreNotebookToolInput,
  OrganizationProposalOutput
> {
  public readonly name = "restore_notebook";
  public readonly description =
    "Propose restoring a trashed notebook and its contents; manual approval is required.";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      notebook_id: OrganizationIdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
      parent_id: Type.Optional(Type.String({ maxLength: 128 })),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = OrganizationProposalOutputSchema;

  public constructor(
    private readonly repository: NoteOrganizationRepository,
    private readonly changes: ChangeSetStore,
  ) {
    super();
  }

  public async execute(
    input: RestoreNotebookToolInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    assertNotebookAllowed(context, input.notebook_id);
    if (input.parent_id) assertNotebookAllowed(context, input.parent_id);
    const notebook = await readVersionedTrashedNotebook(this.repository, input);
    const destination =
      input.parent_id !== undefined ? input.parent_id : notebook.parentId;
    if (destination) assertNotebookAllowed(context, destination);
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "notebook",
      operation: "restore",
      notebookId: notebook.id,
      expectedUpdatedTime: notebook.updatedTime,
      ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
      targetLabel: notebook.title,
      before: "In Joplin Trash with contained items (soft-deleted).",
      after: organizationNotebookSummary(notebook.title, destination),
    });
    return { change_id: change.id };
  }
}

/**
 * Registers Trash listing and restore proposal tools.
 *
 * @example registerTrashOrganizationTools(registry, repository, changes)
 */
export function registerTrashOrganizationTools(
  registry: ToolRegistry,
  repository: NoteOrganizationRepository,
  changes: ChangeSetStore,
): void {
  registry.register(new ListTrashTool(repository));
  registry.register(new RestoreNoteTool(repository, changes));
  registry.register(new RestoreNotebookTool(repository, changes));
}
