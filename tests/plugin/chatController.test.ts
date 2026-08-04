import type {
  ActiveNoteContextSource,
  NoteRetrievalPort,
} from "../../src/agent/contextBuilder";
import { ContextBuilder } from "../../src/agent/contextBuilder";
import {
  ChangeApplier,
  InMemoryRollbackStore,
} from "../../src/agent/changeApplier";
import { DomainError } from "../../src/shared/errors";
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
import { SecretNotebookStore } from "../../src/persistence/secretNotebookStore";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

class FailingRecoveryChatFilePort extends MemoryJsonFilePort {
  public failWrites = false;

  public override writeTextAtomic(
    path: string,
    content: string,
  ): Promise<void> {
    if (this.failWrites) {
      return Promise.reject(new Error("Chat persistence unavailable"));
    }
    return super.writeTextAtomic(path, content);
  }
}

class BlockingProvider implements AiProvider {
  public lastRequest: StreamChatRequest | null = null;
  private releaseRun: (() => void) | null = null;
  private markStarted: (() => void) | null = null;
  private readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private connectionOk = true;

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
    if (!this.connectionOk) {
      throw new Error("endpoint unreachable for connectivity check");
    }
    return Promise.resolve();
  }

  public async listModels(): Promise<readonly string[]> {
    if (!this.connectionOk) {
      throw new Error("endpoint unreachable for model list");
    }
    return [];
  }

  public async modelAvailable(): Promise<boolean> {
    return true;
  }

  public async contextWindow(): Promise<number | null> {
    return null;
  }

  public waitUntilStarted(): Promise<void> {
    return this.started;
  }

  public release(): void {
    this.releaseRun?.();
  }

  public setConnectionOk(ok: boolean): void {
    this.connectionOk = ok;
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

  public async listModels(): Promise<readonly string[]> {
    return [];
  }

  public async modelAvailable(): Promise<boolean> {
    return true;
  }

  public async contextWindow(): Promise<number | null> {
    return null;
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

  public async setValue(key: string, value: unknown): Promise<void> {
    SETTINGS_VALUES[key] = value;
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

class RecordingCommands implements CommandPort {
  public readonly calls: Array<{
    readonly name: string;
    readonly args: readonly unknown[];
  }> = [];

  public async execute(name: string, ...args: unknown[]): Promise<null> {
    this.calls.push({ name, args });
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

const SETTINGS_VALUES: Record<string, unknown> = {
  "joplinAiAgent.baseUrl": "http://localhost:11434/v1",
  "joplinAiAgent.apiKey": "api-key-should-never-appear",
  "joplinAiAgent.model": "glm-5.2:cloud",
  "joplinAiAgent.systemPrompt": "Be concise.",
  "joplinAiAgent.temperature": "0.2",
  "joplinAiAgent.maxOutputTokens": 2_000,
  "joplinAiAgent.timeoutMs": 120_000,
  "joplinAiAgent.allowInsecureRemote": false,
  "joplinAiAgent.allowedInsecureOrigin": "",
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

function createSecretNotebookStore(): SecretNotebookStore {
  const files = new Map<string, string>();
  return new SecretNotebookStore({
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      files.set(path, content);
    },
  });
}

describe("ChatController", () => {
  test("renders recovered journal changes as applied when chat persistence stays stale", async () => {
    const files = new FailingRecoveryChatFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Recovered review");
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add(chat.id, "run-recovered", {
      kind: "note",
      operation: "update",
      noteId: "note-1",
      targetLabel: "Guide",
      before: "Old",
      after: "New",
      expectedUpdatedTime: 1,
    });
    const changeSet = changes.getByRun("run-recovered");
    if (!changeSet) throw new Error("Expected recovery change set");
    await chats.save({
      ...chat,
      pendingChangeSet: changeSet,
      runSummaries: [
        {
          runId: changeSet.runId,
          status: "awaiting-approval",
          summary: "Changes proposed",
          completedAt: 1,
        },
      ],
    });
    const rollbacks = new InMemoryRollbackStore();
    await rollbacks.save({
      runId: changeSet.runId,
      chatId: chat.id,
      createdAt: Date.now(),
      items: [],
      application: {
        changeSetId: changeSet.id,
        state: "applying",
        acceptedChangeIds: [proposed.id],
      },
    });
    const panel = new RecordingPanel();
    const commands = new EmptyCommands();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const controller = new ChatController(
      panel,
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
        new EmptyNoteRepository(),
        workspaces,
        rollbacks,
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
    );
    files.failWrites = true;

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "select-recovered-chat",
      chatId: chat.id,
      type: "chat.select",
      payload: {},
    });

    const snapshot = [...panel.events]
      .reverse()
      .find((event) => event.type === "state.snapshot");
    if (snapshot?.type !== "state.snapshot") {
      throw new Error("Expected recovered snapshot");
    }
    expect(snapshot.payload.activeChat?.pendingChangeSet).toMatchObject({
      applyToken: "",
      changes: [{ id: proposed.id, status: "applied", undoable: true }],
    });
    expect(
      (await chats.get(chat.id))?.pendingChangeSet?.changes[0]?.status,
    ).toBe("proposed");
  });
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
      createSecretNotebookStore(),
      () => provider,
    );
    controller.workspaceChanged({
      id: "note-1",
      title: "Project brief",
      parentNotebookId: "nb-1",
    });
    expect(panel.events.at(-1)).toMatchObject({
      type: "workspace.changed",
      payload: {
        activeNote: {
          id: "note-1",
          title: "Project brief",
          parentNotebookId: "nb-1",
        },
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

  test("emits a snapshot with the user message before the model finishes", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Visible");
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
      createSecretNotebookStore(),
      () => provider,
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "select-1",
      chatId: chat.id,
      type: "chat.select",
      payload: {},
    });
    panel.events.length = 0;

    const running = controller.handle(
      submission(chat.id, "run-visible", "Reorganize my ESS notebooks"),
    );
    await provider.waitUntilStarted();

    const midRunSnapshot = panel.events
      .filter((event) => event.type === "state.snapshot")
      .at(-1);
    expect(midRunSnapshot).toMatchObject({ type: "state.snapshot" });
    if (midRunSnapshot?.type !== "state.snapshot") {
      throw new Error("Expected mid-run state.snapshot");
    }
    expect(midRunSnapshot.payload.activeChat?.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Reorganize my ESS notebooks",
      }),
    ]);

    provider.release();
    await running;
  });

  test("auto-applies note proposals when bypass permissions is enabled", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Automatic");
    await chats.save({
      ...chat,
      context: { ...chat.context, autoApply: true, vault: true },
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
      createSecretNotebookStore(),
      () => provider,
    );

    await controller.handle(submission(chat.id, "run-auto", "Create a note"));

    expect(notes.createdNotes.length).toBeGreaterThan(0);
    expect(
      panel.events.some((event) => event.type === "changes.proposed"),
    ).toBe(false);
    const pending = (await chats.get(chat.id))?.pendingChangeSet;
    expect(pending?.status).toBe("applied");
    expect(
      pending?.changes.every((change) => change.status === "applied"),
    ).toBe(true);
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
      createSecretNotebookStore(),
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
        interactionMode: "agent",
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
    expect(dialogs.messages[0]).toContain("Bypass permissions");
    expect(dialogs.messages[0]).toContain(
      "Deletions still require manual ChangeReview",
    );
    expect(dialogs.messages[0]).toContain("Keep/Undo");
  });

  test("keeps endpoint status online through a provider error during a busy run", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("StatusLock");
    const provider = new (class implements AiProvider {
      public async *streamChat(): AsyncIterable<ProviderEvent> {
        yield { type: "text-delta", delta: "partial" };
        throw new DomainError("PROVIDER", "transient provider failure");
      }
      public async testConnection(): Promise<void> {
        return Promise.resolve();
      }
      public async listModels(): Promise<readonly string[]> {
        return ["glm-5.2:cloud"];
      }
      public async modelAvailable(): Promise<boolean> {
        return true;
      }
      public async contextWindow(): Promise<number | null> {
        return null;
      }
    })();
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
      createSecretNotebookStore(),
      () => provider,
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "select-status",
      chatId: chat.id,
      type: "chat.select",
      payload: {},
    });
    panel.events.length = 0;

    // Run throws a PROVIDER error mid-stream. recordFailure runs while the run
    // is still registered (clearIfCurrent happens in finally, after). The
    // snapshot emitted by recordFailure must NOT report offline while busy.
    await controller.handle(submission(chat.id, "run-status", "Summarize"));

    const snapshots = panel.events.filter(
      (event) => event.type === "state.snapshot",
    );
    const failureSnapshot = snapshots.at(-1);
    if (failureSnapshot?.type !== "state.snapshot") {
      throw new Error("Expected a state.snapshot after the provider error");
    }
    expect(failureSnapshot.payload.endpointStatus).toBe("online");
  });

  test("marks endpoint online on first model step while the run is still busy", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("OnlineMidRun");
    const provider = new BlockingProvider();
    provider.setConnectionOk(false);
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
      createSecretNotebookStore(),
      () => provider,
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "select-offline",
      chatId: chat.id,
      type: "chat.select",
      payload: {},
    });
    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "force-offline-check",
      chatId: chat.id,
      type: "model.select",
      payload: { model: "glm-5.2:cloud" },
    });
    // model.select fires checkEndpoint without awaiting; wait for offline.
    await waitForSnapshotStatus(panel, "offline");
    provider.setConnectionOk(true);
    panel.events.length = 0;

    const run = controller.handle(
      submission(chat.id, "run-mid-online", "Start a long task"),
    );
    await provider.waitUntilStarted();
    await waitForSnapshotStatus(panel, "online");

    const midRunSnapshot = [...panel.events]
      .reverse()
      .find((event) => event.type === "state.snapshot");
    if (midRunSnapshot?.type !== "state.snapshot") {
      throw new Error("Expected a state.snapshot while the run was busy");
    }
    expect(midRunSnapshot.payload.endpointStatus).toBe("online");

    provider.release();
    await run;
  });

  test("attaches selected notes when context.attachDropped falls back to selection", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Drop");
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const commands = new EmptyCommands();
    const panel = new RecordingPanel();
    const controller = new ChatController(
      panel,
      chats,
      new ContextBuilder(
        new EmptyActiveNoteSource(),
        new EmptyRetrievalPort(),
        async () => null,
      ),
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new ChangeApplier(
        new InMemoryChangeSetStore(),
        new EmptyNoteRepository(),
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
      undefined,
      null,
      {
        selectedNoteIds: async () => ["note-drop-1", "note-drop-2"],
        selectedFolderId: async () => "nb-drop-1",
      },
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "drop-notes",
      chatId: chat.id,
      type: "context.attachDropped",
      payload: { kind: "auto" },
    });
    const saved = await chats.get(chat.id);
    expect(saved?.context.attachedNoteIds).toEqual([
      "note-drop-1",
      "note-drop-2",
    ]);
    expect(saved?.context.attachedNotebookIds ?? []).toEqual([]);
    expect(panel.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "context.dropped",
          payload: {
            hits: [
              { kind: "note", id: "note-drop-1", title: "note-drop-1" },
              { kind: "note", id: "note-drop-2", title: "note-drop-2" },
            ],
          },
        }),
      ]),
    );
  });

  test("attaches selected notebook when context.attachDropped has no selected notes", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Drop notebook");
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const commands = new EmptyCommands();
    const panel = new RecordingPanel();
    const controller = new ChatController(
      panel,
      chats,
      new ContextBuilder(
        new EmptyActiveNoteSource(),
        new EmptyRetrievalPort(),
        async () => null,
      ),
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new ChangeApplier(
        new InMemoryChangeSetStore(),
        new EmptyNoteRepository(),
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
      undefined,
      null,
      {
        selectedNoteIds: async () => [],
        selectedFolderId: async () => "nb-drop-9",
      },
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "drop-notebook",
      chatId: chat.id,
      type: "context.attachDropped",
      payload: { kind: "auto" },
    });
    const saved = await chats.get(chat.id);
    expect(saved?.context.attachedNoteIds).toEqual([]);
    expect(saved?.context.attachedNotebookIds).toEqual(["nb-drop-9"]);
    expect(panel.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "context.dropped",
          payload: {
            hits: [
              {
                kind: "notebook",
                id: "nb-drop-9",
                title: "nb-drop-9",
              },
            ],
          },
        }),
      ]),
    );
  });

  test("resolves explicit drop ids and emits context.dropped with titles", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Drop ids");
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const commands = new EmptyCommands();
    const panel = new RecordingPanel();
    const mentionSearch = {
      searchNotes: async () => [],
      listNotebooks: async () => [],
      listNotebookNotes: async () => [],
      readNote: async (noteId: string) => ({
        id: noteId,
        title: "Project brief",
        body: "",
        parentId: "nb-1",
        updatedTime: 1,
      }),
    };
    const controller = new ChatController(
      panel,
      chats,
      new ContextBuilder(
        new EmptyActiveNoteSource(),
        new EmptyRetrievalPort(),
        async () => null,
      ),
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new ChangeApplier(
        new InMemoryChangeSetStore(),
        new EmptyNoteRepository(),
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
      undefined,
      mentionSearch,
      {
        selectedNoteIds: async () => [],
        selectedFolderId: async () => null,
      },
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "drop-explicit",
      chatId: chat.id,
      type: "context.attachDropped",
      payload: { kind: "note", ids: ["note-abc"] },
    });
    expect(panel.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "context.dropped",
          payload: {
            hits: [{ kind: "note", id: "note-abc", title: "Project brief" }],
          },
        }),
      ]),
    );
  });

  test("opens safe external links via openItem and rejects unsafe urls", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Links");
    const commands = new RecordingCommands();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const controller = new ChatController(
      new RecordingPanel(),
      chats,
      new ContextBuilder(
        new EmptyActiveNoteSource(),
        new EmptyRetrievalPort(),
        async () => null,
      ),
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new ChangeApplier(
        new InMemoryChangeSetStore(),
        new EmptyNoteRepository(),
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "link-safe",
      chatId: chat.id,
      type: "link.open",
      payload: { url: "https://example.test/doc" },
    });
    expect(commands.calls).toEqual([
      { name: "openItem", args: ["https://example.test/doc"] },
    ]);

    await expect(
      controller.handle({
        version: PROTOCOL_VERSION,
        messageId: "link-bad",
        chatId: chat.id,
        type: "link.open",
        payload: { url: "javascript:alert(1)" },
      }),
    ).rejects.toThrow("expected an absolute http(s) URL");
    expect(commands.calls).toHaveLength(1);
  });

  test("attachSelectionRef uses explicit editor lines when body search would fail", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("ExplicitLines");
    const panel = new RecordingPanel();
    const commands = new EmptyCommands();
    const changes = new InMemoryChangeSetStore();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const controller = new ChatController(
      panel,
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
        new EmptyNoteRepository(),
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "select-explicit-lines",
      chatId: chat.id,
      type: "chat.select",
      payload: {},
    });
    await controller.attachSelectionRef({
      noteId: "note-1",
      title: "Guide",
      body: "saved body without live edits",
      selection: "live editor only text",
      startLine: 7,
      endLine: 25,
    });

    const saved = await chats.get(chat.id);
    expect(saved?.context.selectionRefs).toEqual([
      { noteId: "note-1", startLine: 7, endLine: 25 },
    ]);
    expect(panel.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "composer.selectionRef",
          payload: { title: "Guide", startLine: 7, endLine: 25 },
        }),
      ]),
    );
  });

  test("attachSelectionRef stores line range and posts composer.selectionRef", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Selection");
    const panel = new RecordingPanel();
    const commands = new EmptyCommands();
    const changes = new InMemoryChangeSetStore();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const controller = new ChatController(
      panel,
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
        new EmptyNoteRepository(),
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "select-selection-chat",
      chatId: chat.id,
      type: "chat.select",
      payload: {},
    });
    await controller.attachSelectionRef({
      noteId: "note-1",
      title: "Guide",
      body: "a\nb\nc",
      selection: "b\nc",
    });

    const saved = await chats.get(chat.id);
    expect(saved?.context.attachedNoteIds).toEqual(["note-1"]);
    expect(saved?.context.selectionRefs).toEqual([
      { noteId: "note-1", startLine: 2, endLine: 3 },
    ]);
    expect(panel.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "composer.selectionRef",
          chatId: chat.id,
          payload: { title: "Guide", startLine: 2, endLine: 3 },
        }),
      ]),
    );
  });

  test("attachSelectionRef falls back to the whole note range instead of a bare mention", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Unlocatable");
    const panel = new RecordingPanel();
    const commands = new EmptyCommands();
    const changes = new InMemoryChangeSetStore();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const controller = new ChatController(
      panel,
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
        new EmptyNoteRepository(),
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
    );

    await controller.handle({
      version: PROTOCOL_VERSION,
      messageId: "select-unlocatable-chat",
      chatId: chat.id,
      type: "chat.select",
      payload: {},
    });
    await controller.attachSelectionRef({
      noteId: "note-1",
      title: "Guide",
      body: "a\nb\nc\nd",
      selection: "rendered text that is not in the markdown source",
    });

    const saved = await chats.get(chat.id);
    expect(saved?.context.selectionRefs).toEqual([
      { noteId: "note-1", startLine: 1, endLine: 4 },
    ]);
    expect(panel.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "composer.selectionRef",
          payload: { title: "Guide", startLine: 1, endLine: 4 },
        }),
      ]),
    );
    expect(panel.events.some((event) => event.type === "context.dropped")).toBe(
      false,
    );
  });

  test("startNewChatWithSelection creates a chat and attaches the ref", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    await chats.create("Seed");
    const panel = new RecordingPanel();
    const commands = new EmptyCommands();
    const changes = new InMemoryChangeSetStore();
    const workspaces = new PerChatWorkspaceResolver(
      new FakeFileSystem(),
      new EmptyCandidateFinder(),
      new EmptyAtomicWriter(),
    );
    const controller = new ChatController(
      panel,
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
        new EmptyNoteRepository(),
        workspaces,
        new InMemoryRollbackStore(),
      ),
      workspaces,
      new FakeSettings(),
      new EmptyDialogs(),
      commands,
      new AssistantOutputActions(
        chats,
        new EmptyActiveNoteSource(),
        new EmptyNoteRepository(),
        commands,
      ),
      createSecretNotebookStore(),
      () => new BlockingProvider(),
    );

    await controller.startNewChatWithSelection({
      noteId: "note-9",
      title: "Spec",
      body: "one\ntwo\nthree",
      selection: "two",
    });

    const summaries = await chats.list();
    expect(summaries.length).toBe(2);
    const chatsWithRefs = await Promise.all(
      summaries.map(async (summary) => chats.get(summary.id)),
    );
    const created = chatsWithRefs.find(
      (entry) => (entry?.context.selectionRefs?.length ?? 0) > 0,
    );
    expect(created?.context.selectionRefs).toEqual([
      { noteId: "note-9", startLine: 2, endLine: 2 },
    ]);
    expect(panel.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "composer.selectionRef",
          payload: { title: "Spec", startLine: 2, endLine: 2 },
        }),
      ]),
    );
  });
});

async function waitForSnapshotStatus(
  panel: RecordingPanel,
  status: "online" | "offline" | "checking" | "unconfigured",
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const latest = [...panel.events]
      .reverse()
      .find((event) => event.type === "state.snapshot");
    if (
      latest?.type === "state.snapshot" &&
      latest.payload.endpointStatus === status
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for endpointStatus ${status}`);
}
