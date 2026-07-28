import type {
  AiProvider,
  ProviderEvent,
  StreamChatRequest,
} from "../../src/providers/types";
import {
  ChangeApplier,
  InMemoryRollbackStore,
  type FileWorkspaceWritePort,
  type FileWorkspaceWriteResolver,
} from "../../src/agent/changeApplier";
import type {
  FileRollbackSnapshot,
  TextFileSnapshot,
  TextSearchMatch,
} from "../../src/fileWorkspace/fileWorkspaceRepository";
import type {
  CreateNoteInput,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NotebookRecord,
  UpdateNoteBodyInput,
} from "../../src/notes/retriever";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { ChatStore } from "../../src/persistence/chatStore";
import { ApprovalWorkflow } from "../../src/plugin/approvalWorkflow";
import type { PanelPort } from "../../src/plugin/panelPort";
import { PluginEventSender } from "../../src/plugin/pluginEventSender";
import { RunCancellationRegistry } from "../../src/plugin/runCancellationRegistry";
import type { PluginEvent } from "../../src/shared/protocol";
import { ToolRegistry } from "../../src/tools/toolRegistry";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

class MutableNoteRepository implements NoteRepository {
  public readonly createdNotes: NoteRecord[] = [];
  public note: NoteRecord = {
    id: "note-1",
    parentId: "folder-1",
    title: "Guide",
    body: "Old",
    updatedTime: 10,
  };

  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [];
  }

  public async readNote(): Promise<NoteRecord> {
    return this.note;
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [];
  }

  public async createNote(input: CreateNoteInput): Promise<NoteRecord> {
    const created = {
      id: `note-${this.createdNotes.length + 2}`,
      parentId: input.parentId,
      title: input.title,
      body: input.body,
      updatedTime: 1,
    };
    this.createdNotes.push(created);
    return created;
  }

  public async updateNoteBody(input: UpdateNoteBodyInput): Promise<NoteRecord> {
    if (this.note.updatedTime !== input.expectedUpdatedTime) {
      throw new Error("Concurrent note change");
    }
    this.note = { ...this.note, body: input.body, updatedTime: 11 };
    return this.note;
  }
}

class FakeFileWorkspace implements FileWorkspaceWritePort {
  public readonly files = new Map<string, TextFileSnapshot>();

  public constructor() {
    this.files.set(
      "good.md",
      snapshot("good.md", "Good original", "good-hash"),
    );
  }

  public async listTextFiles(): Promise<readonly TextFileSnapshot[]> {
    return [...this.files.values()];
  }

  public async readTextFile(relativePath: string): Promise<TextFileSnapshot> {
    const file = this.files.get(relativePath);
    if (!file) throw new Error(`Missing file ${relativePath}`);
    return file;
  }

  public async searchTextFiles(): Promise<readonly TextSearchMatch[]> {
    return [];
  }

  public async writeTextFile(
    relativePath: string,
    replacement: string,
    expectedSha256: string,
  ): Promise<TextFileSnapshot> {
    const current = await this.readTextFile(relativePath);
    if (current.sha256 !== expectedSha256) {
      throw new Error("Concurrent file change");
    }
    const next = snapshot(relativePath, replacement, `${expectedSha256}-next`);
    this.files.set(relativePath, next);
    return next;
  }

  public async captureRollback(
    relativePath: string,
  ): Promise<FileRollbackSnapshot> {
    const current = await this.readTextFile(relativePath);
    return {
      relativePath,
      bytesBase64: Buffer.from(current.content).toString("base64"),
      sha256: current.sha256,
      mode: current.mode,
    };
  }

  public async restoreRollback(
    rollback: FileRollbackSnapshot,
    expectedSha256: string,
  ): Promise<TextFileSnapshot> {
    const current = await this.readTextFile(rollback.relativePath);
    if (current.sha256 !== expectedSha256) throw new Error("undo conflict");
    const restored = snapshot(
      rollback.relativePath,
      Buffer.from(rollback.bytesBase64, "base64").toString(),
      rollback.sha256,
    );
    this.files.set(rollback.relativePath, restored);
    return restored;
  }
}

function snapshot(
  relativePath: string,
  content: string,
  sha256: string,
): TextFileSnapshot {
  return {
    relativePath,
    content,
    byteLength: Buffer.byteLength(content),
    sha256,
    hasBom: false,
    lineEnding: "LF",
    hasFinalNewline: false,
    mode: 0o644,
  };
}

class FakeFileWorkspaceResolver implements FileWorkspaceWriteResolver {
  public constructor(private readonly workspace: FileWorkspaceWritePort) {}

  public resolve(): FileWorkspaceWritePort | null {
    return this.workspace;
  }
}

class EmptyWorkspaceResolver implements FileWorkspaceWriteResolver {
  public resolve(): FileWorkspaceWritePort | null {
    return null;
  }
}

class FinalTextProvider implements AiProvider {
  public lastRequest: StreamChatRequest | null = null;

  public async *streamChat(
    request: StreamChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.lastRequest = request;
    yield { type: "text-delta", delta: "Applied successfully." };
    yield { type: "completed", finishReason: "stop" };
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }
}

class RecordingPanelPort implements PanelPort {
  public readonly events: PluginEvent[] = [];

  public async initialize(): Promise<void> {
    return Promise.resolve();
  }

  public post(event: PluginEvent): void {
    this.events.push(event);
  }
}

function proposedApplyToken(event: PluginEvent | undefined): string {
  if (event?.type !== "changes.proposed") {
    throw new Error("Expected changes.proposed event");
  }
  return event.payload.applyToken;
}

describe("ApprovalWorkflow", () => {
  test("applies a batch, returns results to the model, and persists continuation", async () => {
    const files = new MemoryJsonFilePort();
    const chats = new ChatStore("/plugin", files);
    const chat = await chats.create("Review");
    const changes = new InMemoryChangeSetStore();
    const change = changes.add(chat.id, "run-1", {
      kind: "note",
      operation: "update",
      noteId: "note-1",
      targetLabel: "Guide",
      before: "Old",
      after: "New",
      expectedUpdatedTime: 10,
    });
    const changeSet = changes.getByRun("run-1");
    if (!changeSet) throw new Error("Expected change set");
    await chats.save({
      ...chat,
      pendingChangeSet: changeSet,
      runSummaries: [
        {
          runId: "run-1",
          status: "awaiting-approval",
          summary: "Changes proposed",
          completedAt: 1,
        },
      ],
    });
    const notes = new MutableNoteRepository();
    const provider = new FinalTextProvider();
    const panel = new RecordingPanelPort();
    const workflow = new ApprovalWorkflow(
      chats,
      changes,
      new ChangeApplier(
        changes,
        notes,
        new EmptyWorkspaceResolver(),
        new InMemoryRollbackStore(),
      ),
      new ToolRegistry(),
      { connectWithConfirmation: async () => ({ provider }) },
      new PluginEventSender(panel),
      new RunCancellationRegistry(),
    );
    workflow.remember(
      changeSet,
      {
        messages: [{ role: "user", content: "Improve the guide" }],
        nextStep: 2,
        toolCallCount: 1,
      },
      chat.id,
      false,
      true,
      new Set<string>(),
      new Set<string>(),
      [],
    );

    await workflow.resolveProposedChanges(changeSet, false);
    expect(notes.note.body).toBe("Old");
    expect(panel.events.at(-1)?.type).toBe("changes.proposed");

    await workflow.apply({
      version: 2,
      messageId: "message-1",
      chatId: chat.id,
      runId: "run-1",
      type: "changes.apply",
      payload: {
        changeSetId: changeSet.id,
        acceptedIds: [change.id],
        applyToken: proposedApplyToken(panel.events.at(-1)),
      },
    });

    expect(notes.note.body).toBe("New");
    expect(
      provider.lastRequest?.messages.some((message) =>
        message.content.includes('"status":"applied"'),
      ),
    ).toBe(true);
    expect((await chats.get(chat.id))?.messages.at(-1)?.content).toBe(
      "Applied successfully.",
    );
    expect(panel.events.map((event) => event.type)).toEqual([
      "changes.proposed",
      "run.started",
      "run.progress",
      "assistant.delta",
      "run.completed",
    ]);
  });

  test("requires manual review for note proposals even when auto-apply is enabled", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Automatic notes");
    const changes = new InMemoryChangeSetStore();
    changes.add(chat.id, "run-auto", {
      kind: "note",
      operation: "update",
      noteId: "note-1",
      targetLabel: "Guide",
      before: "Old",
      after: "Updated",
      expectedUpdatedTime: 10,
    });
    const changeSet = changes.getByRun("run-auto");
    if (!changeSet) throw new Error("Expected automatic change set");
    const notes = new MutableNoteRepository();
    const panel = new RecordingPanelPort();
    const workflow = new ApprovalWorkflow(
      chats,
      changes,
      new ChangeApplier(
        changes,
        notes,
        new EmptyWorkspaceResolver(),
        new InMemoryRollbackStore(),
      ),
      new ToolRegistry(),
      {
        connectWithConfirmation: async () => ({
          provider: new FinalTextProvider(),
        }),
      },
      new PluginEventSender(panel),
      new RunCancellationRegistry(),
    );

    await workflow.resolveProposedChanges(changeSet, true);

    expect(notes.note.body).toBe("Old");
    expect(panel.events.map((event) => event.type)).toEqual(["changes.proposed"]);
  });

  test("automatically applies file-only proposals without review", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Automatic files");
    const changes = new InMemoryChangeSetStore();
    changes.add(chat.id, "run-file", {
      kind: "file",
      relativePath: "good.md",
      targetLabel: "good.md",
      before: "Good original",
      after: "Good improved",
      expectedSha256: "good-hash",
    });
    const changeSet = changes.getByRun("run-file");
    if (!changeSet) throw new Error("Expected file change set");
    const workspace = new FakeFileWorkspace();
    const panel = new RecordingPanelPort();
    const workflow = new ApprovalWorkflow(
      chats,
      changes,
      new ChangeApplier(
        changes,
        new MutableNoteRepository(),
        new FakeFileWorkspaceResolver(workspace),
        new InMemoryRollbackStore(),
      ),
      new ToolRegistry(),
      {
        connectWithConfirmation: async () => ({
          provider: new FinalTextProvider(),
        }),
      },
      new PluginEventSender(panel),
      new RunCancellationRegistry(),
    );

    await workflow.resolveProposedChanges(changeSet, true);

    expect(workspace.files.get("good.md")?.content).toBe("Good improved");
    expect(panel.events.map((event) => event.type)).toEqual([
      "run.progress",
      "run.completed",
    ]);
    expect(panel.events[0]).toMatchObject({
      payload: { label: "Auto-applying 1 proposed changes" },
    });
  });

  test("requires manual review for deletion even when auto-apply is enabled", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Deletion review");
    const changes = new InMemoryChangeSetStore();
    changes.add(chat.id, "run-delete", {
      kind: "note",
      operation: "delete",
      noteId: "note-1",
      expectedUpdatedTime: 10,
      targetLabel: "Guide",
      before: "Title: Guide",
      after: "Moved to Joplin Trash (recoverable).",
    });
    const changeSet = changes.getByRun("run-delete");
    if (!changeSet) throw new Error("Expected deletion change set");
    const panel = new RecordingPanelPort();
    const workflow = new ApprovalWorkflow(
      chats,
      changes,
      new ChangeApplier(
        changes,
        new MutableNoteRepository(),
        new EmptyWorkspaceResolver(),
        new InMemoryRollbackStore(),
      ),
      new ToolRegistry(),
      {
        connectWithConfirmation: async () => ({
          provider: new FinalTextProvider(),
        }),
      },
      new PluginEventSender(panel),
      new RunCancellationRegistry(),
    );

    await workflow.resolveProposedChanges(changeSet, true);

    expect(panel.events.map((event) => event.type)).toEqual([
      "changes.proposed",
    ]);
    expect(changes.getByRun("run-delete")?.status).toBe("proposed");
  });

  test("rejects forged apply requests without a plugin token", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-forged", {
      kind: "note",
      operation: "update",
      noteId: "note-1",
      targetLabel: "Guide",
      before: "Old",
      after: "New",
      expectedUpdatedTime: 10,
    });
    const changeSet = changes.getByRun("run-forged");
    if (!changeSet) throw new Error("Expected change set");
    const workflow = new ApprovalWorkflow(
      new ChatStore("/plugin", new MemoryJsonFilePort()),
      changes,
      new ChangeApplier(
        changes,
        new MutableNoteRepository(),
        new EmptyWorkspaceResolver(),
        new InMemoryRollbackStore(),
      ),
      new ToolRegistry(),
      { connectWithConfirmation: async () => ({ provider: new FinalTextProvider() }) },
      new PluginEventSender(new RecordingPanelPort()),
      new RunCancellationRegistry(),
    );
    await workflow.resolveProposedChanges(changeSet, false);

    await expect(
      workflow.apply({
        version: 2,
        messageId: "message-1",
        chatId: "chat-1",
        runId: "run-forged",
        type: "changes.apply",
        payload: {
          changeSetId: changeSet.id,
          acceptedIds: [proposed.id],
          applyToken: "0".repeat(64),
        },
      }),
    ).rejects.toThrow("Invalid apply token");
  });
});
