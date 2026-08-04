import type { FileRollbackSnapshot } from "../fileWorkspace/fileWorkspaceRepository";
import type {
  NoteMetadataRecord,
  NoteOrganizationRepository,
  NoteRepository,
  NotebookMetadataRecord,
} from "../notes/retriever";
import { DomainError, safeValue } from "../shared/errors";
import type { FileWorkspaceWriteResolver } from "./changeApplier";
import type { OrganizationRollbackItem } from "./noteOrganizationChangeApplier";

export type RollbackItem =
  | {
      readonly kind: "file";
      readonly changeId: string;
      readonly chatId: string;
      readonly snapshot: FileRollbackSnapshot;
      readonly expectedAppliedSha256: string;
    }
  | {
      readonly kind: "note";
      readonly changeId: string;
      readonly noteId: string;
      readonly originalBody: string;
      readonly expectedAppliedUpdatedTime: number;
    }
  | {
      readonly kind: "note-create";
      readonly changeId: string;
      readonly noteId: string;
      readonly expectedAppliedUpdatedTime: number;
    }
  | OrganizationRollbackItem;

export interface RollbackRecord {
  readonly runId: string;
  readonly chatId: string;
  readonly createdAt: number;
  readonly items: readonly RollbackItem[];
  readonly application?: RollbackApplicationJournal;
}

export interface RollbackApplicationJournal {
  readonly changeSetId: string;
  readonly state: "applying" | "applied";
  readonly acceptedChangeIds: readonly string[];
  readonly results?: readonly RollbackApplicationResult[];
}

export interface RollbackApplicationResult {
  readonly changeId: string;
  readonly status: "applied" | "conflict" | "skipped";
}

export interface RollbackMergeJournal {
  readonly targetRunId: string;
  readonly sourceRunId: string;
  readonly chatId: string;
  readonly target: RollbackRecord | null;
  readonly source: RollbackRecord;
}

export interface RollbackStore {
  save(record: RollbackRecord): Promise<void>;
  get(runId: string): Promise<RollbackRecord | null>;
  remove(runId: string): Promise<void>;
  beginMerge(journal: RollbackMergeJournal): Promise<void>;
  pendingMerge(): Promise<RollbackMergeJournal | null>;
  commitPendingMerge(targetRunId: string, sourceRunId: string): Promise<void>;
  rollbackPendingMerge(): Promise<void>;
}

export interface RollbackMergeReceipt {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface UndoResult {
  readonly runId: string;
  readonly restored: number;
  readonly conflicts: readonly string[];
}

export class ChangeCompensator {
  public constructor(
    private readonly notes: NoteRepository,
    private readonly organizations: NoteOrganizationRepository | null,
    private readonly workspaces: FileWorkspaceWriteResolver,
    private readonly rollbacks: RollbackStore,
  ) {}

  /**
   * Restores selected mutations through optimistic concurrency boundaries.
   *
   * @example await compensator.undo(runId, chatId, [changeId])
   */
  public async undo(
    runId: string,
    chatId: string,
    changeIds?: readonly string[],
  ): Promise<UndoResult> {
    const record = await this.requireRollback(runId, chatId);
    const selected = selectRollbackItems(record.items, changeIds);
    const restored = await this.restoreSelected(record.items, selected);
    await this.rollbacks.save({ ...record, items: restored.remaining });
    return { runId, restored: restored.count, conflicts: restored.conflicts };
  }

  /**
   * Transfers compensation metadata into a cumulative applied run.
   *
   * @example await compensator.merge(targetRunId, chatId, sourceRunId)
   */
  public async merge(
    targetRunId: string,
    chatId: string,
    sourceRunId: string,
  ): Promise<RollbackMergeReceipt> {
    if (targetRunId === sourceRunId) return noOpMergeReceipt();
    const source = await this.rollbacks.get(sourceRunId);
    if (!source) return noOpMergeReceipt();
    assertRollbackOwner(source, chatId);
    const target = await this.rollbacks.get(targetRunId);
    if (target) assertRollbackOwner(target, chatId);
    const items = [...(target?.items ?? []), ...source.items];
    assertMergeCapacity(items);
    await this.rollbacks.beginMerge({
      targetRunId,
      sourceRunId,
      chatId,
      target,
      source,
    });
    const receipt = mergeReceipt(this.rollbacks, targetRunId, sourceRunId);
    try {
      await this.rollbacks.save({
        runId: targetRunId,
        chatId,
        createdAt: target?.createdAt ?? source.createdAt,
        items,
      });
      await this.rollbacks.save({ ...source, items: [] });
    } catch (error: unknown) {
      await receipt.rollback();
      throw error;
    }
    return receipt;
  }

  /**
   * Returns mutation IDs whose durable compensation remains outstanding.
   *
   * @example await compensator.retainedChangeIds(runId, chatId)
   */
  public async retainedChangeIds(
    runId: string,
    chatId: string,
  ): Promise<readonly string[]> {
    const record = await this.rollbacks.get(runId);
    if (!record) return [];
    assertRollbackOwner(record, chatId);
    if (record.application?.state === "applying") {
      return [...record.application.acceptedChangeIds];
    }
    return record.items.map((item) => item.changeId);
  }

  private async requireRollback(
    runId: string,
    chatId: string,
  ): Promise<RollbackRecord> {
    const record = await this.rollbacks.get(runId);
    if (!record) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `No rollback for run ${safeValue(runId)}; expected a retained applied run`,
      );
    }
    assertRollbackOwner(record, chatId);
    return record;
  }

  private async restoreSelected(
    items: readonly RollbackItem[],
    selected: ReadonlySet<string>,
  ): Promise<RestoreBatchResult> {
    const result: MutableRestoreBatchResult = {
      count: 0,
      conflicts: [],
      remaining: [],
    };
    for (const item of items) {
      if (!selected.has(item.changeId)) {
        result.remaining.push(item);
        continue;
      }
      await this.restoreOne(item, result);
    }
    return result;
  }

  private async restoreOne(
    item: RollbackItem,
    result: MutableRestoreBatchResult,
  ): Promise<void> {
    try {
      await this.restoreItem(item);
      result.count += 1;
    } catch (error: unknown) {
      result.conflicts.push(errorMessage(error));
      result.remaining.push(item);
    }
  }

  private async restoreItem(item: RollbackItem): Promise<void> {
    if (item.kind === "file") return this.restoreFile(item);
    if (item.kind === "note") return this.restoreNoteBody(item);
    const organizations = requireOrganizations(this.organizations);
    if (item.kind === "note-create") {
      await organizations.trashNote({
        noteId: item.noteId,
        expectedUpdatedTime: item.expectedAppliedUpdatedTime,
      });
      return;
    }
    if (item.kind === "notebook-create") {
      await organizations.trashNotebook({
        notebookId: item.notebookId,
        expectedUpdatedTime: item.expectedAppliedUpdatedTime,
      });
      return;
    }
    return restoreOrganizationItem(item, organizations);
  }

  private async restoreFile(
    item: Extract<RollbackItem, { kind: "file" }>,
  ): Promise<void> {
    const workspace = this.workspaces.resolve(item.chatId);
    if (!workspace) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `Chat ${item.chatId} has no file workspace; expected its selected folder`,
      );
    }
    await workspace.restoreRollback(item.snapshot, item.expectedAppliedSha256);
  }

  private async restoreNoteBody(
    item: Extract<RollbackItem, { kind: "note" }>,
  ): Promise<void> {
    await this.notes.updateNoteBody({
      noteId: item.noteId,
      body: item.originalBody,
      expectedUpdatedTime: item.expectedAppliedUpdatedTime,
    });
  }
}

function mergeReceipt(
  store: RollbackStore,
  targetRunId: string,
  sourceRunId: string,
): RollbackMergeReceipt {
  return {
    commit: (): Promise<void> =>
      store.commitPendingMerge(targetRunId, sourceRunId),
    rollback: (): Promise<void> => store.rollbackPendingMerge(),
  };
}

function noOpMergeReceipt(): RollbackMergeReceipt {
  return {
    commit: (): Promise<void> => Promise.resolve(),
    rollback: (): Promise<void> => Promise.resolve(),
  };
}

interface RestoreBatchResult {
  readonly count: number;
  readonly conflicts: readonly string[];
  readonly remaining: readonly RollbackItem[];
}

interface MutableRestoreBatchResult {
  count: number;
  conflicts: string[];
  remaining: RollbackItem[];
}

async function restoreOrganizationItem(
  item: Exclude<
    RollbackItem,
    { kind: "file" | "note" | "note-create" | "notebook-create" }
  >,
  repository: NoteOrganizationRepository,
): Promise<void> {
  if (item.kind === "note-metadata") {
    await restoreNoteMetadata(item, repository);
    return;
  }
  if (item.kind === "notebook-metadata") {
    await restoreNotebookMetadata(item, repository);
    return;
  }
  if (item.kind === "note-trash") {
    await repository.restoreNote({
      noteId: item.original.id,
      expectedUpdatedTime: item.expectedAppliedUpdatedTime,
      parentId: item.original.parentId,
    });
    return;
  }
  if (item.kind === "notebook-trash") {
    await repository.restoreNotebook({
      notebookId: item.original.id,
      expectedUpdatedTime: item.expectedAppliedUpdatedTime,
      parentId: item.original.parentId,
    });
    return;
  }
  if (item.kind === "note-restore") {
    await repository.trashNote({
      noteId: item.original.id,
      expectedUpdatedTime: item.expectedAppliedUpdatedTime,
    });
    return;
  }
  await repository.trashNotebook({
    notebookId: item.original.id,
    expectedUpdatedTime: item.expectedAppliedUpdatedTime,
  });
}

function restoreNoteMetadata(
  item: {
    readonly original: NoteMetadataRecord;
    readonly expectedAppliedUpdatedTime: number;
  },
  repository: NoteOrganizationRepository,
): Promise<NoteMetadataRecord> {
  return repository.updateNoteMetadata({
    noteId: item.original.id,
    expectedUpdatedTime: item.expectedAppliedUpdatedTime,
    title: item.original.title,
    parentId: item.original.parentId,
    order: item.original.order,
  });
}

function restoreNotebookMetadata(
  item: {
    readonly original: NotebookMetadataRecord;
    readonly expectedAppliedUpdatedTime: number;
  },
  repository: NoteOrganizationRepository,
): Promise<NotebookMetadataRecord> {
  return repository.updateNotebookMetadata({
    notebookId: item.original.id,
    expectedUpdatedTime: item.expectedAppliedUpdatedTime,
    title: item.original.title,
    parentId: item.original.parentId,
  });
}

function requireOrganizations(
  repository: NoteOrganizationRepository | null,
): NoteOrganizationRepository {
  if (repository) return repository;
  throw new DomainError(
    "NOT_AVAILABLE",
    "Note organization repository is unavailable; expected configured Joplin data access",
  );
}

function assertRollbackOwner(record: RollbackRecord, chatId: string): void {
  if (record.chatId === chatId) return;
  throw new DomainError(
    "SECURITY",
    `Rollback ${safeValue(record.runId)} belongs to chat ${record.chatId}; expected chat ${chatId}`,
  );
}

function assertMergeCapacity(items: readonly RollbackItem[]): void {
  if (items.length <= 100) return;
  throw new DomainError(
    "VALIDATION",
    `Merged rollback would have ${items.length} items; expected at most 100`,
  );
}

function selectRollbackItems(
  items: readonly RollbackItem[],
  changeIds: readonly string[] | undefined,
): ReadonlySet<string> {
  if (!changeIds) return new Set(items.map((item) => item.changeId));
  const known = new Set(items.map((item) => item.changeId));
  const unknown = changeIds.find((changeId) => !known.has(changeId));
  if (unknown) {
    throw new DomainError(
      "VALIDATION",
      `Unknown undo change ${safeValue(unknown)}; expected a rollback change ID`,
    );
  }
  return new Set(changeIds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : safeValue(error);
}
