import { Type } from "@sinclair/typebox";
import type { NoteOrganizationRepository } from "../notes/retriever";
import type { ChangeSetStore } from "../persistence/changeSetStore";
import { DomainError, safeValue } from "../shared/errors";
import type { ToolExecutionContext, ToolRegistry } from "./toolRegistry";
import { assertNotebookAllowed } from "./noteAccessPolicy";
import {
  OrganizationIdentifierSchema,
  OrganizationProposalOutputSchema,
  OrganizationTool,
  organizationNotebookSummary,
  readVersionedNotebookMetadata,
  type OrganizationProposalOutput,
} from "./organizationTool";

interface RenameNotebookInput {
  readonly notebook_id: string;
  readonly expected_updated_time: number;
  readonly title: string;
}

class RenameNotebookTool extends OrganizationTool<
  RenameNotebookInput,
  OrganizationProposalOutput
> {
  public readonly name = "rename_notebook";
  public readonly description =
    "Propose renaming a versioned Joplin notebook for approval.";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      notebook_id: OrganizationIdentifierSchema,
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

  public async execute(
    input: RenameNotebookInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    assertNotebookAllowed(context, input.notebook_id);
    const notebook = await readVersionedNotebookMetadata(
      this.repository,
      input,
    );
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "notebook",
      operation: "rename",
      notebookId: notebook.id,
      expectedUpdatedTime: notebook.updatedTime,
      title: input.title,
      targetLabel: notebook.title,
      before: organizationNotebookSummary(notebook.title, notebook.parentId),
      after: organizationNotebookSummary(input.title, notebook.parentId),
    });
    return { change_id: change.id };
  }
}

interface MoveNotebookInput {
  readonly notebook_id: string;
  readonly expected_updated_time: number;
  readonly parent_id?: string;
}

class MoveNotebookTool extends OrganizationTool<
  MoveNotebookInput,
  OrganizationProposalOutput
> {
  public readonly name = "move_notebook";
  public readonly description =
    "Propose moving a versioned Joplin notebook under another notebook, or to the vault root with parent_id \"\" / omitted.";
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
    input: MoveNotebookInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    const parentId = input.parent_id ?? "";
    assertDistinctNotebookParent(input.notebook_id, parentId);
    assertNotebookAllowed(context, input.notebook_id);
    if (parentId) assertNotebookAllowed(context, parentId);
    const notebook = await readVersionedNotebookMetadata(
      this.repository,
      input,
    );
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "notebook",
      operation: "move",
      notebookId: notebook.id,
      expectedUpdatedTime: notebook.updatedTime,
      parentId,
      targetLabel: notebook.title,
      before: organizationNotebookSummary(notebook.title, notebook.parentId),
      after: organizationNotebookSummary(notebook.title, parentId),
    });
    return { change_id: change.id };
  }
}

interface DeleteNotebookInput {
  readonly notebook_id: string;
  readonly expected_updated_time: number;
}

class DeleteNotebookTool extends OrganizationTool<
  DeleteNotebookInput,
  OrganizationProposalOutput
> {
  public readonly name = "delete_notebook";
  public readonly description =
    "Propose moving a notebook and its contents to Joplin Trash; manual approval is required.";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      notebook_id: OrganizationIdentifierSchema,
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

  public async execute(
    input: DeleteNotebookInput,
    context: ToolExecutionContext,
  ): Promise<OrganizationProposalOutput> {
    assertNotebookAllowed(context, input.notebook_id);
    const notebook = await readVersionedNotebookMetadata(
      this.repository,
      input,
    );
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "notebook",
      operation: "delete",
      notebookId: notebook.id,
      expectedUpdatedTime: notebook.updatedTime,
      targetLabel: notebook.title,
      before: organizationNotebookSummary(notebook.title, notebook.parentId),
      after: "Moved to Joplin Trash with contained items (recoverable).",
    });
    return { change_id: change.id };
  }
}

/**
 * Registers reviewed notebook rename, move, and trash proposal tools.
 *
 * @example registerNotebookOrganizationTools(registry, repository, changes)
 */
export function registerNotebookOrganizationTools(
  registry: ToolRegistry,
  repository: NoteOrganizationRepository,
  changes: ChangeSetStore,
): void {
  registry.register(new RenameNotebookTool(repository, changes));
  registry.register(new MoveNotebookTool(repository, changes));
  registry.register(new DeleteNotebookTool(repository, changes));
}

function assertDistinctNotebookParent(
  notebookId: string,
  parentId: string,
): void {
  if (!parentId || parentId !== notebookId) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid parent notebook ID ${safeValue(parentId)}; expected a different notebook ID or root`,
  );
}
