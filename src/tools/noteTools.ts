import { Type, type TSchema } from "@sinclair/typebox";
import type { NoteRecord, NoteRepository } from "../notes/retriever";
import type { ChangeSetStore } from "../persistence/changeSetStore";
import { DomainError, safeValue } from "../shared/errors";
import type {
  ToolRegistry,
  AgentTool,
  ToolExecutionContext,
  ToolRisk,
} from "./toolRegistry";
import {
  assertNoteReadable,
  assertNotebookAllowed,
  filterAllowedNotebooks,
  filterAllowedNotes,
  noteScopedToolsEnabled,
  vaultOrgToolsEnabled,
} from "./noteAccessPolicy";

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 });
const ProposalOutputSchema = Type.Object(
  { change_id: IdentifierSchema },
  { additionalProperties: false },
);

interface ProposalOutput {
  readonly change_id: string;
}

abstract class NoteTool<TInput, TOutput> implements AgentTool<TInput, TOutput> {
  public abstract readonly name: string;
  public abstract readonly description: string;
  public abstract readonly risk: ToolRisk;
  public abstract readonly classification: AgentTool<
    TInput,
    TOutput
  >["classification"];
  public abstract readonly inputSchema: TSchema;
  public abstract readonly outputSchema: TSchema;

  public abstract isAvailable(context: ToolExecutionContext): boolean;

  public abstract execute(
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<TOutput>;
}

interface SearchNotesInput {
  readonly query: string;
  readonly limit?: number;
}

interface SearchNotesOutput {
  readonly notes: readonly {
    readonly id: string;
    readonly title: string;
    readonly updated_time: number;
  }[];
}

class SearchNotesTool extends NoteTool<SearchNotesInput, SearchNotesOutput> {
  public readonly name = "search_notes";
  public readonly description =
    "Search note titles and metadata in the Joplin vault.";
  public readonly risk = "read" as const;
  public readonly classification = "discovery" as const;
  public readonly inputSchema = Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: 10_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    notes: Type.Array(
      Type.Object({
        id: IdentifierSchema,
        title: Type.String(),
        updated_time: Type.Number(),
      }),
    ),
  });

  public constructor(private readonly repository: NoteRepository) {
    super();
  }

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public async execute(
    input: SearchNotesInput,
    context: ToolExecutionContext,
  ): Promise<SearchNotesOutput> {
    const hits = await this.repository.searchNotes(input.query, input.limit ?? 10);
    const enriched = await Promise.all(
      hits.map(async (hit) => {
        const note = await this.repository.readNote(hit.id);
        return { ...hit, parentId: note.parentId };
      }),
    );
    const notes = filterAllowedNotes(context, enriched);
    return {
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        updated_time: note.updatedTime,
      })),
    };
  }
}

interface ReadNoteInput {
  readonly note_id: string;
}

interface ReadNoteOutput {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly updated_time: number;
  readonly truncated: boolean;
}

class ReadNoteTool extends NoteTool<ReadNoteInput, ReadNoteOutput> {
  public readonly name = "read_note";
  public readonly description = "Read one Joplin note by opaque note ID.";
  public readonly risk = "read" as const;
  public readonly classification = "content-read" as const;
  public readonly inputSchema = Type.Object(
    { note_id: IdentifierSchema },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    id: IdentifierSchema,
    title: Type.String(),
    body: Type.String(),
    updated_time: Type.Number(),
    truncated: Type.Boolean(),
  });

  public constructor(private readonly repository: NoteRepository) {
    super();
  }

  public override isAvailable(context: ToolExecutionContext): boolean {
    return noteScopedToolsEnabled(context);
  }

  public async execute(
    input: ReadNoteInput,
    context: ToolExecutionContext,
  ): Promise<ReadNoteOutput> {
    const note = await this.repository.readNote(input.note_id);
    assertNoteReadable(context, input.note_id, note.parentId);
    return {
      id: note.id,
      title: note.title,
      body: note.body.slice(0, 100_000),
      updated_time: note.updatedTime,
      truncated: note.body.length > 100_000,
    };
  }
}

interface NotebookOutput {
  readonly notebooks: readonly {
    readonly id: string;
    readonly title: string;
    readonly parent_id: string;
  }[];
}

class ListNotebooksTool extends NoteTool<
  Record<string, never>,
  NotebookOutput
> {
  public readonly name = "list_notebooks";
  public readonly description = "List available Joplin notebooks.";
  public readonly risk = "read" as const;
  public readonly classification = "discovery" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    notebooks: Type.Array(
      Type.Object({
        id: IdentifierSchema,
        title: Type.String(),
        parent_id: Type.String(),
      }),
    ),
  });

  public constructor(private readonly repository: NoteRepository) {
    super();
  }

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public async execute(
    _input: Record<string, never>,
    context: ToolExecutionContext,
  ): Promise<NotebookOutput> {
    const notebooks = filterAllowedNotebooks(
      context,
      await this.repository.listNotebooks(),
    );
    return {
      notebooks: notebooks.map((notebook) => ({
        id: notebook.id,
        title: notebook.title,
        parent_id: notebook.parentId,
      })),
    };
  }
}

interface CreateNoteToolInput {
  readonly parent_id: string;
  readonly title: string;
  readonly body: string;
}

class CreateNoteTool extends NoteTool<CreateNoteToolInput, ProposalOutput> {
  public readonly name = "create_note";
  public readonly description =
    "Propose creating a Markdown note for batch approval.";
  public readonly risk = "propose-write" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {
      parent_id: IdentifierSchema,
      title: Type.String({ minLength: 1, maxLength: 500 }),
      body: Type.String({ maxLength: 1_000_000 }),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = ProposalOutputSchema;

  public constructor(private readonly changes: ChangeSetStore) {
    super();
  }

  public override isAvailable(_context: ToolExecutionContext): boolean {
    return vaultOrgToolsEnabled();
  }

  public execute(
    input: CreateNoteToolInput,
    context: ToolExecutionContext,
  ): Promise<ProposalOutput> {
    assertNotebookAllowed(context, input.parent_id);
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "note",
      operation: "create",
      parentId: input.parent_id,
      title: input.title,
      targetLabel: input.title,
      before: "",
      after: input.body,
    });
    return Promise.resolve({ change_id: change.id });
  }
}

interface AppendNoteInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
  readonly markdown: string;
}

class AppendNoteTool extends NoteTool<AppendNoteInput, ProposalOutput> {
  public readonly name = "append_note_markdown";
  public readonly description =
    "Propose appending Markdown to a versioned note.";
  public readonly risk = "propose-write" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: IdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
      markdown: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = ProposalOutputSchema;

  public constructor(
    private readonly repository: NoteRepository,
    private readonly changes: ChangeSetStore,
  ) {
    super();
  }

  public override isAvailable(context: ToolExecutionContext): boolean {
    return noteScopedToolsEnabled(context);
  }

  public async execute(
    input: AppendNoteInput,
    context: ToolExecutionContext,
  ): Promise<ProposalOutput> {
    const note = await this.repository.readNote(input.note_id);
    assertNoteReadable(context, input.note_id, note.parentId);
    assertNoteVersion(note, input.expected_updated_time);
    const separator = note.body.endsWith("\n") ? "" : "\n";
    return addNoteUpdate(
      this.changes,
      context,
      note,
      `${note.body}${separator}${input.markdown}`,
    );
  }
}

interface ReplaceNoteInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
  readonly search: string;
  readonly replacement: string;
  readonly replace_all?: boolean;
}

class ReplaceNoteTool extends NoteTool<ReplaceNoteInput, ProposalOutput> {
  public readonly name = "replace_note_text";
  public readonly description =
    "Propose an exact text replacement in a versioned note.";
  public readonly risk = "propose-write" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: IdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
      search: Type.String({ minLength: 1, maxLength: 100_000 }),
      replacement: Type.String({ maxLength: 1_000_000 }),
      replace_all: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = ProposalOutputSchema;

  public constructor(
    private readonly repository: NoteRepository,
    private readonly changes: ChangeSetStore,
  ) {
    super();
  }

  public override isAvailable(context: ToolExecutionContext): boolean {
    return noteScopedToolsEnabled(context);
  }

  public async execute(
    input: ReplaceNoteInput,
    context: ToolExecutionContext,
  ): Promise<ProposalOutput> {
    const note = await this.repository.readNote(input.note_id);
    assertNoteReadable(context, input.note_id, note.parentId);
    assertNoteVersion(note, input.expected_updated_time);
    const matches = exactMatchCount(note.body, input.search);
    assertReplacementCount(input, matches);
    const after = input.replace_all
      ? note.body.split(input.search).join(input.replacement)
      : note.body.replace(input.search, input.replacement);
    return addNoteUpdate(this.changes, context, note, after);
  }
}

interface ReplaceNoteBodyInput {
  readonly note_id: string;
  readonly expected_updated_time: number;
  readonly body: string;
}

class ReplaceNoteBodyTool extends NoteTool<
  ReplaceNoteBodyInput,
  ProposalOutput
> {
  public readonly name = "replace_note_body";
  public readonly description =
    "Propose replacing an entire note body after reading it. Prefer replace_note_text for small exact edits.";
  public readonly risk = "propose-write" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: IdentifierSchema,
      expected_updated_time: Type.Number({ minimum: 0 }),
      body: Type.String({ maxLength: 1_000_000 }),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = ProposalOutputSchema;

  public constructor(
    private readonly repository: NoteRepository,
    private readonly changes: ChangeSetStore,
  ) {
    super();
  }

  public override isAvailable(context: ToolExecutionContext): boolean {
    return noteScopedToolsEnabled(context);
  }

  public async execute(
    input: ReplaceNoteBodyInput,
    context: ToolExecutionContext,
  ): Promise<ProposalOutput> {
    const note = await this.repository.readNote(input.note_id);
    assertNoteReadable(context, input.note_id, note.parentId);
    assertNoteVersion(note, input.expected_updated_time);
    return addNoteUpdate(this.changes, context, note, input.body);
  }
}

/**
 * Registers bounded Joplin reads and policy-gated note proposal tools.
 *
 * @example registerNoteTools(registry, repository, changeSetStore)
 */
export function registerNoteTools(
  registry: ToolRegistry,
  repository: NoteRepository,
  changes: ChangeSetStore,
): void {
  registry.register(new SearchNotesTool(repository));
  registry.register(new ReadNoteTool(repository));
  registry.register(new ListNotebooksTool(repository));
  registry.register(new CreateNoteTool(changes));
  registry.register(new AppendNoteTool(repository, changes));
  registry.register(new ReplaceNoteTool(repository, changes));
  registry.register(new ReplaceNoteBodyTool(repository, changes));
}

function assertNoteVersion(note: NoteRecord, expected: number): void {
  if (note.updatedTime === expected) return;
  throw new DomainError(
    "CONFLICT",
    `Note ${note.id} has updated_time ${note.updatedTime}; expected updated_time ${expected}`,
  );
}

function exactMatchCount(content: string, search: string): number {
  return content.split(search).length - 1;
}

function assertReplacementCount(
  input: ReplaceNoteInput,
  matches: number,
): void {
  if (matches === 1 || (input.replace_all && matches > 0)) return;
  throw new DomainError(
    "VALIDATION",
    `Replacement search ${safeValue(input.search)} found ${matches} matches; expected exactly 1 or replace_all=true`,
  );
}

function addNoteUpdate(
  changes: ChangeSetStore,
  context: ToolExecutionContext,
  note: NoteRecord,
  after: string,
): ProposalOutput {
  const change = changes.add(context.chatId, context.runId, {
    kind: "note",
    operation: "update",
    noteId: note.id,
    expectedUpdatedTime: note.updatedTime,
    targetLabel: note.title,
    before: note.body,
    after,
  });
  return { change_id: change.id };
}
