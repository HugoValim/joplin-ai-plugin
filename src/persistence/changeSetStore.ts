import { randomUUID } from "crypto";
import { createTwoFilesPatch } from "diff";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "../shared/errors";

interface ChangeProposalBase {
  readonly targetLabel: string;
  readonly before: string;
  readonly after: string;
}

export interface FileChangeProposalInput extends ChangeProposalBase {
  readonly kind: "file";
  readonly relativePath: string;
  readonly expectedSha256: string;
}

export interface NoteUpdateProposalInput extends ChangeProposalBase {
  readonly kind: "note";
  readonly operation: "update";
  readonly noteId: string;
  readonly expectedUpdatedTime: number;
}

export interface NoteCreateProposalInput extends ChangeProposalBase {
  readonly kind: "note";
  readonly operation: "create";
  readonly parentId: string;
  readonly title: string;
}

export interface NotebookCreateProposalInput extends ChangeProposalBase {
  readonly kind: "notebook";
  readonly operation: "create";
  readonly parentId: string;
  readonly title: string;
}

export interface NoteRenameProposalInput extends ChangeProposalBase {
  readonly kind: "note";
  readonly operation: "rename";
  readonly noteId: string;
  readonly expectedUpdatedTime: number;
  readonly title: string;
}

export interface NoteMoveProposalInput extends ChangeProposalBase {
  readonly kind: "note";
  readonly operation: "move";
  readonly noteId: string;
  readonly expectedUpdatedTime: number;
  readonly parentId: string;
}

export interface NoteReorderProposalInput extends ChangeProposalBase {
  readonly kind: "note";
  readonly operation: "reorder";
  readonly noteId: string;
  readonly expectedUpdatedTime: number;
  readonly order: number;
}

export interface NoteDeleteProposalInput extends ChangeProposalBase {
  readonly kind: "note";
  readonly operation: "delete";
  readonly noteId: string;
  readonly expectedUpdatedTime: number;
}

export interface NotebookRenameProposalInput extends ChangeProposalBase {
  readonly kind: "notebook";
  readonly operation: "rename";
  readonly notebookId: string;
  readonly expectedUpdatedTime: number;
  readonly title: string;
}

export interface NotebookMoveProposalInput extends ChangeProposalBase {
  readonly kind: "notebook";
  readonly operation: "move";
  readonly notebookId: string;
  readonly expectedUpdatedTime: number;
  readonly parentId: string;
}

export interface NotebookDeleteProposalInput extends ChangeProposalBase {
  readonly kind: "notebook";
  readonly operation: "delete";
  readonly notebookId: string;
  readonly expectedUpdatedTime: number;
}

export type ChangeProposalInput =
  | FileChangeProposalInput
  | NoteUpdateProposalInput
  | NoteCreateProposalInput
  | NotebookCreateProposalInput
  | NoteRenameProposalInput
  | NoteMoveProposalInput
  | NoteReorderProposalInput
  | NoteDeleteProposalInput
  | NotebookRenameProposalInput
  | NotebookMoveProposalInput
  | NotebookDeleteProposalInput;

interface ProposedChangeBase extends ChangeProposalBase {
  readonly id: string;
  readonly diff: string;
  readonly status: "proposed" | "applied" | "conflict" | "skipped";
  readonly message?: string;
}

export type ProposedChange =
  | (ProposedChangeBase & FileChangeProposalInput)
  | (ProposedChangeBase & NoteUpdateProposalInput)
  | (ProposedChangeBase & NoteCreateProposalInput)
  | (ProposedChangeBase & NotebookCreateProposalInput)
  | (ProposedChangeBase & NoteRenameProposalInput)
  | (ProposedChangeBase & NoteMoveProposalInput)
  | (ProposedChangeBase & NoteReorderProposalInput)
  | (ProposedChangeBase & NoteDeleteProposalInput)
  | (ProposedChangeBase & NotebookRenameProposalInput)
  | (ProposedChangeBase & NotebookMoveProposalInput)
  | (ProposedChangeBase & NotebookDeleteProposalInput);

export interface ChangeSet {
  readonly id: string;
  readonly chatId: string;
  readonly runId: string;
  readonly createdAt: number;
  readonly status: "proposed" | "applied" | "partial" | "discarded";
  readonly changes: readonly ProposedChange[];
  readonly reviewNoteId?: string;
}

export interface ChangeSetScope {
  readonly chatId: string;
  readonly runId: string;
}

const ChangeBaseSchema = {
  id: Type.String({ minLength: 1, maxLength: 128 }),
  targetLabel: Type.String({ minLength: 1, maxLength: 10_000 }),
  before: Type.String({ maxLength: 10_000_000 }),
  after: Type.String({ maxLength: 10_000_000 }),
  diff: Type.String({ maxLength: 20_000_000 }),
  status: Type.Union([
    Type.Literal("proposed"),
    Type.Literal("applied"),
    Type.Literal("conflict"),
    Type.Literal("skipped"),
  ]),
  message: Type.Optional(Type.String({ maxLength: 10_000 })),
};
const FileChangeSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("file"),
    relativePath: Type.String({ minLength: 1, maxLength: 10_000 }),
    expectedSha256: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
const NoteUpdateSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("note"),
    operation: Type.Literal("update"),
    noteId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NoteCreateSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("note"),
    operation: Type.Literal("create"),
    parentId: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
const NotebookCreateSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("notebook"),
    operation: Type.Literal("create"),
    parentId: Type.String({ maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
const NoteRenameSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("note"),
    operation: Type.Literal("rename"),
    noteId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedUpdatedTime: Type.Number({ minimum: 0 }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
const NoteMoveSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("note"),
    operation: Type.Literal("move"),
    noteId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedUpdatedTime: Type.Number({ minimum: 0 }),
    parentId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
const NoteReorderSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("note"),
    operation: Type.Literal("reorder"),
    noteId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedUpdatedTime: Type.Number({ minimum: 0 }),
    order: Type.Number(),
  },
  { additionalProperties: false },
);
const NoteDeleteSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("note"),
    operation: Type.Literal("delete"),
    noteId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const NotebookRenameSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("notebook"),
    operation: Type.Literal("rename"),
    notebookId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedUpdatedTime: Type.Number({ minimum: 0 }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
const NotebookMoveSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("notebook"),
    operation: Type.Literal("move"),
    notebookId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedUpdatedTime: Type.Number({ minimum: 0 }),
    parentId: Type.String({ maxLength: 128 }),
  },
  { additionalProperties: false },
);
const NotebookDeleteSchema = Type.Object(
  {
    ...ChangeBaseSchema,
    kind: Type.Literal("notebook"),
    operation: Type.Literal("delete"),
    notebookId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedUpdatedTime: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export const ChangeSetSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    chatId: Type.String({ minLength: 1, maxLength: 128 }),
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    createdAt: Type.Number({ minimum: 0 }),
    status: Type.Union([
      Type.Literal("proposed"),
      Type.Literal("applied"),
      Type.Literal("partial"),
      Type.Literal("discarded"),
    ]),
    changes: Type.Array(
      Type.Union([
        FileChangeSchema,
        NoteUpdateSchema,
        NoteCreateSchema,
        NotebookCreateSchema,
        NoteRenameSchema,
        NoteMoveSchema,
        NoteReorderSchema,
        NoteDeleteSchema,
        NotebookRenameSchema,
        NotebookMoveSchema,
        NotebookDeleteSchema,
      ]),
      { maxItems: 50 },
    ),
    reviewNoteId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);

export interface ChangeSetStore {
  add(
    chatId: string,
    runId: string,
    input: ChangeProposalInput,
  ): ProposedChange;
  get(changeSetId: string): ChangeSet | null;
  getByRun(runId: string): ChangeSet | null;
  getScoped(changeSetId: string, scope: ChangeSetScope): ChangeSet;
  discard(changeSetId: string, scope: ChangeSetScope): ChangeSet;
  setResults(
    changeSetId: string,
    results: readonly ProposedChange[],
  ): ChangeSet;
  removeChanges(
    changeSetId: string,
    changeIds: readonly string[],
    scope: ChangeSetScope,
  ): ChangeSet | null;
  attachReviewNote(changeSetId: string, reviewNoteId: string): ChangeSet;
  restore(changeSet: ChangeSet): void;
}

export class InMemoryChangeSetStore implements ChangeSetStore {
  private readonly sets = new Map<string, ChangeSet>();
  private readonly idsByRun = new Map<string, string>();

  /**
   * Adds one proposal to the run's single review batch.
   *
   * @example store.add(chatId, runId, fileProposal)
   */
  public add(
    chatId: string,
    runId: string,
    input: ChangeProposalInput,
  ): ProposedChange {
    const current = this.getOrCreate(chatId, runId);
    const change = createProposedChange(input);
    this.sets.set(current.id, {
      ...current,
      changes: [...current.changes, change],
    });
    return change;
  }

  /**
   * Returns an immutable view of one change set.
   *
   * @example store.get(changeSetId)
   */
  public get(changeSetId: string): ChangeSet | null {
    const changeSet = this.sets.get(changeSetId);
    return changeSet ? cloneChangeSet(changeSet) : null;
  }

  /**
   * Finds the single proposal batch for a model run.
   *
   * @example store.getByRun(runId)
   */
  public getByRun(runId: string): ChangeSet | null {
    const changeSetId = this.idsByRun.get(runId);
    return changeSetId ? this.get(changeSetId) : null;
  }

  /**
   * Loads a batch only when its owning chat and run match the request.
   *
   * @example store.getScoped(changeSetId, { chatId, runId })
   */
  public getScoped(changeSetId: string, scope: ChangeSetScope): ChangeSet {
    const changeSet = this.require(changeSetId);
    assertScope(changeSet, scope);
    return cloneChangeSet(changeSet);
  }

  /**
   * Marks a pending batch discarded without applying writes.
   *
   * @example store.discard(changeSetId, { chatId, runId })
   */
  public discard(changeSetId: string, scope: ChangeSetScope): ChangeSet {
    const current = this.getScoped(changeSetId, scope);
    if (current.status !== "proposed") {
      throw new DomainError(
        "NOT_AVAILABLE",
        `Change set ${safeValue(changeSetId)} has status ${current.status}; expected proposed status`,
      );
    }
    const discarded = { ...current, status: "discarded" as const };
    this.sets.set(changeSetId, discarded);
    return cloneChangeSet(discarded);
  }

  /**
   * Stores independent apply/conflict results for all reviewed items.
   *
   * @example store.setResults(changeSetId, results)
   */
  public setResults(
    changeSetId: string,
    results: readonly ProposedChange[],
  ): ChangeSet {
    const current = this.require(changeSetId);
    const allApplied = results.every((result) => result.status === "applied");
    const next: ChangeSet = {
      ...current,
      status: allApplied ? "applied" : "partial",
      changes: [...results],
    };
    this.sets.set(changeSetId, next);
    return cloneChangeSet(next);
  }

  /**
   * Drops reviewed items from an applied/partial set after Keep or Undo.
   *
   * @example store.removeChanges(changeSetId, ["change-1"], scope)
   */
  public removeChanges(
    changeSetId: string,
    changeIds: readonly string[],
    scope: ChangeSetScope,
  ): ChangeSet | null {
    const current = this.getScoped(changeSetId, scope);
    if (current.status !== "applied" && current.status !== "partial") {
      throw new DomainError(
        "NOT_AVAILABLE",
        `Change set ${safeValue(changeSetId)} has status ${current.status}; expected applied or partial status`,
      );
    }
    const remove = new Set(changeIds);
    const remaining = current.changes.filter(
      (change) => !remove.has(change.id),
    );
    if (remaining.length === current.changes.length) {
      const unknown = changeIds.find(
        (changeId) => !current.changes.some((change) => change.id === changeId),
      );
      throw new DomainError(
        "VALIDATION",
        `Unknown kept change ${safeValue(unknown)}; expected an ID in change set ${changeSetId}`,
      );
    }
    if (remaining.length === 0) {
      this.sets.delete(changeSetId);
      return null;
    }
    const next: ChangeSet = { ...current, changes: remaining };
    this.sets.set(changeSetId, next);
    return cloneChangeSet(next);
  }

  /**
   * Records the temporary Review Note id for a pending batch.
   *
   * @example store.attachReviewNote(changeSetId, noteId)
   */
  public attachReviewNote(
    changeSetId: string,
    reviewNoteId: string,
  ): ChangeSet {
    const current = this.require(changeSetId);
    const next = { ...current, reviewNoteId };
    this.sets.set(changeSetId, next);
    return cloneChangeSet(next);
  }

  /**
   * Restores one validated pending batch loaded from local chat persistence.
   *
   * @example store.restore(persistedChangeSet)
   */
  public restore(changeSet: ChangeSet): void {
    if (!Value.Check(ChangeSetSchema, changeSet)) {
      throw new DomainError(
        "VALIDATION",
        `Invalid change set ${safeValue(changeSet)}; expected a schema-v1 proposal batch`,
      );
    }
    this.sets.set(changeSet.id, cloneChangeSet(changeSet));
    this.idsByRun.set(changeSet.runId, changeSet.id);
  }

  private getOrCreate(chatId: string, runId: string): ChangeSet {
    const existing = this.getByRun(runId);
    if (existing) return existing;
    const created: ChangeSet = {
      id: randomUUID(),
      chatId,
      runId,
      createdAt: Date.now(),
      status: "proposed",
      changes: [],
    };
    this.sets.set(created.id, created);
    this.idsByRun.set(runId, created.id);
    return created;
  }

  private require(changeSetId: string): ChangeSet {
    const changeSet = this.sets.get(changeSetId);
    if (changeSet) return changeSet;
    throw new DomainError(
      "NOT_AVAILABLE",
      `Unknown change set ${safeValue(changeSetId)}; expected a pending change set ID`,
    );
  }
}

function createProposedChange(input: ChangeProposalInput): ProposedChange {
  const targetPath = proposalTarget(input);
  return {
    ...input,
    id: randomUUID(),
    diff: createTwoFilesPatch(
      `${targetPath}:before`,
      `${targetPath}:after`,
      input.before,
      input.after,
      "current",
      "proposed",
      { context: 3 },
    ),
    status: "proposed",
  };
}

function proposalTarget(input: ChangeProposalInput): string {
  if (input.kind === "file") return input.relativePath;
  if (input.operation === "create") return input.title;
  return input.kind === "note" ? input.noteId : input.notebookId;
}

function assertScope(changeSet: ChangeSet, scope: ChangeSetScope): void {
  if (changeSet.chatId === scope.chatId && changeSet.runId === scope.runId) {
    return;
  }
  throw new DomainError(
    "SECURITY",
    `Change set ${changeSet.id} belongs to chat ${changeSet.chatId} run ${changeSet.runId}; expected chat ${scope.chatId} run ${scope.runId}`,
  );
}

function cloneChangeSet(changeSet: ChangeSet): ChangeSet {
  return {
    ...changeSet,
    changes: changeSet.changes.map((change) => ({ ...change })),
  };
}
