import type {
  NoteMetadataRecord,
  NoteOrganizationRepository,
  NotebookMetadataRecord,
  TrashedNoteRecord,
  TrashedNotebookRecord,
} from "../notes/retriever";
import type { ProposedChange } from "../persistence/changeSetStore";
import { DomainError } from "../shared/errors";

type NoteOrganizationChange = Extract<
  ProposedChange,
  {
    kind: "note";
    operation: "rename" | "move" | "reorder" | "delete" | "restore";
  }
>;
type NotebookOrganizationChange = Extract<ProposedChange, { kind: "notebook" }>;
export type OrganizationChange =
  NoteOrganizationChange | NotebookOrganizationChange;

export type OrganizationRollbackItem =
  | {
      readonly kind: "notebook-create";
      readonly changeId: string;
      readonly notebookId: string;
      readonly expectedAppliedUpdatedTime: number;
    }
  | {
      readonly kind: "note-metadata";
      readonly changeId: string;
      readonly original: NoteMetadataRecord;
      readonly expectedAppliedUpdatedTime: number;
    }
  | {
      readonly kind: "notebook-metadata";
      readonly changeId: string;
      readonly original: NotebookMetadataRecord;
      readonly expectedAppliedUpdatedTime: number;
    }
  | {
      readonly kind: "note-trash";
      readonly changeId: string;
      readonly original: NoteMetadataRecord;
      readonly expectedAppliedUpdatedTime: number;
    }
  | {
      readonly kind: "notebook-trash";
      readonly changeId: string;
      readonly original: NotebookMetadataRecord;
      readonly expectedAppliedUpdatedTime: number;
    }
  | {
      readonly kind: "note-restore";
      readonly changeId: string;
      readonly original: TrashedNoteRecord;
      readonly expectedAppliedUpdatedTime: number;
    }
  | {
      readonly kind: "notebook-restore";
      readonly changeId: string;
      readonly original: TrashedNotebookRecord;
      readonly expectedAppliedUpdatedTime: number;
    };

export type ReadyOrganizationChange =
  | {
      readonly kind: "notebook-create";
      readonly change: Extract<
        ProposedChange,
        { kind: "notebook"; operation: "create" }
      >;
    }
  | {
      readonly kind: "note-rename";
      readonly change: Extract<
        ProposedChange,
        { kind: "note"; operation: "rename" }
      >;
      readonly original: NoteMetadataRecord;
    }
  | {
      readonly kind: "note-move";
      readonly change: Extract<
        ProposedChange,
        { kind: "note"; operation: "move" }
      >;
      readonly original: NoteMetadataRecord;
    }
  | {
      readonly kind: "note-reorder";
      readonly change: Extract<
        ProposedChange,
        { kind: "note"; operation: "reorder" }
      >;
      readonly original: NoteMetadataRecord;
    }
  | {
      readonly kind: "note-delete";
      readonly change: Extract<
        ProposedChange,
        { kind: "note"; operation: "delete" }
      >;
      readonly original: NoteMetadataRecord;
    }
  | {
      readonly kind: "note-restore";
      readonly change: Extract<
        ProposedChange,
        { kind: "note"; operation: "restore" }
      >;
      readonly original: TrashedNoteRecord;
    }
  | {
      readonly kind: "notebook-rename";
      readonly change: Extract<
        ProposedChange,
        { kind: "notebook"; operation: "rename" }
      >;
      readonly original: NotebookMetadataRecord;
    }
  | {
      readonly kind: "notebook-move";
      readonly change: Extract<
        ProposedChange,
        { kind: "notebook"; operation: "move" }
      >;
      readonly original: NotebookMetadataRecord;
    }
  | {
      readonly kind: "notebook-delete";
      readonly change: Extract<
        ProposedChange,
        { kind: "notebook"; operation: "delete" }
      >;
      readonly original: NotebookMetadataRecord;
    }
  | {
      readonly kind: "notebook-restore";
      readonly change: Extract<
        ProposedChange,
        { kind: "notebook"; operation: "restore" }
      >;
      readonly original: TrashedNotebookRecord;
    };

/**
 * Validates one organization proposal against current Joplin metadata.
 *
 * @example await preflightOrganizationChange(change, repository)
 */
export async function preflightOrganizationChange(
  change: OrganizationChange,
  repository: NoteOrganizationRepository,
): Promise<ReadyOrganizationChange> {
  if (change.kind === "notebook")
    return preflightNotebookChange(change, repository);
  return preflightNoteChange(change, repository);
}

async function preflightNoteChange(
  change: NoteOrganizationChange,
  repository: NoteOrganizationRepository,
): Promise<ReadyOrganizationChange> {
  if (change.operation === "restore") {
    const original = await repository.readTrashedNote(change.noteId);
    assertOrganizationVersion(change, original);
    return { kind: "note-restore", change, original };
  }
  const original = await repository.readNoteMetadata(change.noteId);
  assertOrganizationVersion(change, original);
  if (change.operation === "rename")
    return { kind: "note-rename", change, original };
  if (change.operation === "move")
    return { kind: "note-move", change, original };
  if (change.operation === "reorder")
    return { kind: "note-reorder", change, original };
  return { kind: "note-delete", change, original };
}

async function preflightNotebookChange(
  change: NotebookOrganizationChange,
  repository: NoteOrganizationRepository,
): Promise<ReadyOrganizationChange> {
  if (change.operation === "create") return { kind: "notebook-create", change };
  if (change.operation === "restore") {
    const original = await repository.readTrashedNotebook(change.notebookId);
    assertOrganizationVersion(change, original);
    return { kind: "notebook-restore", change, original };
  }
  const original = await repository.readNotebook(change.notebookId);
  assertOrganizationVersion(change, original);
  if (change.operation === "rename")
    return { kind: "notebook-rename", change, original };
  if (change.operation === "move")
    return { kind: "notebook-move", change, original };
  return { kind: "notebook-delete", change, original };
}

/**
 * Applies one preflighted organization proposal through project-owned ports.
 *
 * @example await applyOrganizationChange(ready, repository)
 */
export async function applyOrganizationChange(
  item: ReadyOrganizationChange,
  repository: NoteOrganizationRepository,
): Promise<OrganizationRollbackItem> {
  if (isNotebookReadyChange(item))
    return applyNotebookOrganizationChange(item, repository);
  return applyNoteOrganizationChange(item, repository);
}

type NotebookReadyChange = Extract<
  ReadyOrganizationChange,
  {
    kind:
      | "notebook-create"
      | "notebook-rename"
      | "notebook-move"
      | "notebook-delete"
      | "notebook-restore";
  }
>;
type NoteReadyChange = Exclude<ReadyOrganizationChange, NotebookReadyChange>;

function isNotebookReadyChange(
  item: ReadyOrganizationChange,
): item is NotebookReadyChange {
  return item.kind.startsWith("notebook-");
}

async function applyNotebookOrganizationChange(
  item: NotebookReadyChange,
  repository: NoteOrganizationRepository,
): Promise<OrganizationRollbackItem> {
  if (item.kind === "notebook-create")
    return applyNotebookCreate(item, repository);
  if (item.kind === "notebook-rename")
    return applyNotebookRename(item, repository);
  if (item.kind === "notebook-move") return applyNotebookMove(item, repository);
  if (item.kind === "notebook-restore") {
    const applied = await repository.restoreNotebook({
      notebookId: item.change.notebookId,
      expectedUpdatedTime: item.change.expectedUpdatedTime,
      ...(item.change.parentId !== undefined
        ? { parentId: item.change.parentId }
        : {}),
    });
    return {
      kind: "notebook-restore",
      changeId: item.change.id,
      original: item.original,
      expectedAppliedUpdatedTime: applied.updatedTime,
    };
  }
  const applied = await repository.trashNotebook({
    notebookId: item.change.notebookId,
    expectedUpdatedTime: item.change.expectedUpdatedTime,
  });
  return {
    kind: "notebook-trash",
    changeId: item.change.id,
    original: item.original,
    expectedAppliedUpdatedTime: applied.updatedTime,
  };
}

async function applyNotebookCreate(
  item: Extract<ReadyOrganizationChange, { kind: "notebook-create" }>,
  repository: NoteOrganizationRepository,
): Promise<OrganizationRollbackItem> {
  const created = await repository.createNotebook({
    parentId: item.change.parentId,
    title: item.change.title,
  });
  return {
    kind: "notebook-create",
    changeId: item.change.id,
    notebookId: created.id,
    expectedAppliedUpdatedTime: created.updatedTime,
  };
}

async function applyNotebookRename(
  item: Extract<ReadyOrganizationChange, { kind: "notebook-rename" }>,
  repository: NoteOrganizationRepository,
): Promise<OrganizationRollbackItem> {
  const applied = await repository.updateNotebookMetadata({
    notebookId: item.change.notebookId,
    expectedUpdatedTime: item.change.expectedUpdatedTime,
    title: item.change.title,
  });
  return {
    kind: "notebook-metadata",
    changeId: item.change.id,
    original: item.original,
    expectedAppliedUpdatedTime: applied.updatedTime,
  };
}

async function applyNotebookMove(
  item: Extract<ReadyOrganizationChange, { kind: "notebook-move" }>,
  repository: NoteOrganizationRepository,
): Promise<OrganizationRollbackItem> {
  const applied = await repository.updateNotebookMetadata({
    notebookId: item.change.notebookId,
    expectedUpdatedTime: item.change.expectedUpdatedTime,
    parentId: item.change.parentId,
  });
  return {
    kind: "notebook-metadata",
    changeId: item.change.id,
    original: item.original,
    expectedAppliedUpdatedTime: applied.updatedTime,
  };
}

async function applyNoteOrganizationChange(
  item: NoteReadyChange,
  repository: NoteOrganizationRepository,
): Promise<OrganizationRollbackItem> {
  if (item.kind === "note-delete") {
    const applied = await repository.trashNote({
      noteId: item.change.noteId,
      expectedUpdatedTime: item.change.expectedUpdatedTime,
    });
    return {
      kind: "note-trash",
      changeId: item.change.id,
      original: item.original,
      expectedAppliedUpdatedTime: applied.updatedTime,
    };
  }
  if (item.kind === "note-restore") {
    const applied = await repository.restoreNote({
      noteId: item.change.noteId,
      expectedUpdatedTime: item.change.expectedUpdatedTime,
      ...(item.change.parentId !== undefined
        ? { parentId: item.change.parentId }
        : {}),
    });
    return {
      kind: "note-restore",
      changeId: item.change.id,
      original: item.original,
      expectedAppliedUpdatedTime: applied.updatedTime,
    };
  }
  const applied = await repository.updateNoteMetadata(noteMetadataUpdate(item));
  return {
    kind: "note-metadata",
    changeId: item.change.id,
    original: item.original,
    expectedAppliedUpdatedTime: applied.updatedTime,
  };
}

function noteMetadataUpdate(
  item: Extract<
    ReadyOrganizationChange,
    { kind: "note-rename" | "note-move" | "note-reorder" }
  >,
): Parameters<NoteOrganizationRepository["updateNoteMetadata"]>[0] {
  const common = {
    noteId: item.change.noteId,
    expectedUpdatedTime: item.change.expectedUpdatedTime,
  };
  if (item.kind === "note-rename") {
    return { ...common, title: item.change.title };
  }
  if (item.kind === "note-move") {
    return { ...common, parentId: item.change.parentId };
  }
  return { ...common, order: item.change.order };
}

function assertOrganizationVersion(
  change: { readonly expectedUpdatedTime: number },
  current: { readonly id: string; readonly updatedTime: number },
): void {
  if (current.updatedTime === change.expectedUpdatedTime) return;
  throw new DomainError(
    "CONFLICT",
    `Item ${current.id} has updated_time ${current.updatedTime}; expected updated_time ${change.expectedUpdatedTime}`,
  );
}
