import type {
  FileRollbackSnapshot,
  TextFileSnapshot,
  TextSearchMatch,
} from "../fileWorkspace/fileWorkspaceRepository";
import type { NoteRecord, NoteRepository } from "../notes/retriever";
import type {
  ChangeSet,
  ChangeSetScope,
  ChangeSetStore,
  ProposedChange,
} from "../persistence/changeSetStore";
import { DomainError, safeValue } from "../shared/errors";

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

export type RollbackItem =
  | {
      readonly kind: "file";
      readonly chatId: string;
      readonly snapshot: FileRollbackSnapshot;
      readonly expectedAppliedSha256: string;
    }
  | {
      readonly kind: "note";
      readonly noteId: string;
      readonly originalBody: string;
      readonly expectedAppliedUpdatedTime: number;
    };

export interface RollbackRecord {
  readonly runId: string;
  readonly chatId: string;
  readonly createdAt: number;
  readonly items: readonly RollbackItem[];
}

export interface RollbackStore {
  save(record: RollbackRecord): Promise<void>;
  get(runId: string): Promise<RollbackRecord | null>;
}

export class InMemoryRollbackStore implements RollbackStore {
  private readonly records = new Map<string, RollbackRecord>();

  public constructor(private readonly now: () => number = Date.now) {}

  public save(record: RollbackRecord): Promise<void> {
    this.records.set(record.runId, cloneRollback(record));
    this.prune();
    return Promise.resolve();
  }

  public async get(runId: string): Promise<RollbackRecord | null> {
    const record = this.records.get(runId);
    return Promise.resolve(record ? cloneRollback(record) : null);
  }

  private prune(): void {
    const cutoff = this.now() - 7 * 24 * 60 * 60 * 1_000;
    const retained = [...this.records.values()]
      .filter((record) => record.createdAt >= cutoff)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 10);
    this.records.clear();
    for (const record of retained) this.records.set(record.runId, record);
  }
}

export interface ApplyResult {
  readonly changeSetId: string;
  readonly changes: readonly ProposedChange[];
  readonly undoAvailable: boolean;
}

export interface UndoResult {
  readonly runId: string;
  readonly restored: number;
  readonly conflicts: readonly string[];
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
    };

export class ChangeApplier {
  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly notes: NoteRepository,
    private readonly workspaces: FileWorkspaceWriteResolver,
    private readonly rollbacks: RollbackStore,
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
   *
   * @example await applier.undo(runId, chatId)
   */
  public async undo(runId: string, chatId: string): Promise<UndoResult> {
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
    let restored = 0;
    const conflicts: string[] = [];
    for (const item of record.items) {
      try {
        await this.restoreItem(item);
        restored += 1;
      } catch (error: unknown) {
        conflicts.push(errorMessage(error));
      }
    }
    return { runId, restored, conflicts };
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
    if (change.operation === "create") return { kind: "note-create", change };
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
    const applied = await this.notes.updateNoteBody({
      noteId: item.change.noteId,
      body: item.change.after,
      expectedUpdatedTime: item.change.expectedUpdatedTime,
    });
    return {
      kind: "note",
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
    await this.notes.updateNoteBody({
      noteId: item.noteId,
      body: item.originalBody,
      expectedUpdatedTime: item.expectedAppliedUpdatedTime,
    });
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

function cloneRollback(record: RollbackRecord): RollbackRecord {
  return {
    ...record,
    items: record.items.map((item) =>
      item.kind === "file"
        ? { ...item, snapshot: { ...item.snapshot } }
        : { ...item },
    ),
  };
}
