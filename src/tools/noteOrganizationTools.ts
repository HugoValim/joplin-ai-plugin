import { Type } from "@sinclair/typebox";
import type { NoteOrganizationRepository } from "../notes/retriever";
import type { ChangeSetStore } from "../persistence/changeSetStore";
import type { ToolExecutionContext, ToolRegistry } from "./toolRegistry";
import {
  assertNoteOrgAllowed,
  assertNotebookAllowed,
  vaultOrgToolsEnabled,
} from "./noteAccessPolicy";
import {
  OrganizationIdentifierSchema,
  OrganizationProposalOutputSchema,
  OrganizationTool,
  organizationNotebookSummary,
  organizationNoteSummary,
  readVersionedNoteMetadata,
  type OrganizationProposalOutput,
} from "./organizationTool";
import { registerNotebookOrganizationTools } from "./notebookOrganizationTools";
import { registerTrashOrganizationTools } from "./trashOrganizationTools";

interface ReadNotebookInput {
  readonly notebook_id: string;
}

interface ReadNotebookOutput {
  readonly id: string;
  readonly parent_id: string;
  readonly title: string;
  readonly updated_time: number;
}

class ReadNotebookTool extends OrganizationTool<
  ReadNotebookInput,
  ReadNotebookOutput
> {
  public readonly name = "read_notebook";
  public readonly description =
    "Read one Joplin notebook with its version and parent.";
  public readonly risk = "read" as const;
  public readonly inputSchema = Type.Object(
    { notebook_id: OrganizationIdentifierSchema },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object(
    {
      id: OrganizationIdentifierSchema,
      parent_id: Type.String({ maxLength: 128 }),
      title: Type.String(),
      updated_time: Type.Number(),
    },
    { additionalProperties: false },
  );

  public constructor(private readonly repository: NoteOrganizationRepository) {
    super();
  }

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public async execute(
    input: ReadNotebookInput,
    context: ToolExecutionContext,
  ): Promise<ReadNotebookOutput> {
    assertNotebookAllowed(context, input.notebook_id);
    const notebook = await this.repository.readNotebook(input.notebook_id);
    return {
      id: notebook.id,
      parent_id: notebook.parentId,
      title: notebook.title,
      updated_time: notebook.updatedTime,
    };
  }
}

interface ListNotebookNotesInput {
  readonly notebook_id: string;
  readonly limit?: number;
}

interface ListNotebookNotesOutput {
  readonly notes: readonly {
    readonly id: string;
    readonly title: string;
    readonly updated_time: number;
    readonly order: number;
  }[];
}

class ListNotebookNotesTool extends OrganizationTool<
  ListNotebookNotesInput,
  ListNotebookNotesOutput
> {
  public readonly name = "list_notebook_notes";
  public readonly description =
    "List notes in one notebook with versions and manual sort order.";
  public readonly risk = "read" as const;
  public readonly inputSchema = Type.Object(
    {
      notebook_id: OrganizationIdentifierSchema,
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
            updated_time: Type.Number(),
            order: Type.Number(),
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

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public async execute(
    input: ListNotebookNotesInput,
    context: ToolExecutionContext,
  ): Promise<ListNotebookNotesOutput> {
    assertNotebookAllowed(context, input.notebook_id);
    const notes = await this.repository.listNotebookNotes(
      input.notebook_id,
      input.limit ?? 100,
    );
    return {
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        updated_time: note.updatedTime,
        order: note.order,
      })),
    };
  }
}

interface CreateNotebookInput {
  readonly title: string;
  readonly parent_id?: string;
}

class CreateNotebookTool extends OrganizationTool<
  CreateNotebookInput,
  OrganizationProposalOutput
> {
  public readonly name = "create_notebook";
  public readonly description =
    "Propose creating a root or nested Joplin notebook for approval.";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 500 }),
      parent_id: Type.Optional(OrganizationIdentifierSchema),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = OrganizationProposalOutputSchema;

  public constructor(private readonly changes: ChangeSetStore) {
    super();
  }

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public execute(
    input: CreateNotebookInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    const parentId = input.parent_id ?? "";
    if (parentId) assertNotebookAllowed(context, parentId);
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "notebook",
      operation: "create",
      parentId,
      title: input.title,
      targetLabel: input.title,
      before: "Notebook does not exist.",
      after: organizationNotebookSummary(input.title, parentId),
    });
    return Promise.resolve({ change_id: change.id });
  }
}

interface RenameNoteInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
  readonly title: string;
}

class RenameNoteTool extends OrganizationTool<
  RenameNoteInput,
  OrganizationProposalOutput
> {
  public readonly name = "rename_note";
  public readonly description =
    "Propose renaming a versioned Joplin note for approval.";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: OrganizationIdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
      title: Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" }),
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

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public async execute(
    input: RenameNoteInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    const note = await readVersionedNoteMetadata(this.repository, input);
    assertNoteOrgAllowed(context, note.parentId);
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "note",
      operation: "rename",
      noteId: note.id,
      expectedUpdatedTime: note.updatedTime,
      title: input.title,
      targetLabel: note.title,
      before: organizationNoteSummary(note.title, note.parentId, note.order),
      after: organizationNoteSummary(input.title, note.parentId, note.order),
    });
    return { change_id: change.id };
  }
}

interface MoveNoteInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
  readonly parent_id: string;
}

class MoveNoteTool extends OrganizationTool<
  MoveNoteInput,
  OrganizationProposalOutput
> {
  public readonly name = "move_note";
  public readonly description =
    "Propose moving a versioned Joplin note into another notebook. parent_id must be a notebook ID from list_notebooks; notes cannot live at the vault root (use move_notebook for notebooks).";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: OrganizationIdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
      parent_id: OrganizationIdentifierSchema,
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

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public async execute(
    input: MoveNoteInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    assertNotebookAllowed(context, input.parent_id);
    const note = await readVersionedNoteMetadata(this.repository, input);
    assertNoteOrgAllowed(context, note.parentId);
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "note",
      operation: "move",
      noteId: note.id,
      expectedUpdatedTime: note.updatedTime,
      parentId: input.parent_id,
      targetLabel: note.title,
      before: organizationNoteSummary(note.title, note.parentId, note.order),
      after: organizationNoteSummary(note.title, input.parent_id, note.order),
    });
    return { change_id: change.id };
  }
}

interface ReorderNoteInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
  readonly order: number;
}

class ReorderNoteTool extends OrganizationTool<
  ReorderNoteInput,
  OrganizationProposalOutput
> {
  public readonly name = "reorder_note";
  public readonly description =
    "Propose setting a note's manual order, visible with Joplin Custom sorting.";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: OrganizationIdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
      order: Type.Number(),
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

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public async execute(
    input: ReorderNoteInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    const note = await readVersionedNoteMetadata(this.repository, input);
    assertNoteOrgAllowed(context, note.parentId);
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "note",
      operation: "reorder",
      noteId: note.id,
      expectedUpdatedTime: note.updatedTime,
      order: input.order,
      targetLabel: note.title,
      before: organizationNoteSummary(note.title, note.parentId, note.order),
      after: organizationNoteSummary(note.title, note.parentId, input.order),
    });
    return { change_id: change.id };
  }
}

interface DeleteNoteInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
}

class DeleteNoteTool extends OrganizationTool<
  DeleteNoteInput,
  OrganizationProposalOutput
> {
  public readonly name = "delete_note";
  public readonly description =
    "Propose moving a versioned note to Joplin Trash; manual approval is required.";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: OrganizationIdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
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

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public async execute(
    input: DeleteNoteInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    const note = await readVersionedNoteMetadata(this.repository, input);
    assertNoteOrgAllowed(context, note.parentId);
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "note",
      operation: "delete",
      noteId: note.id,
      expectedUpdatedTime: note.updatedTime,
      targetLabel: note.title,
      before: organizationNoteSummary(note.title, note.parentId, note.order),
      after: "Moved to Joplin Trash (recoverable).",
    });
    return { change_id: change.id };
  }
}

/**
 * Registers bounded reads and reviewed Joplin organization proposals.
 *
 * @example registerNoteOrganizationTools(registry, repository, changes)
 */
export function registerNoteOrganizationTools(
  registry: ToolRegistry,
  repository: NoteOrganizationRepository,
  changes: ChangeSetStore,
): void {
  registry.register(new ReadNotebookTool(repository));
  registry.register(new ListNotebookNotesTool(repository));
  registry.register(new CreateNotebookTool(changes));
  registry.register(new RenameNoteTool(repository, changes));
  registry.register(new MoveNoteTool(repository, changes));
  registry.register(new ReorderNoteTool(repository, changes));
  registry.register(new DeleteNoteTool(repository, changes));
  registerTrashOrganizationTools(registry, repository, changes);
  registerNotebookOrganizationTools(registry, repository, changes);
}
