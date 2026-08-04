import type { ChangeSetStore } from "./changeSetStore";
import type { PersistedChat } from "./chatStore";

export class ChangeSetLifecycle {
  public constructor(private readonly changes: ChangeSetStore) {}

  /**
   * Recovers persisted Change Sets into the runtime store.
   *
   * @example lifecycle.recover(persistedChat)
   */
  public recover(chat: PersistedChat): void {
    if (chat.parkedAppliedChangeSet) {
      this.changes.restore(chat.parkedAppliedChangeSet);
    }
    if (chat.pendingChangeSet) {
      this.changes.restore(chat.pendingChangeSet);
    }
  }
}
