import type {
  RollbackMergeJournal,
  RollbackRecord,
  RollbackStore,
} from "./changeCompensation";
import { DomainError, safeValue } from "../shared/errors";

export class InMemoryRollbackStore implements RollbackStore {
  private readonly records = new Map<string, RollbackRecord>();
  private pendingMergeJournal: RollbackMergeJournal | null = null;

  public constructor(private readonly now: () => number = Date.now) {}

  public save(record: RollbackRecord): Promise<void> {
    this.records.set(record.runId, cloneRollback(record));
    this.prune();
    return Promise.resolve();
  }

  public get(runId: string): Promise<RollbackRecord | null> {
    const conflict = this.pendingMergeConflict();
    if (conflict) return Promise.reject(conflict);
    const record = this.records.get(runId);
    return Promise.resolve(record ? cloneRollback(record) : null);
  }

  public remove(runId: string): Promise<void> {
    this.records.delete(runId);
    return Promise.resolve();
  }

  public beginMerge(journal: RollbackMergeJournal): Promise<void> {
    const conflict = this.pendingMergeConflict();
    if (conflict) return Promise.reject(conflict);
    this.pendingMergeJournal = cloneMergeJournal(journal);
    return Promise.resolve();
  }

  public pendingMerge(): Promise<RollbackMergeJournal | null> {
    return Promise.resolve(
      this.pendingMergeJournal
        ? cloneMergeJournal(this.pendingMergeJournal)
        : null,
    );
  }

  public commitPendingMerge(
    targetRunId: string,
    sourceRunId: string,
  ): Promise<void> {
    const pending = this.pendingMergeJournal;
    assertPendingOwner(pending, targetRunId, sourceRunId);
    this.pendingMergeJournal = null;
    return Promise.resolve();
  }

  public async rollbackPendingMerge(): Promise<void> {
    const pending = this.pendingMergeJournal;
    if (!pending) return;
    if (pending.target) await this.save(pending.target);
    else await this.remove(pending.targetRunId);
    await this.save(pending.source);
    this.pendingMergeJournal = null;
  }

  private pendingMergeConflict(): DomainError | null {
    const pending = this.pendingMergeJournal;
    if (!pending) return null;
    return new DomainError(
      "CONFLICT",
      `Rollback merge ${safeValue([pending.targetRunId, pending.sourceRunId])} is pending; expected lifecycle recovery`,
    );
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

function assertPendingOwner(
  pending: RollbackMergeJournal | null,
  targetRunId: string,
  sourceRunId: string,
): void {
  if (
    pending?.targetRunId === targetRunId &&
    pending.sourceRunId === sourceRunId
  ) {
    return;
  }
  throw new DomainError(
    "CONFLICT",
    `Rollback merge ${safeValue([targetRunId, sourceRunId])} does not own the pending journal`,
  );
}

function cloneRollback(record: RollbackRecord): RollbackRecord {
  return structuredClone(record);
}

function cloneMergeJournal(
  journal: RollbackMergeJournal,
): RollbackMergeJournal {
  return structuredClone(journal);
}
