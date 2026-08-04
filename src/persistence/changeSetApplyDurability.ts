import type {
  ChangeSet,
  ChangeSetScope,
  ChangeSetStore,
  ProposedChange,
} from "./changeSetStore";
import { DomainError, safeValue } from "../shared/errors";
import { AppliedChangeSetSaveError } from "./changeSetParking";
import type { ChangeSetParking } from "./changeSetParking";

export interface ChangeSetCompensationResult {
  readonly restored: number;
  readonly conflicts: readonly string[];
}

export interface ChangeSetCompensationPort {
  compensate(
    runId: string,
    chatId: string,
    changeIds: readonly string[],
  ): Promise<ChangeSetCompensationResult>;
}

interface FailedApplyInput extends ChangeSetScope {
  readonly changeSetId: string;
}

export class ChangeSetApplyDurability {
  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly parking: ChangeSetParking,
  ) {}

  /**
   * Compensates mutations only when the first durable applied-state save fails.
   *
   * @example await durability.handle(input, proposed, results, application, error)
   */
  public async handle(
    input: FailedApplyInput,
    proposed: ChangeSet,
    results: readonly ProposedChange[],
    application: ChangeSetCompensationPort,
    error: unknown,
  ): Promise<never> {
    if (!(error instanceof AppliedChangeSetSaveError)) throw error;
    const appliedIds = appliedChangeIds(results);
    if (appliedIds.length === 0)
      return this.restoreProposal(input, proposed, error);
    let compensation: ChangeSetCompensationResult;
    try {
      compensation = await application.compensate(
        input.runId,
        input.chatId,
        appliedIds,
      );
    } catch (compensationError: unknown) {
      return this.keepApplied(input, [errorMessage(compensationError)]);
    }
    if (compensation.conflicts.length > 0) {
      return this.keepApplied(input, compensation.conflicts);
    }
    return this.restoreProposal(input, proposed, error);
  }

  private restoreProposal(
    input: FailedApplyInput,
    proposed: ChangeSet,
    cause: unknown,
  ): never {
    this.changes.restore(proposed);
    throw new DomainError(
      "NOT_AVAILABLE",
      `Applied Change Set ${safeValue(input.changeSetId)} could not be saved; completed writes were compensated and proposal remains pending`,
      cause,
    );
  }

  private async keepApplied(
    input: FailedApplyInput,
    conflicts: readonly string[],
  ): Promise<never> {
    try {
      await this.parking.persistAppliedRecovery(
        input.chatId,
        input.runId,
        input.changeSetId,
      );
    } catch (saveError: unknown) {
      throw compensationConflictError(input.changeSetId, conflicts, saveError);
    }
    throw compensationConflictError(input.changeSetId, conflicts);
  }
}

function appliedChangeIds(changes: readonly ProposedChange[]): string[] {
  return changes
    .filter((change) => change.status === "applied")
    .map((change) => change.id);
}

function compensationConflictError(
  changeSetId: string,
  conflicts: readonly string[],
  cause?: unknown,
): DomainError {
  const durability = cause ? " and applied state could not be saved" : "";
  return new DomainError(
    "CONFLICT",
    `Change Set ${safeValue(changeSetId)} compensation conflicted${durability}; expected all completed writes to restore: ${safeValue(conflicts)}`,
    cause,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : safeValue(error);
}
