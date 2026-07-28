/**
 * Tracks live subagents spawned during a heavy agent run.
 * Caps concurrency at 3; further spawns are refused with a clear error.
 *
 * @example registry.tryStart("subtask-1") // true if under cap
 */
export class SubAgentRegistry {
  private readonly active = new Set<string>();
  private readonly capacity: number;

  public constructor(capacity = 3) {
    this.capacity = capacity;
  }

  /**
   * Starts a subagent when capacity allows.
   *
   * @example if (registry.tryStart("sub-1")) runSubAgent()
   */
  public tryStart(subAgentId: string): boolean {
    if (this.active.has(subAgentId)) return false;
    if (this.active.size >= this.capacity) return false;
    this.active.add(subAgentId);
    return true;
  }

  public complete(subAgentId: string): void {
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

  public cancelAll(): void {
    this.active.clear();
  }
}
