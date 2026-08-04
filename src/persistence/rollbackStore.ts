import path from "path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  RollbackMergeJournal,
  RollbackRecord,
  RollbackStore,
} from "../agent/changeApplier";
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
    changeId: IdentifierSchema,
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
    changeId: IdentifierSchema,
    noteId: IdentifierSchema,
    originalBody: Type.String({ maxLength: 10_000_000 }),
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NoteCreateItemSchema = Type.Object(
  {
    kind: Type.Literal("note-create"),
    changeId: IdentifierSchema,
    noteId: IdentifierSchema,
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NotebookCreateItemSchema = Type.Object(
  {
    kind: Type.Literal("notebook-create"),
    changeId: IdentifierSchema,
    notebookId: IdentifierSchema,
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NoteMetadataSchema = Type.Object(
  {
    id: IdentifierSchema,
    title: Type.String({ maxLength: 100_000 }),
    parentId: IdentifierSchema,
    updatedTime: Type.Number({ minimum: 0 }),
    order: Type.Number(),
  },
  { additionalProperties: false },
);
const NotebookMetadataSchema = Type.Object(
  {
    id: IdentifierSchema,
    title: Type.String({ maxLength: 100_000 }),
    parentId: Type.String({ maxLength: 128 }),
    updatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NoteMetadataItemSchema = Type.Object(
  {
    kind: Type.Literal("note-metadata"),
    changeId: IdentifierSchema,
    original: NoteMetadataSchema,
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NotebookMetadataItemSchema = Type.Object(
  {
    kind: Type.Literal("notebook-metadata"),
    changeId: IdentifierSchema,
    original: NotebookMetadataSchema,
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NoteTrashItemSchema = Type.Object(
  {
    kind: Type.Literal("note-trash"),
    changeId: IdentifierSchema,
    original: NoteMetadataSchema,
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NotebookTrashItemSchema = Type.Object(
  {
    kind: Type.Literal("notebook-trash"),
    changeId: IdentifierSchema,
    original: NotebookMetadataSchema,
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NoteRestoreItemSchema = Type.Object(
  {
    kind: Type.Literal("note-restore"),
    changeId: IdentifierSchema,
    original: Type.Object(
      {
        id: IdentifierSchema,
        title: Type.String({ maxLength: 100_000 }),
        parentId: IdentifierSchema,
        updatedTime: Type.Number({ minimum: 0 }),
        order: Type.Number(),
        deletedTime: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NotebookRestoreItemSchema = Type.Object(
  {
    kind: Type.Literal("notebook-restore"),
    changeId: IdentifierSchema,
    original: Type.Object(
      {
        id: IdentifierSchema,
        title: Type.String({ maxLength: 100_000 }),
        parentId: Type.String({ maxLength: 128 }),
        updatedTime: Type.Number({ minimum: 0 }),
        deletedTime: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    expectedAppliedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const ApplicationResultSchema = Type.Object(
  {
    changeId: IdentifierSchema,
    status: Type.Union([
      Type.Literal("applied"),
      Type.Literal("conflict"),
      Type.Literal("skipped"),
    ]),
  },
  { additionalProperties: false },
);
const ApplicationJournalSchema = Type.Object(
  {
    changeSetId: IdentifierSchema,
    state: Type.Union([Type.Literal("applying"), Type.Literal("applied")]),
    acceptedChangeIds: Type.Array(IdentifierSchema, { maxItems: 100 }),
    results: Type.Optional(
      Type.Array(ApplicationResultSchema, { maxItems: 100 }),
    ),
  },
  { additionalProperties: false },
);
const RollbackSchema = Type.Object(
  {
    runId: IdentifierSchema,
    chatId: IdentifierSchema,
    createdAt: Type.Number({ minimum: 0 }),
    items: Type.Array(
      Type.Union([
        FileItemSchema,
        NoteItemSchema,
        NoteCreateItemSchema,
        NotebookCreateItemSchema,
        NoteMetadataItemSchema,
        NotebookMetadataItemSchema,
        NoteTrashItemSchema,
        NotebookTrashItemSchema,
        NoteRestoreItemSchema,
        NotebookRestoreItemSchema,
      ]),
      { maxItems: 100 },
    ),
    application: Type.Optional(ApplicationJournalSchema),
  },
  { additionalProperties: false },
);
const MergeJournalSchema = Type.Object(
  {
    targetRunId: IdentifierSchema,
    sourceRunId: IdentifierSchema,
    chatId: IdentifierSchema,
    target: Type.Union([RollbackSchema, Type.Null()]),
    source: RollbackSchema,
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
  private readonly mergeJournalPath: string;

  public constructor(
    dataDirectory: string,
    private readonly files: JsonFilePort,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = path.join(dataDirectory, "rollbacks");
    this.indexPath = path.join(this.directory, "index.json");
    this.mergeJournalPath = path.join(this.directory, "merge-journal.json");
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
    await this.assertNoPendingMerge();
    return this.readRecord(runId);
  }

  private async readRecord(runId: string): Promise<RollbackRecord | null> {
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

  /**
   * Removes one rollback record and its index entry.
   *
   * @example await store.remove(runId)
   */
  public async remove(runId: string): Promise<void> {
    assertIdentifier(runId);
    await this.files.removeFile(this.recordPath(runId));
    const index = await this.readIndex();
    const records = index.records.filter((record) => record.runId !== runId);
    await this.files.writeTextAtomic(
      this.indexPath,
      stringify({ schemaVersion: 1, records }),
    );
  }

  /** Persists both pre-merge owners before either rollback record changes. */
  public async beginMerge(journal: RollbackMergeJournal): Promise<void> {
    await this.assertNoPendingMerge();
    if (!Value.Check(MergeJournalSchema, journal)) {
      throw new DomainError(
        "VALIDATION",
        `Invalid rollback merge ${safeValue(journal)}; expected bounded pre-merge records`,
      );
    }
    await this.files.ensureDirectory(this.directory);
    await this.files.writeTextAtomic(this.mergeJournalPath, stringify(journal));
  }

  /** Clears a merge journal only after the owning chat save succeeds. */
  public pendingMerge(): Promise<RollbackMergeJournal | null> {
    return this.readMergeJournal();
  }

  public async commitPendingMerge(
    targetRunId: string,
    sourceRunId: string,
  ): Promise<void> {
    const journal = await this.readMergeJournal();
    if (!journal) return;
    if (
      journal.targetRunId !== targetRunId ||
      journal.sourceRunId !== sourceRunId
    ) {
      throw new DomainError(
        "CONFLICT",
        `Rollback merge ${safeValue([targetRunId, sourceRunId])} does not own the pending journal`,
      );
    }
    await this.files.removeFile(this.mergeJournalPath);
  }

  /** Restores pre-merge ownership from an interrupted merge transaction. */
  public async rollbackPendingMerge(): Promise<void> {
    const journal = await this.readMergeJournal();
    if (!journal) return;
    if (journal.target) await this.save(journal.target);
    else await this.remove(journal.targetRunId);
    await this.save(journal.source);
    await this.files.removeFile(this.mergeJournalPath);
  }

  private async readMergeJournal(): Promise<RollbackMergeJournal | null> {
    const content = await this.files.readText(this.mergeJournalPath);
    if (content === null) return null;
    const parsed = parseJson(content);
    if (Value.Check(MergeJournalSchema, parsed)) return parsed;
    throw new DomainError(
      "VALIDATION",
      "Invalid rollback merge journal; expected complete pre-merge records",
    );
  }

  private async assertNoPendingMerge(): Promise<void> {
    const journal = await this.readMergeJournal();
    if (!journal) return;
    throw new DomainError(
      "CONFLICT",
      `Rollback merge ${safeValue([journal.targetRunId, journal.sourceRunId])} is pending; expected lifecycle recovery`,
    );
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
    `Invalid rollback ${safeValue(record)}; expected bounded compensation records`,
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
