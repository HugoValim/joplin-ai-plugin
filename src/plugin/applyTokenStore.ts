import { randomBytes } from "crypto";

/**
 * Stores one-time apply tokens issued by the plugin for pending change sets.
 *
 * @example store.issue("changes-1")
 */
export class ApplyTokenStore {
  private readonly tokens = new Map<string, string>();

  public issue(changeSetId: string): string {
    const token = randomBytes(32).toString("hex");
    this.tokens.set(changeSetId, token);
    return token;
  }

  /**
   * Returns an existing token or issues a fresh one for snapshot reloads.
   *
   * @example store.ensure("changes-1")
   */
  public ensure(changeSetId: string): string {
    const existing = this.tokens.get(changeSetId);
    if (existing) return existing;
    return this.issue(changeSetId);
  }

  public verify(changeSetId: string, token: string): boolean {
    return this.tokens.get(changeSetId) === token;
  }

  public revoke(changeSetId: string): void {
    this.tokens.delete(changeSetId);
  }
}
