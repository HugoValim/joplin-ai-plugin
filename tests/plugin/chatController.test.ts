import type {
  ActiveNoteContextSource,
  NoteRetrievalPort,
} from "../../src/agent/contextBuilder";
import { ContextBuilder } from "../../src/agent/contextBuilder";
import {
  ChangeApplier,
  InMemoryRollbackStore,
} from "../../src/agent/changeApplier";
import type {
  AtomicWritePort,
  FileCandidateFinder,
  FileMetadata,
  FileSystemPort,
} from "../../src/fileWorkspace/fileWorkspaceRepository";
import type {
  CreateNoteInput,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NoteSnippet,
  NotebookRecord,
  UpdateNoteBodyInput,
} from "../../src/notes/retriever";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { ChatStore } from "../../src/persistence/chatStore";
import type {
  AiProvider,
  ProviderEvent,
  StreamChatRequest,
} from "../../src/providers/types";
import { AssistantOutputActions } from "../../src/plugin/assistantOutputActions";
import { ChatController } from "../../src/plugin/chatController";
import type { PanelPort } from "../../src/plugin/panelPort";
import type { SettingsPort } from "../../src/plugin/settings";
import type { CommandPort, DialogPort } from "../../src/plugin/types";
import { PerChatWorkspaceResolver } from "../../src/plugin/workspaceAdapters";
import {
  PROTOCOL_VERSION,
  type PanelRequest,
  type PluginEvent,
} from "../../src/shared/protocol";
import { ToolRegistry } from "../../src/tools/toolRegistry";
import { registerNoteTools } from "../../src/tools/noteTools";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

class BlockingProvider implements AiProvider {
  public lastRequest: StreamChatRequest | null = null;
  private releaseRun: (() => void) | null = null;
  private markStarted: (() => void) | null = null;
  private readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  public async *streamChat(
    request: StreamChatRequest,
    _abortSignal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.lastRequest = request;
    this.markStarted?.();
    await new Promise<void>((resolve) => {
      this.releaseRun = resolve;
    });
    yield { type: "text-delta", delta: "Done" };
    yield { type: "completed", finishReason: "stop" };
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }

  public waitUntilStarted(): Promise<void> {
    return this.started;
  }

  public release(): void {
    this.releaseRun?.();
  }
}

class ProposalThenCompletionProvider implements AiProvider {
  public callCount = 0;
  public readonly requests: StreamChatRequest[] = [];

  public async *streamChat(
    request: StreamChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.callCount += 1;
    this.requests.push(request);
    if (this.callCount <= 2) {
      yield {
        type: "tool-calls",
        calls: [
          {
            id: `tool-create-${this.callCount}`,
            name: "create_note",
            arguments: {
              parent_id: "folder-1",
              title: `Automatic note ${this.callCount}`,
              body: `Applied batch ${this.callCount} without review.`,
            },
          },
        ],
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", delta: "Automatic apply complete." };
    yield { type: "completed", finishReason: "stop" };
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }
}

class EmptyActiveNoteSource implements ActiveNoteContextSource {
  public async activeNote(): Promise<null> {
    return null;
  }

  public async selectedText(): Promise<string> {
    return "";
  }
}

class EmptyRetrievalPort implements NoteRetrievalPort {
  public async retrieve(): Promise<readonly NoteSnippet[]> {
    return [];
  }
}

class EmptyNoteRepository implements NoteRepository {
  public readonly createdNotes: NoteRecord[] = [];

  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [];
  }

  public async readNote(): Promise<NoteRecord> {
    throw new Error("Unexpected note read");
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [];
  }

  public async createNote(input: CreateNoteInput): Promise<NoteRecord> {
    const note = {
      id: `created-${this.createdNotes.length + 1}`,
      parentId: input.parentId,
      title: input.title,
      body: input.body,
      updatedTime: 1,
    };
    this.createdNotes.push(note);
    return note;
  }

  public async updateNoteBody(
    _input: UpdateNoteBodyInput,
  ): Promise<NoteRecord> {
    throw new Error("Unexpected note update");
  }
}

class FakeFileSystem implements FileSystemPort {
  public async realpath(inputPath: string): Promise<string> {
    return inputPath;
  }

  public async stat(): Promise<FileMetadata> {
    return { size: 0, mode: 0o644, isFile: true };
  }

  public async readFile(): Promise<Buffer> {
    return Buffer.from("");
  }
}

class EmptyCandidateFinder implements FileCandidateFinder {
  public async find(): Promise<readonly string[]> {
    return [];
  }
}

class EmptyAtomicWriter implements AtomicWritePort {
  public async write(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeSettings implements SettingsPort {
  public async registerSection(): Promise<void> {
    return Promise.resolve();
  }

  public async registerSettings(): Promise<void> {
    return Promise.resolve();
  }

  public async values(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      keys.map((key) => [key, SETTINGS_VALUES[key] ?? ""]),
    );
  }

  public async setValue(): Promise<void> {
    return Promise.resolve();
  }
}

class EmptyDialogs implements DialogPort {
  public async showOpenDialog(): Promise<null> {
    return null;
  }

  public async showMessageBox(): Promise<number> {
    return 1;
  }
}

class RecordingDialogs implements DialogPort {
  public readonly messages: string[] = [];
  public choice = 1;

  public async showOpenDialog(): Promise<null> {
    return null;
  }

  public async showMessageBox(message: string): Promise<number> {
    this.messages.push(message);
    return this.choice;
  }
}

class EmptyCommands implements CommandPort {
  public async execute(): Promise<null> {
    return null;
  }
}

class RecordingPanel implements PanelPort {
  public readonly events: PluginEvent[] = [];

  public async initialize(): Promise<void> {
    return Promise.resolve();
  }

  public post(event: PluginEvent): void {
    this.events.push(event);
  }
}

const SETTINGS_VALUES: Readonly<Record<string, unknown>> = {
  "joplinAiAgent.baseUrl": "http://localhost:11434/v1",
  "joplinAiAgent.apiKey": "api-key-should-never-appear",
  "joplinAiAgent.model": "glm-5.2:cloud",
  "joplinAiAgent.systemPrompt": "Be concise.",
  "joplinAiAgent.temperature": "0.2",
  "joplinAiAgent.maxOutputTokens": 2_000,
  "joplinAiAgent.timeoutMs": 120_000,
  "joplinAiAgent.allowInsecureRemote": false,
};

function submission(
  chatId: string,
  runId: string,
  text: string,
): Extract<PanelRequest, { type: "chat.submit" }> {
  return {
    version: PROTOCOL_VERSION,
    messageId: `message-${runId}`,
    chatId,
    runId,
    type: "chat.submit",
    payload: { text },
  };
}

describe("ChatController", () => {
  test("rejects a concurrent same-chat run before persisting its message", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Concurrent");
    const provider = new BlockingProvider();
    const notes = new EmptyNoteRepository();
    const source = new EmptyActiveNoteSource();
    const changes = new InMemoryChangeSetStore();
    const panel = new RecordingPanel();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const commands = new EmptyCommands();
    const controller = new ChatController(
      panel,
      chats,
      new ContextBuilder(source, new EmptyRetrievalPort(), async () => null),
      new ToolRegistry(),
      changes,
      new ChangeApplier(
        changes,
        notes,
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(chats, source, notes, commands),
      () => provider,
    );
    controller.workspaceChanged({ id: "note-1", title: "Project brief" });
    expect(panel.events.at(-1)).toMatchObject({
      type: "workspace.changed",
      payload: {
        activeNote: { id: "note-1", title: "Project brief" },
      },
    });
    expect(JSON.stringify(panel.events.at(-1))).not.toContain("body");

    const first = controller.handle(submission(chat.id, "run-1", "First"));
    await provider.waitUntilStarted();

    await expect(
      controller.handle(submission(chat.id, "run-2", "Second")),
    ).rejects.toThrow("expected one run at a time");
    expect((await chats.get(chat.id))?.messages).toHaveLength(1);
    expect(provider.lastRequest?.messages[0]?.content).toContain(
      'Configured model ID: "glm-5.2:cloud".',
    );
    expect(JSON.stringify(provider.lastRequest)).not.toContain(
      "api-key-should-never-appear",
    );

    provider.release();
    await first;
  });

  test("automatically applies every proposal batch and continues the model", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Automatic");
    await chats.save({
      ...chat,
      context: { ...chat.context, autoApply: true },
    });
    const provider = new ProposalThenCompletionProvider();
    const notes = new EmptyNoteRepository();
    const changes = new InMemoryChangeSetStore();
    const tools = new ToolRegistry();
    registerNoteTools(tools, notes, changes);
    const panel = new RecordingPanel();
    const source = new EmptyActiveNoteSource();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const commands = new EmptyCommands();
    const controller = new ChatController(
      panel,
      chats,
      new ContextBuilder(source, new EmptyRetrievalPort(), async () => null),
      tools,
      changes,
      new ChangeApplier(
        changes,
        notes,
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(chats, source, notes, commands),
      () => provider,
    );

    await controller.handle(submission(chat.id, "run-auto", "Create a note"));

    expect(notes.createdNotes.map((note) => note.body)).toEqual([
      "Applied batch 1 without review.",
      "Applied batch 2 without review.",
    ]);
    expect(provider.callCount).toBe(3);
    expect(
      provider.requests[1]?.messages.some((message) =>
        message.content.includes("automatic application was enabled"),
      ),
    ).toBe(true);
    expect(JSON.stringify(provider.requests)).not.toContain("user reviewed");
    expect((await chats.get(chat.id))?.pendingChangeSet).toBeNull();
    expect(
      panel.events.some((event) => event.type === "changes.proposed"),
    ).toBe(false);
    expect(panel.events.at(-2)).toMatchObject({
      type: "run.completed",
      payload: { summary: "Changes applied; continuation completed" },
    });
  });

  test("requires trusted confirmation before enabling automatic apply", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Permission");
    const notes = new EmptyNoteRepository();
    const changes = new InMemoryChangeSetStore();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const dialogs = new RecordingDialogs();
    const commands = new EmptyCommands();
    const controller = new ChatController(
      new RecordingPanel(),
      chats,
      new ContextBuilder(
        new EmptyActiveNoteSource(),
        new EmptyRetrievalPort(),
        async () => null,
      ),
      new ToolRegistry(),
      changes,
      new ChangeApplier(
        changes,
        notes,
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      dialogs,
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        notes,
        commands,
      ),
      () => new ProposalThenCompletionProvider(),
    );
    const update = (autoApply: boolean): PanelRequest => ({
      version: PROTOCOL_VERSION,
      messageId: `context-${autoApply}`,
      chatId: chat.id,
      type: "context.update",
      payload: {
        activeNote: true,
        vault: false,
        autoApply,
        attachedNoteIds: [],
      },
    });

    await controller.handle(update(true));
    expect((await chats.get(chat.id))?.context.autoApply).toBe(false);

    dialogs.choice = 0;
    await controller.handle(update(true));
    expect((await chats.get(chat.id))?.context.autoApply).toBe(true);

    await controller.handle(update(false));
    expect((await chats.get(chat.id))?.context.autoApply).toBe(false);
    expect(dialogs.messages).toHaveLength(2);
    expect(dialogs.messages[0]).toContain("non-delete model-proposed");
    expect(dialogs.messages[0]).toContain(
      "Deletions always require manual review",
    );
  });
});
