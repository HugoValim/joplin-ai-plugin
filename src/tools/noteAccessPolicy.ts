import { DomainError, safeValue } from "../shared/errors";
import type { ToolExecutionContext } from "./toolRegistry";

/**
 * Returns whether vault-wide note and notebook org tools may be advertised.
 * Under model B, org tools are always available; secret notebooks are filtered at execute time.
 *
 * @example vaultOrgToolsEnabled()
 */
export function vaultOrgToolsEnabled(): boolean {
  return true;
}

/**
 * Returns whether note body read/write tools may be advertised.
 * Under model B, all non-secret notes are reachable; secrets are filtered at execute time.
 *
 * @example noteScopedToolsEnabled()
 */
export function noteScopedToolsEnabled(
  _context?: ToolExecutionContext,
): boolean {
  return true;
}

/**
 * Returns true when the notebook is marked secret and must be excluded.
 *
 * @example isSecretNotebook(context, "nb-1")
 */
export function isSecretNotebook(
  context: ToolExecutionContext,
  notebookId: string,
): boolean {
  return context.secretNotebookIds.has(notebookId);
}

/**
 * Rejects operations on secret notebooks.
 *
 * @example assertNotebookAllowed(context, "nb-1")
 */
export function assertNotebookAllowed(
  context: ToolExecutionContext,
  notebookId: string,
): void {
  if (!notebookId) return;
  if (!isSecretNotebook(context, notebookId)) return;
  throw new DomainError(
    "NOT_AVAILABLE",
    `Notebook ${safeValue(notebookId)} is marked secret and excluded from agent tools; expected an unmarked notebook`,
  );
}

/**
 * Rejects note organization on notes in secret notebooks.
 * Does not require active/attached allowlist — discovery via list/search is enough.
 *
 * @example assertNoteOrgAllowed(context, note.parentId)
 */
export function assertNoteOrgAllowed(
  context: ToolExecutionContext,
  parentNotebookId: string,
): void {
  assertNotebookAllowed(context, parentNotebookId);
}

/**
 * Rejects note body reads or proposals in secret notebooks.
 * Attach does not bypass secret notebooks. Non-secret notes are reachable without allowlist.
 *
 * @example assertNoteReadable(context, "note-1", "nb-1")
 */
export function assertNoteReadable(
  context: ToolExecutionContext,
  noteId: string,
  parentNotebookId?: string,
): void {
  if (!parentNotebookId) {
    throw new DomainError(
      "VALIDATION",
      `Note ${safeValue(noteId)} is missing a parent notebook id; expected a notebook id string`,
    );
  }
  assertNotebookAllowed(context, parentNotebookId);
}

/**
 * Filters notebook records to exclude secret notebooks.
 *
 * @example filterAllowedNotebooks(context, notebooks)
 */
export function filterAllowedNotebooks<T extends { id: string }>(
  context: ToolExecutionContext,
  notebooks: readonly T[],
): readonly T[] {
  return notebooks.filter((notebook) => !isSecretNotebook(context, notebook.id));
}

/**
 * Filters note search hits to exclude notes in secret notebooks.
 *
 * @example filterAllowedNotes(context, notes)
 */
export function filterAllowedNotes<
  T extends { id: string; parentId?: string; parent_id?: string },
>(context: ToolExecutionContext, notes: readonly T[]): readonly T[] {
  return notes.filter((note) => {
    const parentId = note.parentId ?? note.parent_id ?? "";
    return !parentId || !isSecretNotebook(context, parentId);
  });
}
