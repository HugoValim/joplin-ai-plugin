import { Type } from "@sinclair/typebox";
import type { NoteOrganizationRepository } from "../notes/retriever";
import type { ChangeSetStore } from "../persistence/changeSetStore";
import type { ToolExecutionContext, ToolRegistry } from "./toolRegistry";
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
 * Registers reviewed notebook rename and trash proposal tools.
 *
 * @example registerNotebookOrganizationTools(registry, repository, changes)
 */
export function registerNotebookOrganizationTools(
  registry: ToolRegistry,
  repository: NoteOrganizationRepository,
  changes: ChangeSetStore,
): void {
  registry.register(new RenameNotebookTool(repository, changes));
  registry.register(new DeleteNotebookTool(repository, changes));
}
