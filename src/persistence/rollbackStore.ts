import path from "path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RollbackRecord, RollbackStore } from "../agent/changeApplier";
import { DomainError, safeValue } from "../shared/errors";
import type { JsonFilePort } from "./chatStore";

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
});
const FileItemSchema = Type.Object(
  {
    kind: Type.Literal("file"),
    chatId: IdentifierSchema,
    snapshot: Type.Object(
      {
        relativePath: Type.String({ minLength: 1, maxLength: 10_000 }),
        bytesBase64: Type.String({ maxLength: 400_000 }),
        sha256: Type.String({ minLength: 1, maxLength: 128 }),
        mode: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    expectedAppliedSha256: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
const NoteItemSchema = Type.Object(
  {
    kind: Type.Literal("note"),
    noteId: IdentifierSchema,
    originalBody: Type.String({ maxLength: 10_000_000 }),
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const RollbackSchema = Type.Object(
  {
    runId: IdentifierSchema,
    chatId: IdentifierSchema,
    createdAt: Type.Number({ minimum: 0 }),
    items: Type.Array(Type.Union([FileItemSchema, NoteItemSchema]), {
      maxItems: 50,
    }),
  },
  { additionalProperties: false },
);
const IndexSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    records: Type.Array(
      Type.Object(
        { runId: IdentifierSchema, createdAt: Type.Number({ minimum: 0 }) },
        { additionalProperties: false },
      ),
      { maxItems: 10 },
    ),
  },
  { additionalProperties: false },
);

export class JsonRollbackStore implements RollbackStore {
  private readonly directory: string;
  private readonly indexPath: string;

  public constructor(
    dataDirectory: string,
    private readonly files: JsonFilePort,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = path.join(dataDirectory, "rollbacks");
    this.indexPath = path.join(this.directory, "index.json");
  }

  /**
   * Persists an applied run and prunes records older than seven days or newest ten.
   *
   * @example await store.save(rollbackRecord)
   */
  public async save(record: RollbackRecord): Promise<void> {
    assertRollback(record);
    await this.files.ensureDirectory(this.directory);
    await this.files.writeTextAtomic(
      this.recordPath(record.runId),
      stringify(record),
    );
    const index = await this.readIndex();
    const records = index.records.filter((item) => item.runId !== record.runId);
    records.push({ runId: record.runId, createdAt: record.createdAt });
    const retained = retainRecords(records, this.now());
    await this.removeEvicted(records, retained);
    await this.files.writeTextAtomic(
      this.indexPath,
      stringify({ schemaVersion: 1, records: retained }),
    );
  }

  /**
   * Loads one retained rollback record for approval-run Undo.
   *
   * @example await store.get(runId)
   */
  public async get(runId: string): Promise<RollbackRecord | null> {
    assertIdentifier(runId);
    const content = await this.files.readText(this.recordPath(runId));
    if (content === null) return null;
    const parsed = parseJson(content);
    if (!Value.Check(RollbackSchema, parsed)) {
      throw new DomainError(
        "VALIDATION",
        `Invalid rollback ${safeValue(runId)}; expected a schema-v1 rollback record`,
      );
    }
    return parsed;
  }

  private async readIndex(): Promise<Static<typeof IndexSchema>> {
    const content = await this.files.readText(this.indexPath);
    if (content === null) return { schemaVersion: 1, records: [] };
    const parsed = parseJson(content);
    if (Value.Check(IndexSchema, parsed)) return parsed;
    throw new DomainError(
      "VALIDATION",
      `Invalid rollback index ${safeValue(parsed)}; expected schema version 1`,
    );
  }

  private async removeEvicted(
    all: readonly { readonly runId: string }[],
    retained: readonly { readonly runId: string }[],
  ): Promise<void> {
    const kept = new Set(retained.map((record) => record.runId));
    for (const record of all) {
      if (!kept.has(record.runId)) {
        await this.files.removeFile(this.recordPath(record.runId));
      }
    }
  }

  private recordPath(runId: string): string {
    return path.join(this.directory, `${runId}.json`);
  }
}

function retainRecords(
  records: readonly { readonly runId: string; readonly createdAt: number }[],
  now: number,
): readonly { readonly runId: string; readonly createdAt: number }[] {
  const cutoff = now - 7 * 24 * 60 * 60 * 1_000;
  return records
    .filter((record) => record.createdAt >= cutoff)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 10);
}

function assertRollback(record: RollbackRecord): void {
  if (Value.Check(RollbackSchema, record)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid rollback ${safeValue(record)}; expected bounded note/file snapshots`,
  );
}

function assertIdentifier(runId: string): void {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(runId)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid run ID ${safeValue(runId)}; expected identifier characters`,
  );
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error: unknown) {
    throw new DomainError(
      "VALIDATION",
      "Invalid rollback JSON; expected a complete JSON object",
      error,
    );
  }
}

function stringify(input: unknown): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}
