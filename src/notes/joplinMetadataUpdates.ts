import { DomainError, safeValue } from "../shared/errors";
import type {
  UpdateNoteMetadataInput,
  UpdateNotebookMetadataInput,
} from "./retriever";

/**
 * Builds a Joplin note metadata PUT body after validating the update shape.
 *
 * @example noteMetadataUpdateBody({ noteId, expectedUpdatedTime, title })
 */
export function noteMetadataUpdateBody(
  input: UpdateNoteMetadataInput,
): Record<string, unknown> {
  validateNoteMetadataUpdate(input);
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
  };
}

/**
 * Builds a Joplin notebook metadata PUT body after validating the update shape.
 *
 * @example notebookMetadataUpdateBody({ notebookId, expectedUpdatedTime, title })
 */
export function notebookMetadataUpdateBody(
  input: UpdateNotebookMetadataInput,
): Record<string, unknown> {
  validateNotebookMetadataUpdate(input);
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
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
