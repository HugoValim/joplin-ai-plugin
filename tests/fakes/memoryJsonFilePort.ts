import type { JsonFilePort } from "../../src/persistence/chatStore";

export class MemoryJsonFilePort implements JsonFilePort {
  public readonly files = new Map<string, string>();
  public readonly renamed: string[] = [];
  public readonly removed: string[] = [];

  public async ensureDirectory(): Promise<void> {
    return Promise.resolve();
  }

  public async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  public async writeTextAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  public async rename(source: string, destination: string): Promise<void> {
    const content = this.files.get(source);
    if (content === undefined) throw new Error(`Missing ${source}`);
    this.files.delete(source);
    this.files.set(destination, content);
    this.renamed.push(destination);
  }

  public async removeFile(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
  }
}
