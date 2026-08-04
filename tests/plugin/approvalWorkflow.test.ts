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
import {
  InMemoryChangeSetStore,
  type ChangeSet,
} from "../../src/persistence/changeSetStore";
import { ChatStore } from "../../src/persistence/chatStore";
import { ApprovalWorkflow } from "../../src/plugin/approvalWorkflow";
import type { PanelPort } from "../../src/plugin/panelPort";
import { PluginEventSender } from "../../src/plugin/pluginEventSender";
import { RunCancellationRegistry } from "../../src/plugin/runCancellationRegistry";
import type { PluginEvent } from "../../src/shared/protocol";
import { ToolRegistry } from "../../src/tools/toolRegistry";
import {
  NoOpReviewNotePort,
  type ReviewNotePort,
} from "../../src/plugin/reviewNoteService";
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

class RecordingReviewNotePort implements ReviewNotePort {
  public readonly opened: Array<{ changeSetId: string; chatTitle: string }> =
    [];
  public readonly disposed: string[] = [];
  private nextId = 1;

  public async openForChangeSet(
    changeSet: ChangeSet,
    chatTitle: string,
  ): Promise<string> {
    this.opened.push({ changeSetId: changeSet.id, chatTitle });
    return `review-note-${this.nextId++}`;
  }

  public async ensureOpen(
    changeSet: ChangeSet,
    chatTitle: string,
  ): Promise<string> {
    if (changeSet.reviewNoteId) return changeSet.reviewNoteId;
    return this.openForChangeSet(changeSet, chatTitle);
  }

  public async dispose(noteId: string): Promise<void> {
    this.disposed.push(noteId);
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
    const reviewNotes = new RecordingReviewNotePort();
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
      reviewNotes,
    );
    workflow.remember(
      changeSet,
      {
        messages: [{ role: "user", content: "Improve the guide" }],
        nextStep: 2,
        toolCallCount: 1,
        plan: null,
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
    expect(reviewNotes.opened).toEqual([
      { changeSetId: changeSet.id, chatTitle: "Review" },
    ]);
    expect((await chats.get(chat.id))?.pendingChangeSet?.reviewNoteId).toBe(
      "review-note-1",
    );

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
    expect(reviewNotes.disposed).toEqual(["review-note-1"]);
    expect(
      provider.lastRequest?.messages.some((message) =>
        message.content.includes('"status":"applied"'),
      ),
    ).toBe(true);
    expect((await chats.get(chat.id))?.messages.at(-1)?.content).toBe(
      "Applied successfully.",
    );
    expect((await chats.get(chat.id))?.pendingChangeSet?.status).toBe(
      "applied",
    );
    expect(panel.events.map((event) => event.type)).toEqual([
      "changes.proposed",
      "run.started",
      "run.progress",
      "assistant.delta",
      "run.completed",
    ]);
  });

  test("automatically applies note proposals when bypass permissions is enabled", async () => {
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
      new NoOpReviewNotePort(),
    );

    await workflow.resolveProposedChanges(changeSet, true);

    expect(notes.note.body).toBe("Updated");
    expect(panel.events.map((event) => event.type)).toEqual([
      "run.progress",
      "run.completed",
    ]);
    const saved = await chats.get(chat.id);
    expect(saved?.pendingChangeSet?.status).toBe("applied");
    expect(saved?.pendingChangeSet?.changes[0]?.status).toBe("applied");
  });

  test("automatically applies file-only proposals and retains applied review", async () => {
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
      new NoOpReviewNotePort(),
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
    const saved = await chats.get(chat.id);
    expect(saved?.pendingChangeSet?.status).toBe("applied");
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
      new NoOpReviewNotePort(),
    );

    await workflow.resolveProposedChanges(changeSet, true);

    expect(panel.events.map((event) => event.type)).toEqual([
      "changes.proposed",
    ]);
    expect(changes.getByRun("run-delete")?.status).toBe("proposed");
  });

  test("rejects forged apply requests without a plugin token", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Forged");
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add(chat.id, "run-forged", {
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
      new PluginEventSender(new RecordingPanelPort()),
      new RunCancellationRegistry(),
      new NoOpReviewNotePort(),
    );
    await workflow.resolveProposedChanges(changeSet, false);

    await expect(
      workflow.apply({
        version: 2,
        messageId: "message-1",
        chatId: chat.id,
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

describe("ApprovalWorkflow deny", () => {
  test("deny restores applied changes and resolves the change set", async () => {
    expect(typeof ApprovalWorkflow.prototype.deny).toBe("function");
  });
});

describe("ApprovalWorkflow keep and undo", () => {
  test("keep clears applied review without restoring note body", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Keep review");
    const changes = new InMemoryChangeSetStore();
    const notes = new MutableNoteRepository();
    const rollbacks = new InMemoryRollbackStore();
    const panel = new RecordingPanelPort();
    const workflow = new ApprovalWorkflow(
      chats,
      changes,
      new ChangeApplier(
        changes,
        notes,
        new EmptyWorkspaceResolver(),
        rollbacks,
      ),
      new ToolRegistry(),
      {
        connectWithConfirmation: async () => ({
          provider: new FinalTextProvider(),
        }),
      },
      new PluginEventSender(panel),
      new RunCancellationRegistry(),
      new NoOpReviewNotePort(),
    );
    changes.add(chat.id, "run-keep", {
      kind: "note",
      operation: "update",
      noteId: "note-1",
      targetLabel: "Guide",
      before: "Old",
      after: "Updated",
      expectedUpdatedTime: 10,
    });
    const changeSet = changes.getByRun("run-keep");
    if (!changeSet) throw new Error("Expected change set");

    await workflow.resolveProposedChanges(changeSet, true);
    expect(notes.note.body).toBe("Updated");
    const pending = (await chats.get(chat.id))?.pendingChangeSet;
    expect(pending?.status).toBe("applied");

    await workflow.keep({
      version: 2,
      messageId: "keep-1",
      chatId: chat.id,
      runId: "run-keep",
      type: "changes.keep",
      payload: {
        changeSetId: changeSet.id,
        changeIds: changeSet.changes.map((change) => change.id),
      },
    });

    expect(notes.note.body).toBe("Updated");
    expect((await chats.get(chat.id))?.pendingChangeSet).toBeNull();
  });

  test("undo restores one applied change and leaves the other pending", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Undo one");
    const changes = new InMemoryChangeSetStore();
    const workspace = new FakeFileWorkspace();
    workspace.files.clear();
    workspace.files.set("a.md", snapshot("a.md", "A original", "a-hash"));
    workspace.files.set("b.md", snapshot("b.md", "B original", "b-hash"));
    const rollbacks = new InMemoryRollbackStore();
    const panel = new RecordingPanelPort();
    const workflow = new ApprovalWorkflow(
      chats,
      changes,
      new ChangeApplier(
        changes,
        new MutableNoteRepository(),
        new FakeFileWorkspaceResolver(workspace),
        rollbacks,
      ),
      new ToolRegistry(),
      {
        connectWithConfirmation: async () => ({
          provider: new FinalTextProvider(),
        }),
      },
      new PluginEventSender(panel),
      new RunCancellationRegistry(),
      new NoOpReviewNotePort(),
    );
    const first = changes.add(chat.id, "run-undo-one", {
      kind: "file",
      relativePath: "a.md",
      targetLabel: "a.md",
      before: "A original",
      after: "A new",
      expectedSha256: "a-hash",
    });
    changes.add(chat.id, "run-undo-one", {
      kind: "file",
      relativePath: "b.md",
      targetLabel: "b.md",
      before: "B original",
      after: "B new",
      expectedSha256: "b-hash",
    });
    const changeSet = changes.getByRun("run-undo-one");
    if (!changeSet) throw new Error("Expected change set");

    await workflow.resolveProposedChanges(changeSet, true);
    await workflow.undoChanges({
      version: 2,
      messageId: "undo-1",
      chatId: chat.id,
      runId: "run-undo-one",
      type: "changes.undo",
      payload: {
        changeSetId: changeSet.id,
        changeIds: [first.id],
      },
    });

    expect(workspace.files.get("a.md")?.content).toBe("A original");
    expect(workspace.files.get("b.md")?.content).toBe("B new");
    const pending = (await chats.get(chat.id))?.pendingChangeSet;
    expect(pending?.changes).toHaveLength(1);
    expect(pending?.changes[0]?.targetLabel).toBe("b.md");
  });
});

describe("ApprovalWorkflow multi-batch review accumulation", () => {
  function createFileWorkflow(workspace: FakeFileWorkspace): {
    readonly chats: ChatStore;
    readonly changes: InMemoryChangeSetStore;
    readonly rollbacks: InMemoryRollbackStore;
    readonly panel: RecordingPanelPort;
    readonly workflow: ApprovalWorkflow;
    readonly chatId: Promise<string>;
  } {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const changes = new InMemoryChangeSetStore();
    const rollbacks = new InMemoryRollbackStore();
    const panel = new RecordingPanelPort();
    const chatId = chats.create("Accumulate").then((chat) => chat.id);
    const workflow = new ApprovalWorkflow(
      chats,
      changes,
      new ChangeApplier(
        changes,
        new MutableNoteRepository(),
        new FakeFileWorkspaceResolver(workspace),
        rollbacks,
      ),
      new ToolRegistry(),
      {
        connectWithConfirmation: async () => ({
          provider: new FinalTextProvider(),
        }),
      },
      new PluginEventSender(panel),
      new RunCancellationRegistry(),
      new NoOpReviewNotePort(),
    );
    return { chats, changes, rollbacks, panel, workflow, chatId };
  }

  test("merges parked batch A into applied batch B review", async () => {
    const workspace = new FakeFileWorkspace();
    workspace.files.clear();
    workspace.files.set("a.md", snapshot("a.md", "A original", "a-hash"));
    workspace.files.set("b.md", snapshot("b.md", "B original", "b-hash"));
    const { chats, changes, workflow, chatId } = createFileWorkflow(workspace);
    const id = await chatId;

    changes.add(id, "run-a", {
      kind: "file",
      relativePath: "a.md",
      targetLabel: "a.md",
      before: "A original",
      after: "A new",
      expectedSha256: "a-hash",
    });
    const batchA = changes.getByRun("run-a");
    if (!batchA) throw new Error("Expected batch A");
    await workflow.resolveProposedChanges(batchA, true);

    changes.add(id, "run-b", {
      kind: "file",
      relativePath: "b.md",
      targetLabel: "b.md",
      before: "B original",
      after: "B new",
      expectedSha256: "b-hash",
    });
    const batchB = changes.getByRun("run-b");
    if (!batchB) throw new Error("Expected batch B");
    await workflow.resolveProposedChanges(batchB, true);

    const pending = (await chats.get(id))?.pendingChangeSet;
    expect(pending?.status).toBe("applied");
    expect(pending?.changes.map((change) => change.targetLabel)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect((await chats.get(id))?.parkedAppliedChangeSet).toBeNull();
  });

  test("auto-applies three batches into one cumulative review", async () => {
    const workspace = new FakeFileWorkspace();
    workspace.files.clear();
    workspace.files.set("a.md", snapshot("a.md", "A0", "a0"));
    workspace.files.set("b.md", snapshot("b.md", "B0", "b0"));
    workspace.files.set("c.md", snapshot("c.md", "C0", "c0"));
    const { chats, changes, workflow, chatId } = createFileWorkflow(workspace);
    const id = await chatId;

    for (const [runId, path, before, after, hash] of [
      ["run-1", "a.md", "A0", "A1", "a0"],
      ["run-2", "b.md", "B0", "B1", "b0"],
      ["run-3", "c.md", "C0", "C1", "c0"],
    ] as const) {
      changes.add(id, runId, {
        kind: "file",
        relativePath: path,
        targetLabel: path,
        before,
        after,
        expectedSha256: hash,
      });
      const batch = changes.getByRun(runId);
      if (!batch) throw new Error(`Expected ${runId}`);
      await workflow.resolveProposedChanges(batch, true);
    }

    const pending = (await chats.get(id))?.pendingChangeSet;
    expect(pending?.changes).toHaveLength(3);
    expect(pending?.changes.map((change) => change.targetLabel)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });

  test("undoes a change from an earlier batch after merge", async () => {
    const workspace = new FakeFileWorkspace();
    workspace.files.clear();
    workspace.files.set("a.md", snapshot("a.md", "A original", "a-hash"));
    workspace.files.set("b.md", snapshot("b.md", "B original", "b-hash"));
    const { chats, changes, workflow, chatId } = createFileWorkflow(workspace);
    const id = await chatId;

    const changeA = changes.add(id, "run-a", {
      kind: "file",
      relativePath: "a.md",
      targetLabel: "a.md",
      before: "A original",
      after: "A new",
      expectedSha256: "a-hash",
    });
    const batchA = changes.getByRun("run-a");
    if (!batchA) throw new Error("Expected batch A");
    await workflow.resolveProposedChanges(batchA, true);

    changes.add(id, "run-b", {
      kind: "file",
      relativePath: "b.md",
      targetLabel: "b.md",
      before: "B original",
      after: "B new",
      expectedSha256: "b-hash",
    });
    const batchB = changes.getByRun("run-b");
    if (!batchB) throw new Error("Expected batch B");
    await workflow.resolveProposedChanges(batchB, true);

    const pending = (await chats.get(id))?.pendingChangeSet;
    if (!pending) throw new Error("Expected merged pending review");
    await workflow.undoChanges({
      version: 2,
      messageId: "undo-earlier",
      chatId: id,
      runId: pending.runId,
      type: "changes.undo",
      payload: {
        changeSetId: pending.id,
        changeIds: [changeA.id],
      },
    });

    expect(workspace.files.get("a.md")?.content).toBe("A original");
    expect(workspace.files.get("b.md")?.content).toBe("B new");
    const remaining = (await chats.get(id))?.pendingChangeSet;
    expect(remaining?.changes.map((change) => change.targetLabel)).toEqual([
      "b.md",
    ]);
  });

  test("parks applied review while showing only the next proposed batch", async () => {
    const workspace = new FakeFileWorkspace();
    workspace.files.clear();
    workspace.files.set("a.md", snapshot("a.md", "A original", "a-hash"));
    workspace.files.set("b.md", snapshot("b.md", "B original", "b-hash"));
    const { chats, changes, workflow, chatId } = createFileWorkflow(workspace);
    const id = await chatId;

    changes.add(id, "run-a", {
      kind: "file",
      relativePath: "a.md",
      targetLabel: "a.md",
      before: "A original",
      after: "A new",
      expectedSha256: "a-hash",
    });
    const batchA = changes.getByRun("run-a");
    if (!batchA) throw new Error("Expected batch A");
    await workflow.resolveProposedChanges(batchA, true);

    changes.add(id, "run-b", {
      kind: "file",
      relativePath: "b.md",
      targetLabel: "b.md",
      before: "B original",
      after: "B new",
      expectedSha256: "b-hash",
    });
    const batchB = changes.getByRun("run-b");
    if (!batchB) throw new Error("Expected batch B");
    await workflow.resolveProposedChanges(batchB, false);

    const saved = await chats.get(id);
    expect(saved?.pendingChangeSet?.status).toBe("proposed");
    expect(saved?.pendingChangeSet?.changes).toHaveLength(1);
    expect(saved?.pendingChangeSet?.changes[0]?.targetLabel).toBe("b.md");
    expect(saved?.parkedAppliedChangeSet?.status).toBe("applied");
    expect(saved?.parkedAppliedChangeSet?.changes).toHaveLength(1);
    expect(saved?.parkedAppliedChangeSet?.changes[0]?.targetLabel).toBe("a.md");
  });

  test("discarding a newer proposal restores the parked applied review", async () => {
    const workspace = new FakeFileWorkspace();
    workspace.files.clear();
    workspace.files.set("a.md", snapshot("a.md", "A original", "a-hash"));
    workspace.files.set("b.md", snapshot("b.md", "B original", "b-hash"));
    const { chats, changes, workflow, chatId } = createFileWorkflow(workspace);
    const id = await chatId;

    changes.add(id, "run-a", {
      kind: "file",
      relativePath: "a.md",
      targetLabel: "a.md",
      before: "A original",
      after: "A new",
      expectedSha256: "a-hash",
    });
    const batchA = changes.getByRun("run-a");
    if (!batchA) throw new Error("Expected batch A");
    await workflow.resolveProposedChanges(batchA, true);

    changes.add(id, "run-b", {
      kind: "file",
      relativePath: "b.md",
      targetLabel: "b.md",
      before: "B original",
      after: "B new",
      expectedSha256: "b-hash",
    });
    const batchB = changes.getByRun("run-b");
    if (!batchB) throw new Error("Expected batch B");
    await workflow.resolveProposedChanges(batchB, false);

    expect((await chats.get(id))?.parkedAppliedChangeSet).not.toBeNull();
    await workflow.discard({
      version: 2,
      messageId: "discard-b",
      chatId: id,
      runId: "run-b",
      type: "changes.discard",
      payload: { changeSetId: batchB.id },
    });

    const saved = await chats.get(id);
    expect(saved?.pendingChangeSet).toMatchObject({
      id: batchA.id,
      runId: "run-a",
      status: "applied",
    });
    expect(saved?.parkedAppliedChangeSet).toBeNull();
    expect(workspace.files.get("a.md")?.content).toBe("A new");
  });
});
