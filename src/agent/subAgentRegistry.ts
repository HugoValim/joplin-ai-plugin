/**
 * Tracks live subagents spawned during a heavy agent run.
 * Caps concurrency at 3; further spawns are refused with a clear error.
 * Each active entry owns an AbortController so parent cancel aborts children.
 *
 * @example registry.tryStart("subtask-1", controller) // true if under cap
 */
export class SubAgentRegistry {
  private readonly active = new Map<string, AbortController>();
  private readonly capacity: number;

  public constructor(capacity = 3) {
    this.capacity = capacity;
  }

  /**
   * Starts a subagent when capacity allows and records its AbortController.
   *
   * @example if (registry.tryStart("sub-1", controller)) runSubAgent()
   */
  public tryStart(subAgentId: string, controller: AbortController): boolean {
    if (this.active.has(subAgentId)) return false;
    if (this.active.size >= this.capacity) return false;
    this.active.set(subAgentId, controller);
    return true;
  }

  public complete(subAgentId: string): void {
    this.active.delete(subAgentId);
  }

  /**
   * Aborts one subagent (if live) and frees its slot.
   *
   * @example registry.abort("sub-1")
   */
  public abort(subAgentId: string, reason?: unknown): void {
    const controller = this.active.get(subAgentId);
    if (!controller) return;
    controller.abort(reason ?? new Error(`Subagent ${subAgentId} aborted`));
    this.active.delete(subAgentId);
  }

  public has(subAgentId: string): boolean {
    return this.active.has(subAgentId);
  }

  public get activeCount(): number {
    return this.active.size;
  }

  public get remaining(): number {
    return this.capacity - this.active.size;
  }

  /**
   * Aborts every live subagent and clears the registry.
   *
   * @example registry.cancelAll()
   */
  public cancelAll(reason?: unknown): void {
    const abortReason =
      reason ?? new Error("Parent run cancelled; aborting subagents");
    for (const controller of this.active.values()) {
      controller.abort(abortReason);
    }
    this.active.clear();
  }
}
