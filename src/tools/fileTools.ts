import { Type, type TSchema } from "@sinclair/typebox";
import type {
  TextFileSnapshot,
  TextSearchMatch,
} from "../fileWorkspace/fileWorkspaceRepository";
import type { ChangeSetStore } from "../persistence/changeSetStore";
import { DomainError, safeValue } from "../shared/errors";
import type {
  ToolRegistry,
  AgentTool,
  ToolExecutionContext,
  ToolRisk,
} from "./toolRegistry";

export interface FileWorkspacePort {
  listTextFiles(): Promise<readonly TextFileSnapshot[]>;
  readTextFile(relativePath: string): Promise<TextFileSnapshot>;
  searchTextFiles(query: string): Promise<readonly TextSearchMatch[]>;
}

export interface FileWorkspaceResolver {
  resolve(chatId: string): FileWorkspacePort | null;
}

const PathSchema = Type.String({ minLength: 1, maxLength: 10_000 });
const HashSchema = Type.String({ minLength: 1, maxLength: 128 });
const ProposalOutputSchema = Type.Object(
  { change_id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

interface ProposalOutput {
  readonly change_id: string;
}

abstract class FileTool<TInput, TOutput> implements AgentTool<TInput, TOutput> {
  public abstract readonly name: string;
  public abstract readonly description: string;
  public abstract readonly risk: ToolRisk;
  public abstract readonly classification: AgentTool<
    TInput,
    TOutput
  >["classification"];
  public abstract readonly inputSchema: TSchema;
  public abstract readonly outputSchema: TSchema;

  public isAvailable(context: ToolExecutionContext): boolean {
    return context.hasFileWorkspace;
  }

  public abstract execute(
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<TOutput>;
}

class ListTextFilesTool extends FileTool<Record<string, never>, object> {
  public readonly name = "list_text_files";
  public readonly description =
    "List eligible text files in the selected chat folder.";
  public readonly risk = "read" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    files: Type.Array(
      Type.Object({
        relative_path: PathSchema,
        byte_length: Type.Integer(),
        sha256: HashSchema,
      }),
    ),
    total_bytes: Type.Integer(),
  });

  public constructor(private readonly resolver: FileWorkspaceResolver) {
    super();
  }

  public async execute(
    _input: Record<string, never>,
    context: ToolExecutionContext,
  ): Promise<object> {
    const files = await requireWorkspace(
      this.resolver,
      context,
    ).listTextFiles();
    return {
      files: files.map((file) => ({
        relative_path: file.relativePath,
        byte_length: file.byteLength,
        sha256: file.sha256,
      })),
      total_bytes: totalBytes(files),
    };
  }
}

interface ReadFileInput {
  readonly relative_path: string;
}

class ReadTextFileTool extends FileTool<ReadFileInput, object> {
  public readonly name = "read_text_file";
  public readonly description =
    "Read one eligible UTF-8 text file from the selected folder.";
  public readonly risk = "read" as const;
  public readonly classification = "content-read" as const;
  public readonly inputSchema = Type.Object(
    { relative_path: PathSchema },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    relative_path: PathSchema,
    content: Type.String(),
    sha256: HashSchema,
  });

  public constructor(private readonly resolver: FileWorkspaceResolver) {
    super();
  }

  public async execute(
    input: ReadFileInput,
    context: ToolExecutionContext,
  ): Promise<object> {
    const file = await requireWorkspace(this.resolver, context).readTextFile(
      input.relative_path,
    );
    return {
      relative_path: file.relativePath,
      content: file.content,
      sha256: file.sha256,
    };
  }
}

interface SearchFilesInput {
  readonly query: string;
}

class SearchTextFilesTool extends FileTool<SearchFilesInput, object> {
  public readonly name = "search_text_files";
  public readonly description = "Search eligible files in the selected folder.";
  public readonly risk = "read" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    { query: Type.String({ minLength: 1, maxLength: 10_000 }) },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    matches: Type.Array(
      Type.Object({
        relative_path: PathSchema,
        line: Type.Integer(),
        preview: Type.String(),
      }),
    ),
  });

  public constructor(private readonly resolver: FileWorkspaceResolver) {
    super();
  }

  public async execute(
    input: SearchFilesInput,
    context: ToolExecutionContext,
  ): Promise<object> {
    const matches = await requireWorkspace(
      this.resolver,
      context,
    ).searchTextFiles(input.query);
    return {
      matches: matches.map((match) => ({
        relative_path: match.relativePath,
        line: match.line,
        preview: match.preview,
      })),
    };
  }
}

interface ReplaceFileInput {
  readonly relative_path: string;
  readonly expected_sha256: string;
  readonly replacement: string;
}

class ProposeFileReplacementTool extends FileTool<
  ReplaceFileInput,
  ProposalOutput
> {
  public readonly name = "propose_file_replacement";
  public readonly description = "Propose replacing one versioned text file.";
  public readonly risk = "propose-write" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = replacementSchema();
  public readonly outputSchema = ProposalOutputSchema;

  public constructor(
    private readonly resolver: FileWorkspaceResolver,
    private readonly changes: ChangeSetStore,
  ) {
    super();
  }

  public async execute(
    input: ReplaceFileInput,
    context: ToolExecutionContext,
  ): Promise<ProposalOutput> {
    const file = await requireWorkspace(this.resolver, context).readTextFile(
      input.relative_path,
    );
    assertHash(file, input.expected_sha256);
    return addFileChange(this.changes, context, file, input.replacement);
  }
}

interface ReplaceFileTextInput extends ReplaceFileInput {
  readonly search: string;
  readonly replace_all?: boolean;
}

class ProposeFileTextReplacementTool extends FileTool<
  ReplaceFileTextInput,
  ProposalOutput
> {
  public readonly name = "propose_file_text_replacement";
  public readonly description =
    "Propose an exact replacement in one versioned text file.";
  public readonly risk = "propose-write" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {
      relative_path: PathSchema,
      expected_sha256: HashSchema,
      search: Type.String({ minLength: 1, maxLength: 100_000 }),
      replacement: Type.String({ maxLength: 1_000_000 }),
      replace_all: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = ProposalOutputSchema;

  public constructor(
    private readonly resolver: FileWorkspaceResolver,
    private readonly changes: ChangeSetStore,
  ) {
    super();
  }

  public async execute(
    input: ReplaceFileTextInput,
    context: ToolExecutionContext,
  ): Promise<ProposalOutput> {
    const file = await requireWorkspace(this.resolver, context).readTextFile(
      input.relative_path,
    );
    assertHash(file, input.expected_sha256);
    const matches = file.content.split(input.search).length - 1;
    assertExactMatches(input.search, matches, input.replace_all);
    const after = input.replace_all
      ? file.content.split(input.search).join(input.replacement)
      : file.content.replace(input.search, input.replacement);
    return addFileChange(this.changes, context, file, after);
  }
}

interface BulkEdit {
  readonly relative_path: string;
  readonly expected_sha256: string;
  readonly replacement: string;
}

interface ReviewFilesInput {
  readonly edits: readonly BulkEdit[];
}

interface ReviewFilesOutput {
  readonly file_count: number;
  readonly total_bytes: number;
  readonly change_ids: readonly string[];
}

class ReviewTextFilesTool extends FileTool<
  ReviewFilesInput,
  ReviewFilesOutput
> {
  public readonly name = "review_text_files";
  public readonly description =
    "Preflight and collect a bounded multi-file prose review without writing.";
  public readonly risk = "propose-write" as const;
  public readonly classification = "other" as const;
  public readonly inputSchema = Type.Object(
    {
      edits: Type.Array(replacementSchema(), {
        minItems: 1,
        maxItems: 50,
      }),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    file_count: Type.Integer(),
    total_bytes: Type.Integer(),
    change_ids: Type.Array(Type.String()),
  });

  public constructor(
    private readonly resolver: FileWorkspaceResolver,
    private readonly changes: ChangeSetStore,
  ) {
    super();
  }

  public async execute(
    input: ReviewFilesInput,
    context: ToolExecutionContext,
  ): Promise<ReviewFilesOutput> {
    assertDistinctEdits(input.edits);
    const files = await requireWorkspace(
      this.resolver,
      context,
    ).listTextFiles();
    const byPath = new Map(files.map((file) => [file.relativePath, file]));
    const changeIds = input.edits.map((edit) => {
      const file = byPath.get(edit.relative_path);
      if (!file) throw missingPreflightFile(edit.relative_path);
      assertHash(file, edit.expected_sha256);
      return addFileChange(this.changes, context, file, edit.replacement)
        .change_id;
    });
    return {
      file_count: files.length,
      total_bytes: totalBytes(files),
      change_ids: changeIds,
    };
  }
}

/**
 * Registers root-confined reads and policy-gated file proposal tools.
 *
 * @example registerFileTools(registry, workspaceResolver, changeSetStore)
 */
export function registerFileTools(
  registry: ToolRegistry,
  resolver: FileWorkspaceResolver,
  changes: ChangeSetStore,
): void {
  registry.register(new ListTextFilesTool(resolver));
  registry.register(new SearchTextFilesTool(resolver));
  registry.register(new ReadTextFileTool(resolver));
  registry.register(new ProposeFileReplacementTool(resolver, changes));
  registry.register(new ProposeFileTextReplacementTool(resolver, changes));
  registry.register(new ReviewTextFilesTool(resolver, changes));
}

function replacementSchema(): TSchema {
  return Type.Object(
    {
      relative_path: PathSchema,
      expected_sha256: HashSchema,
      replacement: Type.String({ maxLength: 1_000_000 }),
    },
    { additionalProperties: false },
  );
}

function requireWorkspace(
  resolver: FileWorkspaceResolver,
  context: ToolExecutionContext,
): FileWorkspacePort {
  const workspace = resolver.resolve(context.chatId);
  if (workspace) return workspace;
  throw new DomainError(
    "NOT_AVAILABLE",
    `Chat ${context.chatId} has no file workspace; expected a selected folder`,
  );
}

function assertHash(file: TextFileSnapshot, expected: string): void {
  if (file.sha256 === expected) return;
  throw new DomainError(
    "CONFLICT",
    `File ${file.relativePath} has SHA-256 ${file.sha256}; expected SHA-256 ${expected}`,
  );
}

function assertExactMatches(
  search: string,
  matches: number,
  replaceAll?: boolean,
): void {
  if (matches === 1 || (replaceAll && matches > 0)) return;
  throw new DomainError(
    "VALIDATION",
    `Replacement search ${safeValue(search)} found ${matches} matches; expected exactly 1 or replace_all=true`,
  );
}

function addFileChange(
  changes: ChangeSetStore,
  context: ToolExecutionContext,
  file: TextFileSnapshot,
  after: string,
): ProposalOutput {
  assertMarkdownPreserved(file, after);
  const change = changes.add(context.chatId, context.runId, {
    kind: "file",
    relativePath: file.relativePath,
    expectedSha256: file.sha256,
    targetLabel: file.relativePath,
    before: file.content,
    after,
  });
  return { change_id: change.id };
}

function totalBytes(files: readonly TextFileSnapshot[]): number {
  return files.reduce((sum, file) => sum + file.byteLength, 0);
}

function missingPreflightFile(relativePath: string): DomainError {
  return new DomainError(
    "CONFLICT",
    `File ${safeValue(relativePath)} was absent from scan preflight; expected an eligible unchanged file`,
  );
}

function assertDistinctEdits(edits: readonly BulkEdit[]): void {
  const paths = new Set<string>();
  for (const edit of edits) {
    if (!paths.has(edit.relative_path)) {
      paths.add(edit.relative_path);
      continue;
    }
    throw new DomainError(
      "VALIDATION",
      `Duplicate bulk edit ${safeValue(edit.relative_path)}; expected one replacement per file`,
    );
  }
}

function assertMarkdownPreserved(
  file: TextFileSnapshot,
  replacement: string,
): void {
  if (!/\.mdx?$/i.test(file.relativePath)) return;
  const before = markdownProtectionSignature(file.content);
  const after = markdownProtectionSignature(replacement);
  if (before === after) return;
  throw new DomainError(
    "VALIDATION",
    `Replacement for ${file.relativePath} changes protected Markdown structure; expected unchanged front matter, code fences, link targets, and tables`,
  );
}

function markdownProtectionSignature(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  return JSON.stringify({
    frontMatter: normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/)?.[0] ?? "",
    fences:
      normalized.match(/^ {0,3}(`{3,}|~{3,}).*$[\s\S]*?^ {0,3}\1\s*$/gm) ?? [],
    links: linkTargets(normalized),
    tables: tableShapes(normalized),
  });
}

function linkTargets(markdown: string): readonly string[] {
  const inline = [
    ...markdown.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))/g),
  ].map((match) => match[1] ?? match[2] ?? "");
  const references = [
    ...markdown.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm),
  ].map((match) => match[1] ?? match[2] ?? "");
  return [...inline, ...references];
}

function tableShapes(markdown: string): readonly string[] {
  return markdown
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const pipes = [...line].filter((character) => character === "|").length;
      return `${pipes}:${/^\s*\|?(?:\s*:?-+:?\s*\|)+/.test(line)}`;
    });
}
