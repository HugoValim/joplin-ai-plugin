import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "../shared/errors";

const SecretNotebookStoreSchema = Type.Object(
  {
    notebookIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 500,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export interface JsonFilePort {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

/**
 * Persists plugin-global secret notebook IDs excluded from agent tools and RAG.
 *
 * @example await store.list()
 */
export class SecretNotebookStore {
  private readonly fileName = "secretNotebooks.json";
  private cached: ReadonlySet<string> | null = null;

  public constructor(private readonly files: JsonFilePort) {}

  public async list(): Promise<ReadonlySet<string>> {
    if (this.cached) return this.cached;
    const raw = await this.files.read(this.fileName);
    if (!raw) {
      this.cached = new Set();
      return this.cached;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new DomainError(
        "INTERNAL",
        `Invalid secret notebook store in ${this.fileName}; expected JSON object`,
        error,
      );
    }
    if (!Value.Check(SecretNotebookStoreSchema, parsed)) {
      throw new DomainError(
        "VALIDATION",
        `Invalid secret notebook store ${safeValue(parsed)}; expected { notebookIds: string[] }`,
      );
    }
    this.cached = new Set(parsed.notebookIds);
    return this.cached;
  }

  public async mark(notebookId: string): Promise<ReadonlySet<string>> {
    const ids = new Set(await this.list());
    ids.add(notebookId);
    await this.persist(ids);
    return ids;
  }

  public async unmark(notebookId: string): Promise<ReadonlySet<string>> {
    const ids = new Set(await this.list());
    ids.delete(notebookId);
    await this.persist(ids);
    return ids;
  }

  private async persist(ids: ReadonlySet<string>): Promise<void> {
    const payload = { notebookIds: [...ids].sort() };
    await this.files.write(this.fileName, JSON.stringify(payload, null, 2));
    this.cached = ids;
  }
}
