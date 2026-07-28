import type { AgentContinuation } from "../agent/agentRunner";
import type { ContextCitation } from "../agent/contextBuilder";

export interface PendingAgentContinuation {
  readonly chatId: string;
  readonly hasFileWorkspace: boolean;
  readonly vault: boolean;
  readonly readableNoteIds: ReadonlySet<string>;
  readonly secretNotebookIds: ReadonlySet<string>;
  readonly continuation: AgentContinuation;
  readonly citations: readonly ContextCitation[];
}

export class AgentContinuationStore {
  private readonly pending = new Map<string, PendingAgentContinuation>();

  public save(
    changeSetId: string,
    continuation: PendingAgentContinuation,
  ): void {
    this.pending.set(changeSetId, continuation);
  }

  public take(changeSetId: string): PendingAgentContinuation | null {
    const continuation = this.pending.get(changeSetId) ?? null;
    this.pending.delete(changeSetId);
    return continuation;
  }

  public delete(changeSetId: string): void {
    this.pending.delete(changeSetId);
  }

  public deleteChat(chatId: string): void {
    for (const [changeSetId, pending] of this.pending) {
      if (pending.chatId === chatId) this.pending.delete(changeSetId);
    }
  }
}
