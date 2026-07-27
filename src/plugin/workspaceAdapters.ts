import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  AtomicWritePort,
  FileCandidateFinder,
  FileSystemPort,
} from "../fileWorkspace/fileWorkspaceRepository";
import { FileWorkspaceRepository } from "../fileWorkspace/fileWorkspaceRepository";
import type { NoteRecord } from "../notes/retriever";
import type { ActiveNoteContextSource } from "../agent/contextBuilder";
import { DomainError, safeValue } from "../shared/errors";
import type { FileWorkspaceWriteResolver } from "../agent/changeApplier";
import type { FileWorkspaceResolver } from "../tools/fileTools";

interface WorkspacePort {
  selectedNote(): Promise<unknown>;
}

interface CommandPort {
  execute(commandName: string, ...args: unknown[]): Promise<unknown>;
}

const SelectedNoteSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    parent_id: Type.String({ maxLength: 128 }),
    title: Type.String({ maxLength: 100_000 }),
    body: Type.String({ maxLength: 10_000_000 }),
    updated_time: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);

export class JoplinActiveNoteContextSource implements ActiveNoteContextSource {
  public constructor(
    private readonly workspace: WorkspacePort,
    private readonly commands: CommandPort,
  ) {}

  public async activeNote(): Promise<NoteRecord | null> {
    const input = await this.workspace.selectedNote();
    if (input === null) return null;
    if (!Value.Check(SelectedNoteSchema, input)) {
      throw new DomainError(
        "VALIDATION",
        `Invalid selected note ${safeValue(input)}; expected Joplin note fields`,
      );
    }
    return {
      id: input.id,
      parentId: input.parent_id,
      title: input.title,
      body: input.body,
      updatedTime: input.updated_time,
    };
  }

  public async selectedText(): Promise<string> {
    const input = await this.commands.execute("selectedText");
    return typeof input === "string" ? input.slice(0, 20_000) : "";
  }
}

export class PerChatWorkspaceResolver
  implements FileWorkspaceResolver, FileWorkspaceWriteResolver
{
  private readonly repositories = new Map<string, FileWorkspaceRepository>();

  public constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly finder: FileCandidateFinder,
    private readonly writer: AtomicWritePort,
  ) {}

  /**
   * Associates one selected absolute folder with one chat.
   *
   * @example resolver.setRoot(chatId, '/home/user/docs')
   */
  public setRoot(chatId: string, root: string | null): void {
    if (root === null) {
      this.repositories.delete(chatId);
      return;
    }
    this.repositories.set(
      chatId,
      new FileWorkspaceRepository(
        root,
        this.fileSystem,
        this.finder,
        this.writer,
      ),
    );
  }

  public resolve(chatId: string): FileWorkspaceRepository | null {
    return this.repositories.get(chatId) ?? null;
  }
}
