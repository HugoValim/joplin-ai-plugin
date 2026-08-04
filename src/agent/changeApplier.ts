import type {
  FileRollbackSnapshot,
  TextFileSnapshot,
  TextSearchMatch,
} from "../fileWorkspace/fileWorkspaceRepository";
import type {
  NoteOrganizationRepository,
  NoteRecord,
  NoteRepository,
} from "../notes/retriever";
import type {
  ChangeSet,
  ChangeSetScope,
  ChangeSetStore,
  ProposedChange,
} from "../persistence/changeSetStore";
import { DomainError, safeValue } from "../shared/errors";
import type {
  RollbackItem,
  RollbackStore,
  UndoResult,
} from "./changeCompensation";
import {
  applyOrganizationChange,
  preflightOrganizationChange,
  type ReadyOrganizationChange,
} from "./noteOrganizationChangeApplier";

export {
  type RollbackApplicationJournal,
  type RollbackItem,
  type RollbackMergeJournal,
  type RollbackMergeReceipt,
  type RollbackRecord,
  type RollbackStore,
  type UndoResult,
} from "./changeCompensation";
export { InMemoryRollbackStore } from "./inMemoryRollbackStore";

export interface FileWorkspaceWritePort {
  listTextFiles(): Promise<readonly TextFileSnapshot[]>;
  readTextFile(relativePath: string): Promise<TextFileSnapshot>;
  searchTextFiles(query: string): Promise<readonly TextSearchMatch[]>;
  writeTextFile(
    relativePath: string,
    replacement: string,
    expectedSha256: string,
  ): Promise<TextFileSnapshot>;
  captureRollback(relativePath: string): Promise<FileRollbackSnapshot>;
  restoreRollback(
    rollback: FileRollbackSnapshot,
    expectedSha256: string,
  ): Promise<TextFileSnapshot>;
}

export interface FileWorkspaceWriteResolver {
  resolve(chatId: string): FileWorkspaceWritePort | null;
}

export interface ApplyResult {
  readonly changeSetId: string;
  readonly changes: readonly ProposedChange[];
  readonly undoAvailable: boolean;
}

type ReadyChange =
  | {
      readonly kind: "file";
      readonly change: Extract<ProposedChange, { kind: "file" }>;
      readonly chatId: string;
      readonly workspace: FileWorkspaceWritePort;
      readonly original: FileRollbackSnapshot;
    }
  | {
      readonly kind: "note-update";
      readonly change: Extract<
        ProposedChange,
        { kind: "note"; operation: "update" }
      >;
      readonly original: NoteRecord;
    }
  | {
      readonly kind: "note-create";
      readonly change: Extract<
        ProposedChange,
        { kind: "note"; operation: "create" }
      >;
    }
  | ReadyOrganizationChange;

export class ChangeApplier {
  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly notes: NoteRepository,
    private readonly workspaces: FileWorkspaceWriteResolver,
    private readonly rollbacks: RollbackStore,
    private readonly organizations: NoteOrganizationRepository | null = null,
  ) {}

  /**
   * Preflights the batch, then applies accepted independent items with conflicts isolated.
   *
   * @example await applier.apply(changeSetId, acceptedChangeIds, { chatId, runId })
   */
  public async apply(
    changeSetId: string,
    acceptedChangeIds: readonly string[],
    scope: ChangeSetScope,
  ): Promise<ApplyResult> {
    const changeSet = this.requireProposedSet(changeSetId, scope);
    const accepted = validateAcceptedIds(changeSet, acceptedChangeIds);
    const preflight = await this.preflight(changeSet, accepted);
    const applied = await this.applyReady(preflight.ready, preflight.results);
    const orderedResults = orderByChangeSet(changeSet, applied.results);
    if (applied.rollbacks.length) {
      await this.rollbacks.save({
        runId: changeSet.runId,
        chatId: changeSet.chatId,
        createdAt: Date.now(),
        items: applied.rollbacks,
      });
    }
    const stored = this.changes.setResults(changeSetId, orderedResults);
    return {
      changeSetId,
      changes: stored.changes,
      undoAvailable: applied.rollbacks.length > 0,
    };
  }

  /**
   * Restores applied note bodies and exact file bytes if they remain unchanged.
   * When `changeIds` is set, only matching rollback items are restored.
   *
   * @example await applier.undo(runId, chatId, ["change-1"])
   */
  public async undo(
    runId: string,
    chatId: string,
    changeIds?: readonly string[],
  ): Promise<UndoResult> {
    const record = await this.rollbacks.get(runId);
    if (!record) {
      throw new DomainError(
        "NOT_AVAILABLE",
        `No rollback for run ${safeValue(runId)}; expected a retained applied run`,
      );
    }
    if (record.chatId !== chatId) {
      throw new DomainError(
        "SECURITY",
        `Rollback ${safeValue(runId)} belongs to chat ${record.chatId}; expected chat ${chatId}`,
      );
    }
    const selected = selectRollbackItems(record.items, changeIds);
    let restored = 0;
    const conflicts: string[] = [];
    const remaining: RollbackItem[] = [];
    for (const item of record.items) {
      if (!selected.has(item.changeId)) {
        remaining.push(item);
        continue;
      }
      try {
        await this.restoreItem(item);
        restored += 1;
      } catch (error: unknown) {
        conflicts.push(errorMessage(error));
        remaining.push(item);
      }
    }
    await this.rollbacks.save({ ...record, items: remaining });
    return { runId, restored, conflicts };
  }

  /**
   * Merges undo snapshots from a parked run into the target cumulative run.
   *
   * @example await applier.mergeRollbacks(targetRunId, chatId, parkedRunId)
   */
  public async mergeRollbacks(
    targetRunId: string,
    chatId: string,
    sourceRunId: string,
  ): Promise<void> {
    if (targetRunId === sourceRunId) return;
    const source = await this.rollbacks.get(sourceRunId);
    if (!source) return;
    if (source.chatId !== chatId) {
      throw new DomainError(
        "SECURITY",
        `Rollback ${safeValue(sourceRunId)} belongs to chat ${source.chatId}; expected chat ${chatId}`,
      );
    }
    const target = await this.rollbacks.get(targetRunId);
    if (target && target.chatId !== chatId) {
      throw new DomainError(
        "SECURITY",
        `Rollback ${safeValue(targetRunId)} belongs to chat ${target.chatId}; expected chat ${chatId}`,
      );
    }
    const items = [...(target?.items ?? []), ...source.items];
    if (items.length > 100) {
      throw new DomainError(
        "VALIDATION",
        `Merged rollback would have ${items.length} items; expected at most 100`,
      );
    }
    await this.rollbacks.save({
      runId: targetRunId,
      chatId,
      createdAt: target?.createdAt ?? source.createdAt,
      items,
    });
    await this.rollbacks.save({
      ...source,
      items: [],
    });
  }

  private requireProposedSet(
    changeSetId: string,
    scope: ChangeSetScope,
  ): ChangeSet {
    const changeSet = this.changes.getScoped(changeSetId, scope);
    if (changeSet.status === "proposed") return changeSet;
    throw new DomainError(
      "NOT_AVAILABLE",
      `Change set ${safeValue(changeSetId)} is not pending; expected proposed status`,
    );
  }

  private async preflight(
    changeSet: ChangeSet,
    accepted: ReadonlySet<string>,
  ): Promise<{ ready: ReadyChange[]; results: ProposedChange[] }> {
    const ready: ReadyChange[] = [];
    const results: ProposedChange[] = [];
    for (const change of changeSet.changes) {
      if (!accepted.has(change.id)) {
        results.push(withStatus(change, "skipped"));
        continue;
      }
      try {
        ready.push(await this.preflightOne(change, changeSet.chatId));
      } catch (error: unknown) {
        results.push(withStatus(change, "conflict", errorMessage(error)));
      }
    }
    return { ready, results };
  }

  private async preflightOne(
    change: ProposedChange,
    chatId: string,
  ): Promise<ReadyChange> {
    if (change.kind === "file") {
      const workspace = requireWorkspace(this.workspaces, chatId);
      const current = await workspace.readTextFile(change.relativePath);
      assertFileVersion(change, current);
      const original = await workspace.captureRollback(change.relativePath);
      return { kind: "file", change, chatId, workspace, original };
    }
    if (change.kind === "notebook") {
      return preflightOrganizationChange(
        change,
        requireOrganizations(this.organizations),
      );
    }
    if (change.operation === "create") return { kind: "note-create", change };
    if (change.operation !== "update") {
      return preflightOrganizationChange(
        change,
        requireOrganizations(this.organizations),
      );
    }
    const original = await this.notes.readNote(change.noteId);
    assertNoteVersion(change, original);
    return { kind: "note-update", change, original };
  }

  private async applyReady(
    ready: readonly ReadyChange[],
    initialResults: readonly ProposedChange[],
  ): Promise<{ results: ProposedChange[]; rollbacks: RollbackItem[] }> {
    const results = [...initialResults];
    const rollbacks: RollbackItem[] = [];
    for (const item of ready) {
      try {
        const applied = await this.applyOne(item);
        results.push(withStatus(item.change, "applied"));
        if (applied) rollbacks.push(applied);
      } catch (error: unknown) {
        results.push(withStatus(item.change, "conflict", errorMessage(error)));
      }
    }
    return { results, rollbacks };
  }

  private async applyOne(item: ReadyChange): Promise<RollbackItem | null> {
    if (item.kind === "file") {
      const applied = await item.workspace.writeTextFile(
        item.change.relativePath,
        item.change.after,
        item.change.expectedSha256,
      );
      return {
        kind: "file",
        changeId: item.change.id,
        chatId: item.chatId,
        snapshot: item.original,
        expectedAppliedSha256: applied.sha256,
      };
    }
    if (item.kind === "note-create") {
      await this.notes.createNote({
        parentId: item.change.parentId,
        title: item.change.title,
        body: item.change.after,
      });
      return null;
    }
    if (item.kind !== "note-update") {
      await applyOrganizationChange(
        item,
        requireOrganizations(this.organizations),
      );
      return null;
    }
    const applied = await this.notes.updateNoteBody({
      noteId: item.change.noteId,
      body: item.change.after,
      expectedUpdatedTime: item.change.expectedUpdatedTime,
    });
    return {
      kind: "note",
      changeId: item.change.id,
      noteId: item.change.noteId,
      originalBody: item.original.body,
      expectedAppliedUpdatedTime: applied.updatedTime,
    };
  }

  private async restoreItem(item: RollbackItem): Promise<void> {
    if (item.kind === "file") {
      const workspace = requireWorkspace(this.workspaces, item.chatId);
      await workspace.restoreRollback(
        item.snapshot,
        item.expectedAppliedSha256,
      );
      return;
    }
    if (item.kind === "note") {
      await this.notes.updateNoteBody({
        noteId: item.noteId,
        body: item.originalBody,
        expectedUpdatedTime: item.expectedAppliedUpdatedTime,
      });
      return;
    }
    throw new DomainError(
      "NOT_AVAILABLE",
      `Rollback kind ${item.kind} is not handled by ChangeApplier undo; expected ChangeCompensator`,
    );
  }
}

function validateAcceptedIds(
  changeSet: ChangeSet,
  acceptedIds: readonly string[],
): ReadonlySet<string> {
  const accepted = new Set(acceptedIds);
  const known = new Set(changeSet.changes.map((change) => change.id));
  const unknown = [...accepted].find((id) => !known.has(id));
  if (!unknown) return accepted;
  throw new DomainError(
    "VALIDATION",
    `Unknown accepted change ${safeValue(unknown)}; expected an ID in change set ${changeSet.id}`,
  );
}

function requireWorkspace(
  resolver: FileWorkspaceWriteResolver,
  chatId: string,
): FileWorkspaceWritePort {
  const workspace = resolver.resolve(chatId);
  if (workspace) return workspace;
  throw new DomainError(
    "NOT_AVAILABLE",
    `Chat ${chatId} has no file workspace; expected its selected folder`,
  );
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

function assertFileVersion(
  change: Extract<ProposedChange, { kind: "file" }>,
  current: TextFileSnapshot,
): void {
  if (current.sha256 === change.expectedSha256) return;
  throw new DomainError(
    "CONFLICT",
    `File ${change.relativePath} has SHA-256 ${current.sha256}; expected SHA-256 ${change.expectedSha256}`,
  );
}

function assertNoteVersion(
  change: Extract<ProposedChange, { kind: "note"; operation: "update" }>,
  current: NoteRecord,
): void {
  if (current.updatedTime === change.expectedUpdatedTime) return;
  throw new DomainError(
    "CONFLICT",
    `Note ${change.noteId} has updated_time ${current.updatedTime}; expected updated_time ${change.expectedUpdatedTime}`,
  );
}

function withStatus(
  change: ProposedChange,
  status: ProposedChange["status"],
  message?: string,
): ProposedChange {
  return { ...change, status, ...(message ? { message } : {}) };
}

function orderByChangeSet(
  changeSet: ChangeSet,
  results: readonly ProposedChange[],
): ProposedChange[] {
  const order = new Map(
    changeSet.changes.map((change, index) => [change.id, index]),
  );
  return [...results].sort(
    (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : safeValue(error);
}

function selectRollbackItems(
  items: readonly RollbackItem[],
  changeIds: readonly string[] | undefined,
): ReadonlySet<string> {
  if (!changeIds) {
    return new Set(items.map((item) => item.changeId));
  }
  const known = new Set(items.map((item) => item.changeId));
  const selected = new Set<string>();
  for (const changeId of changeIds) {
    if (!known.has(changeId)) {
      throw new DomainError(
        "VALIDATION",
        `Unknown undo change ${safeValue(changeId)}; expected a rollback change ID`,
      );
    }
    selected.add(changeId);
  }
  return selected;
}
