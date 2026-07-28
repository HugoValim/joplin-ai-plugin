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
 * Returns whether note-scoped tools may be advertised for allowlisted notes.
 *
 * @example noteScopedToolsEnabled(context)
 */
export function noteScopedToolsEnabled(
  context: ToolExecutionContext,
): boolean {
  return context.readableNoteIds.size > 0;
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
 * Rejects note body reads or proposals in secret notebooks or outside allowlist.
 * Attach does not bypass secret notebooks.
 *
 * @example assertNoteReadable(context, "note-1", "nb-1")
 */
export function assertNoteReadable(
  context: ToolExecutionContext,
  noteId: string,
  parentNotebookId?: string,
): void {
  if (parentNotebookId) assertNotebookAllowed(context, parentNotebookId);
  if (context.readableNoteIds.has(noteId)) {
    if (parentNotebookId && isSecretNotebook(context, parentNotebookId)) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `Note ${safeValue(noteId)} is in a secret notebook; expected an unmarked notebook`,
      );
    }
    return;
  }
  throw new DomainError(
    "NOT_AVAILABLE",
    `Note ${safeValue(noteId)} is outside the enabled context allowlist; expected an active or attached note`,
  );
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
