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
  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [];
  }

  public async readNote(): Promise<NoteRecord> {
    throw new Error("Unexpected note read");
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [];
  }

  public async createNote(_input: CreateNoteInput): Promise<NoteRecord> {
    throw new Error("Unexpected note create");
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
});
