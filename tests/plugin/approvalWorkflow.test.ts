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
      payload: { changeSetId: changeSet.id, acceptedIds: [change.id] },
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

  test("automatically applies every proposed change without review", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Automatic");
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
    changes.add(chat.id, "run-auto", {
      kind: "note",
      operation: "create",
      parentId: "folder-1",
      title: "Summary",
      targetLabel: "Summary",
      before: "",
      after: "Created",
    });
    changes.add(chat.id, "run-auto", {
      kind: "note",
      operation: "update",
      noteId: "note-stale",
      targetLabel: "Stale note",
      before: "Old",
      after: "Must not apply",
      expectedUpdatedTime: 999,
    });
    const changeSet = changes.getByRun("run-auto");
    if (!changeSet) throw new Error("Expected automatic change set");
    await chats.save({
      ...chat,
      context: { ...chat.context, autoApply: true },
      pendingChangeSet: changeSet,
    });
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

    expect(notes.note.body).toBe("Updated");
    expect(notes.createdNotes[0]?.body).toBe("Created");
    expect(
      changes.getByRun("run-auto")?.changes.map((change) => change.status),
    ).toEqual(["applied", "applied", "conflict"]);
    expect((await chats.get(chat.id))?.pendingChangeSet).toBeNull();
    expect(panel.events.map((event) => event.type)).toEqual([
      "run.progress",
      "run.completed",
    ]);
    expect(panel.events[0]).toMatchObject({
      payload: { label: "Auto-applying 3 proposed changes" },
    });
    expect(panel.events[1]).toMatchObject({
      payload: { undoRunId: "run-auto" },
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
    await chats.save({
      ...chat,
      context: { ...chat.context, autoApply: true },
      pendingChangeSet: changeSet,
    });
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
});
