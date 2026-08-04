import type { ChangeSet, ChangeSetStore } from "./changeSetStore";
import type { ChatStore, PersistedChat } from "./chatStore";

export interface ChangeSetRecoveryPort {
  resolvePendingRollbackMerge(
    chatId: string,
    parkedRunId: string | null,
  ): Promise<void>;
  retainedAppliedChangeIds(
    runId: string,
    chatId: string,
  ): Promise<readonly string[]>;
}

export class ChangeSetRecovery {
  public constructor(
    private readonly changes: ChangeSetStore,
    private readonly chats: ChatStore,
    private readonly revokeApproval: (changeSetId: string) => void,
  ) {}

  public async recover(
    chat: PersistedChat,
    recovery?: ChangeSetRecoveryPort,
  ): Promise<ChangeSet | null> {
    await recovery?.resolvePendingRollbackMerge(
      chat.id,
      chat.parkedAppliedChangeSet?.runId ?? null,
    );
    if (chat.parkedAppliedChangeSet) {
      this.changes.restore(chat.parkedAppliedChangeSet);
    }
    if (!chat.pendingChangeSet) return null;
    this.changes.restore(chat.pendingChangeSet);
    const recovered = await this.lockProposal(chat.pendingChangeSet, recovery);
    if (recovered !== chat.pendingChangeSet) {
      await this.persistPresentation(chat, recovered);
    }
    return recovered;
  }

  private async lockProposal(
    pending: ChangeSet,
    recovery: ChangeSetRecoveryPort | undefined,
  ): Promise<ChangeSet> {
    if (pending.status !== "proposed" || !recovery) return pending;
    const retained = await recovery.retainedAppliedChangeIds(
      pending.runId,
      pending.chatId,
    );
    if (retained.length === 0) return pending;
    const results = recoveredResults(pending, new Set(retained));
    const recovered = this.changes.setResults(pending.id, results);
    this.revokeApproval(pending.id);
    return recovered;
  }

  private async persistPresentation(
    chat: PersistedChat,
    recovered: ChangeSet,
  ): Promise<void> {
    try {
      await this.chats.save(recoveredChat(chat, recovered));
    } catch {
      // The write-ahead rollback journal remains the recovery authority.
    }
  }
}

function recoveredResults(
  pending: ChangeSet,
  appliedIds: ReadonlySet<string>,
): ChangeSet["changes"] {
  return pending.changes.map((change) =>
    appliedIds.has(change.id)
      ? { ...change, status: "applied" as const }
      : {
          ...change,
          status: "conflict" as const,
          message: "Not applied before durability recovery",
        },
  );
}

function recoveredChat(
  chat: PersistedChat,
  recovered: ChangeSet,
): PersistedChat {
  return {
    ...chat,
    pendingChangeSet: recovered,
    runSummaries: chat.runSummaries.map((summary) =>
      summary.runId === recovered.runId
        ? { ...summary, status: "applied" }
        : summary,
    ),
  };
}
