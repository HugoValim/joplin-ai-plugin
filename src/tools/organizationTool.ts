import { Type, type TSchema } from "@sinclair/typebox";
import type {
  NoteMetadataRecord,
  NoteOrganizationRepository,
  NotebookMetadataRecord,
  TrashedNoteRecord,
  TrashedNotebookRecord,
} from "../notes/retriever";
import { DomainError } from "../shared/errors";
import type {
  AgentTool,
  AgentToolClassification,
  ToolExecutionContext,
  ToolRisk,
} from "./toolRegistry";
import { vaultOrgToolsEnabled } from "./noteAccessPolicy";

export const OrganizationIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
});
export const OrganizationProposalOutputSchema = Type.Object(
  { change_id: OrganizationIdentifierSchema },
  { additionalProperties: false },
);

export interface OrganizationProposalOutput {
  readonly change_id: string;
}

export interface VersionedNoteInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
}

export interface VersionedNotebookInput {
  readonly notebook_id: string;
  readonly expected_updated_time: number;
}

export abstract class OrganizationTool<TInput, TOutput> implements AgentTool<
  TInput,
  TOutput
> {
  public abstract readonly name: string;
  public abstract readonly description: string;
  public abstract readonly risk: ToolRisk;
  public readonly classification: AgentToolClassification = "other";
  public abstract readonly inputSchema: TSchema;
  public abstract readonly outputSchema: TSchema;

  public isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public abstract execute(
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<TOutput>;
}

/**
 * Formats current note organization metadata for a proposal diff.
 *
 * @example organizationNoteSummary("Plan", "projects", 10)
 */
export function organizationNoteSummary(
  title: string,
  parentId: string,
  order: number,
): string {
  return [
    `Title: ${title}`,
    `Notebook: ${parentId}`,
    `Manual order: ${order}`,
  ].join("\n");
}

/**
 * Formats current notebook hierarchy metadata for a proposal diff.
 *
 * @example organizationNotebookSummary("Projects", "")
 */
export function organizationNotebookSummary(
  title: string,
  parentId: string,
): string {
  return [`Title: ${title}`, `Parent notebook: ${parentId || "(root)"}`].join(
    "\n",
  );
}

/**
 * Rejects stale organization inputs before proposal creation.
 *
 * @example assertOrganizationVersion("note-1", 20, 20)
 */
export function assertOrganizationVersion(
  itemId: string,
  actual: number,
  expected: number,
): void {
  if (actual === expected) return;
  throw new DomainError(
    "CONFLICT",
    `Item ${itemId} has updated_time ${actual}; expected updated_time ${expected}`,
  );
}

/**
 * Reads note metadata and verifies the model-provided version.
 *
 * @example await readVersionedNoteMetadata(repository, input)
 */
export async function readVersionedNoteMetadata(
  repository: NoteOrganizationRepository,
  input: VersionedNoteInput,
): Promise<NoteMetadataRecord> {
  const note = await repository.readNoteMetadata(input.note_id);
  assertOrganizationVersion(
    note.id,
    note.updatedTime,
    input.expected_updated_time,
  );
  return note;
}

/**
 * Reads notebook metadata and verifies the model-provided version.
 *
 * @example await readVersionedNotebookMetadata(repository, input)
 */
export async function readVersionedNotebookMetadata(
  repository: NoteOrganizationRepository,
  input: VersionedNotebookInput,
): Promise<NotebookMetadataRecord> {
  const notebook = await repository.readNotebook(input.notebook_id);
  assertOrganizationVersion(
    notebook.id,
    notebook.updatedTime,
    input.expected_updated_time,
  );
  return notebook;
}

/**
 * Reads trashed note metadata and verifies the model-provided version.
 *
 * @example await readVersionedTrashedNote(repository, input)
 */
export async function readVersionedTrashedNote(
  repository: NoteOrganizationRepository,
  input: VersionedNoteInput,
): Promise<TrashedNoteRecord> {
  const note = await repository.readTrashedNote(input.note_id);
  assertOrganizationVersion(
    note.id,
    note.updatedTime,
    input.expected_updated_time,
  );
  return note;
}

/**
 * Reads trashed notebook metadata and verifies the model-provided version.
 *
 * @example await readVersionedTrashedNotebook(repository, input)
 */
export async function readVersionedTrashedNotebook(
  repository: NoteOrganizationRepository,
  input: VersionedNotebookInput,
): Promise<TrashedNotebookRecord> {
  const notebook = await repository.readTrashedNotebook(input.notebook_id);
  assertOrganizationVersion(
    notebook.id,
    notebook.updatedTime,
    input.expected_updated_time,
  );
  return notebook;
}
