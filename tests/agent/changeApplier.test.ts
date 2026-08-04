import {
  ChangeApplier,
  type FileWorkspaceWritePort,
  type FileWorkspaceWriteResolver,
  InMemoryRollbackStore,
  type RollbackRecord,
  type RollbackStore,
} from "../../src/agent/changeApplier";
import type {
  FileRollbackSnapshot,
  TextFileSnapshot,
  TextSearchMatch,
} from "../../src/fileWorkspace/fileWorkspaceRepository";
import type {
  CreateNotebookInput,
  CreateNoteInput,
  NoteMetadataRecord,
  NoteOrganizationRepository,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NotebookMetadataRecord,
  NotebookRecord,
  RestoreNoteInput,
  RestoreNotebookInput,
  TrashListing,
  TrashNoteInput,
  TrashNotebookInput,
  TrashedNoteRecord,
  TrashedNotebookRecord,
  UpdateNoteBodyInput,
  UpdateNoteMetadataInput,
  UpdateNotebookMetadataInput,
} from "../../src/notes/retriever";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";

class UnusedNoteRepository implements NoteRepository {
  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [];
  }
  public async readNote(): Promise<NoteRecord> {
    throw new Error("No note changes expected");
  }
  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [];
  }
  public async createNote(_input: CreateNoteInput): Promise<NoteRecord> {
    throw new Error("No note changes expected");
  }
  public async updateNoteBody(
    _input: UpdateNoteBodyInput,
  ): Promise<NoteRecord> {
    throw new Error("No note changes expected");
  }
}

class RecordingNoteRepository extends UnusedNoteRepository {
  public readonly createdNotes: CreateNoteInput[] = [];

  public override async createNote(
    input: CreateNoteInput,
  ): Promise<NoteRecord> {
    this.createdNotes.push(input);
    return {
      id: "note-created",
      parentId: input.parentId,
      title: input.title,
      body: input.body,
      updatedTime: 2,
    };
  }
}

class MutableNoteRepository extends UnusedNoteRepository {
  public note: NoteRecord = {
    id: "note-1",
    parentId: "folder-1",
    title: "Guide",
    body: "Old",
    updatedTime: 10,
  };

  public override async readNote(): Promise<NoteRecord> {
    return this.note;
  }

  public override async updateNoteBody(
    input: UpdateNoteBodyInput,
  ): Promise<NoteRecord> {
    if (input.expectedUpdatedTime !== this.note.updatedTime)
      throw new Error("updated_time conflict");
    this.note = {
      ...this.note,
      body: input.body,
      updatedTime: this.note.updatedTime + 1,
    };
    return this.note;
  }
}

class RejectingRollbackStore implements RollbackStore {
  public save(_record: RollbackRecord): Promise<void> {
    return Promise.reject(new Error("Rollback storage unavailable"));
  }

  public get(_runId: string): Promise<RollbackRecord | null> {
    return Promise.resolve(null);
  }

  public remove(_runId: string): Promise<void> {
    return Promise.resolve();
  }

  public beginMerge(): Promise<void> {
    return Promise.reject(new Error("Rollback storage unavailable"));
  }

  public pendingMerge(): Promise<null> {
    return Promise.resolve(null);
  }

  public commitPendingMerge(): Promise<void> {
    return Promise.resolve();
  }

  public rollbackPendingMerge(): Promise<void> {
    return Promise.resolve();
  }
}

class RejectingFinalizeRollbackStore extends InMemoryRollbackStore {
  private saves = 0;

  public override save(record: RollbackRecord): Promise<void> {
    this.saves += 1;
    if (this.saves === 2) {
      return Promise.reject(new Error("Rollback finalization unavailable"));
    }
    return super.save(record);
  }
}

class RejectingMergeCommitOnce extends InMemoryRollbackStore {
  private rejectCommit = true;

  public override commitPendingMerge(
    targetRunId: string,
    sourceRunId: string,
  ): Promise<void> {
    if (this.rejectCommit) {
      this.rejectCommit = false;
      return Promise.reject(new Error("Merge journal removal unavailable"));
    }
    return super.commitPendingMerge(targetRunId, sourceRunId);
  }
}

class RejectingMergeRollbackOnce extends InMemoryRollbackStore {
  private rejectRollback = true;

  public override rollbackPendingMerge(): Promise<void> {
    if (this.rejectRollback) {
      this.rejectRollback = false;
      return Promise.reject(new Error("Merge rollback unavailable"));
    }
    return super.rollbackPendingMerge();
  }
}

class RecordingNoteOrganizationRepository implements NoteOrganizationRepository {
  public readonly createdNotebooks: CreateNotebookInput[] = [];
  public readonly noteMetadataUpdates: UpdateNoteMetadataInput[] = [];
  public readonly trashedNotes: TrashNoteInput[] = [];
  public readonly notebookMetadataUpdates: UpdateNotebookMetadataInput[] = [];
  public readonly trashedNotebooks: TrashNotebookInput[] = [];
  public readonly restoredNotes: RestoreNoteInput[] = [];
  public readonly restoredNotebooks: RestoreNotebookInput[] = [];
  public note: NoteMetadataRecord = {
    id: "note-1",
    parentId: "folder-1",
    title: "Draft",
    updatedTime: 10,
    order: 100,
  };
  public notebook: NotebookMetadataRecord = {
    id: "folder-1",
    parentId: "",
    title: "Projects",
    updatedTime: 40,
  };
  public trashedNote: TrashedNoteRecord = {
    id: "note-1",
    parentId: "folder-1",
    title: "Draft",
    updatedTime: 10,
    order: 100,
    deletedTime: 99,
  };
  public trashedNotebook: TrashedNotebookRecord = {
    id: "folder-1",
    parentId: "",
    title: "Projects",
    updatedTime: 40,
    deletedTime: 99,
  };

  public async readNoteMetadata(): Promise<NoteMetadataRecord> {
    return this.note;
  }
  public async listNotebookNotes(): Promise<readonly NoteMetadataRecord[]> {
    return [];
  }
  public async readNotebook(): Promise<NotebookMetadataRecord> {
    return this.notebook;
  }
  public async createNotebook(
    input: CreateNotebookInput,
  ): Promise<NotebookMetadataRecord> {
    this.createdNotebooks.push(input);
    return {
      id: "folder-created",
      parentId: input.parentId,
      title: input.title,
      updatedTime: 1,
    };
  }
  public async updateNoteMetadata(
    input: UpdateNoteMetadataInput,
  ): Promise<NoteMetadataRecord> {
    this.noteMetadataUpdates.push(input);
    return {
      ...this.note,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      updatedTime: 11,
    };
  }
  public async updateNotebookMetadata(
    input: UpdateNotebookMetadataInput,
  ): Promise<NotebookMetadataRecord> {
    this.notebookMetadataUpdates.push(input);
    return {
      ...this.notebook,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      updatedTime: 41,
    };
  }
  public async trashNote(input: TrashNoteInput): Promise<TrashedNoteRecord> {
    this.trashedNotes.push(input);
    this.trashedNote = { ...this.trashedNote, updatedTime: 12 };
    return this.trashedNote;
  }
  public async trashNotebook(
    input: TrashNotebookInput,
  ): Promise<TrashedNotebookRecord> {
    this.trashedNotebooks.push(input);
    this.trashedNotebook = { ...this.trashedNotebook, updatedTime: 42 };
    return this.trashedNotebook;
  }
  public async listTrash(): Promise<TrashListing> {
    return { notes: [this.trashedNote], notebooks: [this.trashedNotebook] };
  }
  public async readTrashedNote(): Promise<TrashedNoteRecord> {
    return this.trashedNote;
  }
  public async readTrashedNotebook(): Promise<TrashedNotebookRecord> {
    return this.trashedNotebook;
  }
  public async restoreNote(
    input: RestoreNoteInput,
  ): Promise<NoteMetadataRecord> {
    this.restoredNotes.push(input);
    return { ...this.note, updatedTime: 13 };
  }
  public async restoreNotebook(
    input: RestoreNotebookInput,
  ): Promise<NotebookMetadataRecord> {
    this.restoredNotebooks.push(input);
    return { ...this.notebook, updatedTime: 43 };
  }
}

function snapshot(
  path: string,
  content: string,
  sha256: string,
): TextFileSnapshot {
  return {
    relativePath: path,
    content,
    sha256,
    byteLength: Buffer.byteLength(content),
    hasBom: false,
    lineEnding: "LF",
    hasFinalNewline: false,
    mode: 0o644,
  };
}

class FakeFileWorkspace implements FileWorkspaceWritePort {
  public readonly files = new Map<string, TextFileSnapshot>([
    ["good.md", snapshot("good.md", "Good original", "good-hash")],
    ["conflict.md", snapshot("conflict.md", "Changed elsewhere", "new-hash")],
  ]);

  public async listTextFiles(): Promise<readonly TextFileSnapshot[]> {
    return [...this.files.values()];
  }
  public async readTextFile(path: string): Promise<TextFileSnapshot> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing ${path}`);
    return file;
  }
  public async searchTextFiles(): Promise<readonly TextSearchMatch[]> {
    return [];
  }
  public async writeTextFile(
    path: string,
    replacement: string,
    expectedSha256: string,
  ): Promise<TextFileSnapshot> {
    const current = await this.readTextFile(path);
    if (current.sha256 !== expectedSha256) throw new Error("hash conflict");
    const next = snapshot(path, replacement, `applied-${path}`);
    this.files.set(path, next);
    return next;
  }
  public async captureRollback(path: string): Promise<FileRollbackSnapshot> {
    const current = await this.readTextFile(path);
    return {
      relativePath: path,
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

class FakeFileWorkspaceResolver implements FileWorkspaceWriteResolver {
  public constructor(private readonly workspace: FakeFileWorkspace) {}
  public resolve(): FileWorkspaceWritePort {
    return this.workspace;
  }
}

describe("ChangeApplier", () => {
  test("aborts before a created note write when the application journal fails", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-create-save-failure", {
      kind: "note",
      operation: "create",
      parentId: "folder-1",
      title: "Guide",
      targetLabel: "Guide",
      before: "Note does not exist.",
      after: "Published",
    });
    const changeSet = changes.getByRun("run-create-save-failure");
    if (!changeSet) throw new Error("Expected change set");
    const notes = new RecordingNoteRepository();
    const applier = new ChangeApplier(
      changes,
      notes,
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new RejectingRollbackStore(),
      new RecordingNoteOrganizationRepository(),
    );

    await expect(
      applier.apply(changeSet.id, [proposed.id], {
        chatId: "chat-1",
        runId: "run-create-save-failure",
      }),
    ).rejects.toThrow("Rollback storage unavailable");
    expect(changes.get(changeSet.id)?.status).toBe("proposed");
    expect(notes.createdNotes).toHaveLength(0);
  });

  test("retains a write-ahead lock when rollback finalization fails", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-finalize-failure", {
      kind: "note",
      operation: "create",
      parentId: "folder-1",
      title: "Guide",
      targetLabel: "Guide",
      before: "Note does not exist.",
      after: "Published",
    });
    const changeSet = changes.getByRun("run-finalize-failure");
    if (!changeSet) throw new Error("Expected change set");
    const notes = new RecordingNoteRepository();
    const rollbacks = new RejectingFinalizeRollbackStore();
    const applier = new ChangeApplier(
      changes,
      notes,
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      rollbacks,
      new RecordingNoteOrganizationRepository(),
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-finalize-failure",
    });

    expect(result.durabilityFailure).toContain(
      "Rollback finalization unavailable",
    );
    expect(notes.createdNotes).toHaveLength(1);
    expect(
      await applier.retainedAppliedChangeIds("run-finalize-failure", "chat-1"),
    ).toEqual([proposed.id]);
  });

  test("compensates an approved note update with optimistic concurrency", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-note-update", {
      kind: "note",
      operation: "update",
      noteId: "note-1",
      targetLabel: "Guide",
      before: "Old",
      after: "New",
      expectedUpdatedTime: 10,
    });
    const changeSet = changes.getByRun("run-note-update");
    if (!changeSet) throw new Error("Expected change set");
    const notes = new MutableNoteRepository();
    const applier = new ChangeApplier(
      changes,
      notes,
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
    );

    await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-note-update",
    });
    expect(notes.note.body).toBe("New");
    expect(
      await applier.retainedAppliedChangeIds("run-note-update", "chat-1"),
    ).toEqual([proposed.id]);

    await applier.compensate("run-note-update", "chat-1", [proposed.id]);

    expect(notes.note.body).toBe("Old");
    expect(
      await applier.retainedAppliedChangeIds("run-note-update", "chat-1"),
    ).toEqual([]);
  });

  test("compensates an approved note creation through Joplin Trash", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-note-create", {
      kind: "note",
      operation: "create",
      parentId: "folder-1",
      title: "Guide",
      targetLabel: "Guide",
      before: "Note does not exist.",
      after: "Published",
    });
    const changeSet = changes.getByRun("run-note-create");
    if (!changeSet) throw new Error("Expected change set");
    const notes = new RecordingNoteRepository();
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      notes,
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-note-create",
    });
    await applier.undo("run-note-create", "chat-1");

    expect(result.undoAvailable).toBe(true);
    expect(notes.createdNotes).toEqual([
      { parentId: "folder-1", title: "Guide", body: "Published" },
    ]);
    expect(organizations.trashedNotes).toEqual([
      { noteId: "note-created", expectedUpdatedTime: 2 },
    ]);
  });

  test("applies an approved note rename", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-rename", {
      kind: "note",
      operation: "rename",
      noteId: "note-1",
      expectedUpdatedTime: 10,
      title: "Published",
      targetLabel: "Draft",
      before: "Title: Draft",
      after: "Title: Published",
    });
    const changeSet = changes.getByRun("run-rename");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-rename",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.noteMetadataUpdates).toEqual([
      {
        noteId: "note-1",
        expectedUpdatedTime: 10,
        title: "Published",
      },
    ]);
  });

  test("applies an approved note move", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-move", {
      kind: "note",
      operation: "move",
      noteId: "note-1",
      expectedUpdatedTime: 10,
      parentId: "folder-2",
      targetLabel: "Draft",
      before: "Notebook: folder-1",
      after: "Notebook: folder-2",
    });
    const changeSet = changes.getByRun("run-move");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-move",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.noteMetadataUpdates).toEqual([
      {
        noteId: "note-1",
        expectedUpdatedTime: 10,
        parentId: "folder-2",
      },
    ]);
  });

  test("applies an approved note reorder", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-reorder", {
      kind: "note",
      operation: "reorder",
      noteId: "note-1",
      expectedUpdatedTime: 10,
      order: 250,
      targetLabel: "Draft",
      before: "Manual order: 100",
      after: "Manual order: 250",
    });
    const changeSet = changes.getByRun("run-reorder");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-reorder",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.noteMetadataUpdates).toEqual([
      {
        noteId: "note-1",
        expectedUpdatedTime: 10,
        order: 250,
      },
    ]);
  });

  test("applies an approved recoverable note deletion", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-delete", {
      kind: "note",
      operation: "delete",
      noteId: "note-1",
      expectedUpdatedTime: 10,
      targetLabel: "Draft",
      before: "Title: Draft",
      after: "Moved to Joplin Trash (recoverable).",
    });
    const changeSet = changes.getByRun("run-delete");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-delete",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.trashedNotes).toEqual([
      { noteId: "note-1", expectedUpdatedTime: 10 },
    ]);
    await applier.undo("run-delete", "chat-1");
    expect(organizations.restoredNotes).toEqual([
      {
        noteId: "note-1",
        expectedUpdatedTime: 12,
        parentId: "folder-1",
      },
    ]);
  });

  test("applies an approved notebook creation", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-notebook", {
      kind: "notebook",
      operation: "create",
      parentId: "folder-1",
      title: "Archive",
      targetLabel: "Archive",
      before: "Notebook does not exist.",
      after: "Title: Archive\nParent notebook: folder-1",
    });
    const changeSet = changes.getByRun("run-notebook");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-notebook",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(result.undoAvailable).toBe(true);
    expect(organizations.createdNotebooks).toEqual([
      { parentId: "folder-1", title: "Archive" },
    ]);
    await applier.undo("run-notebook", "chat-1");
    expect(organizations.trashedNotebooks).toEqual([
      { notebookId: "folder-created", expectedUpdatedTime: 1 },
    ]);
  });

  test("applies an approved notebook rename", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-notebook-rename", {
      kind: "notebook",
      operation: "rename",
      notebookId: "folder-1",
      expectedUpdatedTime: 40,
      title: "Active projects",
      targetLabel: "Projects",
      before: "Title: Projects",
      after: "Title: Active projects",
    });
    const changeSet = changes.getByRun("run-notebook-rename");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-notebook-rename",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.notebookMetadataUpdates).toEqual([
      {
        notebookId: "folder-1",
        expectedUpdatedTime: 40,
        title: "Active projects",
      },
    ]);
  });

  test("applies an approved notebook move to the vault root", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-notebook-move", {
      kind: "notebook",
      operation: "move",
      notebookId: "folder-1",
      expectedUpdatedTime: 40,
      parentId: "",
      targetLabel: "Projects",
      before: "Parent notebook: folder-parent",
      after: "Parent notebook: (root)",
    });
    const changeSet = changes.getByRun("run-notebook-move");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-notebook-move",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.notebookMetadataUpdates).toEqual([
      {
        notebookId: "folder-1",
        expectedUpdatedTime: 40,
        parentId: "",
      },
    ]);
  });

  test("applies an approved recoverable notebook deletion", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-notebook-delete", {
      kind: "notebook",
      operation: "delete",
      notebookId: "folder-1",
      expectedUpdatedTime: 40,
      targetLabel: "Projects",
      before: "Title: Projects",
      after: "Moved to Joplin Trash with contained items (recoverable).",
    });
    const changeSet = changes.getByRun("run-notebook-delete");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-notebook-delete",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.trashedNotebooks).toEqual([
      { notebookId: "folder-1", expectedUpdatedTime: 40 },
    ]);
    await applier.undo("run-notebook-delete", "chat-1");
    expect(organizations.restoredNotebooks).toEqual([
      { notebookId: "folder-1", expectedUpdatedTime: 42, parentId: "" },
    ]);
  });

  test("applies an approved note restore from Joplin Trash", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-restore-note", {
      kind: "note",
      operation: "restore",
      noteId: "note-1",
      expectedUpdatedTime: 10,
      parentId: "folder-2",
      targetLabel: "Draft",
      before: "In Joplin Trash (soft-deleted).",
      after: "Title: Draft\nNotebook: folder-2\nManual order: 100",
    });
    const changeSet = changes.getByRun("run-restore-note");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-restore-note",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.restoredNotes).toEqual([
      { noteId: "note-1", expectedUpdatedTime: 10, parentId: "folder-2" },
    ]);
    await applier.undo("run-restore-note", "chat-1");
    expect(organizations.trashedNotes).toEqual([
      { noteId: "note-1", expectedUpdatedTime: 13 },
    ]);
  });

  test("applies an approved notebook restore from Joplin Trash", async () => {
    const changes = new InMemoryChangeSetStore();
    const proposed = changes.add("chat-1", "run-restore-notebook", {
      kind: "notebook",
      operation: "restore",
      notebookId: "folder-1",
      expectedUpdatedTime: 40,
      targetLabel: "Projects",
      before: "In Joplin Trash with contained items (soft-deleted).",
      after: "Title: Projects\nParent notebook: (root)",
    });
    const changeSet = changes.getByRun("run-restore-notebook");
    if (!changeSet) throw new Error("Expected change set");
    const organizations = new RecordingNoteOrganizationRepository();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
      new InMemoryRollbackStore(),
      organizations,
    );

    const result = await applier.apply(changeSet.id, [proposed.id], {
      chatId: "chat-1",
      runId: "run-restore-notebook",
    });

    expect(result.changes[0]?.status).toBe("applied");
    expect(organizations.restoredNotebooks).toEqual([
      { notebookId: "folder-1", expectedUpdatedTime: 40 },
    ]);
    await applier.undo("run-restore-notebook", "chat-1");
    expect(organizations.trashedNotebooks).toEqual([
      { notebookId: "folder-1", expectedUpdatedTime: 43 },
    ]);
  });

  test("applies independent files, reports conflicts, and undoes exact originals", async () => {
    const changes = new InMemoryChangeSetStore();
    const good = changes.add("chat-1", "run-1", {
      kind: "file",
      relativePath: "good.md",
      targetLabel: "good.md",
      before: "Good original",
      after: "Good improved",
      expectedSha256: "good-hash",
    });
    const conflict = changes.add("chat-1", "run-1", {
      kind: "file",
      relativePath: "conflict.md",
      targetLabel: "conflict.md",
      before: "Old original",
      after: "Unsafe overwrite",
      expectedSha256: "old-hash",
    });
    const workspace = new FakeFileWorkspace();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(workspace),
      new InMemoryRollbackStore(),
    );
    const changeSet = changes.getByRun("run-1");
    if (!changeSet) throw new Error("Expected change set");

    const result = await applier.apply(changeSet.id, [good.id, conflict.id], {
      chatId: "chat-1",
      runId: "run-1",
    });

    expect(result.changes.map((change) => change.status)).toEqual([
      "applied",
      "conflict",
    ]);
    expect(workspace.files.get("good.md")?.content).toBe("Good improved");
    expect(workspace.files.get("conflict.md")?.content).toBe(
      "Changed elsewhere",
    );

    expect(result.undoAvailable).toBe(true);
    await applier.undo("run-1", "chat-1");

    expect(workspace.files.get("good.md")?.content).toBe("Good original");
  });

  test("undoes only selected change IDs and leaves other rollbacks", async () => {
    const changes = new InMemoryChangeSetStore();
    const first = changes.add("chat-1", "run-2", {
      kind: "file",
      relativePath: "a.md",
      targetLabel: "a.md",
      before: "A original",
      after: "A new",
      expectedSha256: "a-hash",
    });
    const second = changes.add("chat-1", "run-2", {
      kind: "file",
      relativePath: "b.md",
      targetLabel: "b.md",
      before: "B original",
      after: "B new",
      expectedSha256: "b-hash",
    });
    const workspace = new FakeFileWorkspace();
    workspace.files.clear();
    workspace.files.set("a.md", snapshot("a.md", "A original", "a-hash"));
    workspace.files.set("b.md", snapshot("b.md", "B original", "b-hash"));
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(workspace),
      new InMemoryRollbackStore(),
    );
    const changeSet = changes.getByRun("run-2");
    if (!changeSet) throw new Error("Expected change set");

    await applier.apply(changeSet.id, [first.id, second.id], {
      chatId: "chat-1",
      runId: "run-2",
    });
    await applier.undo("run-2", "chat-1", [first.id]);

    expect(workspace.files.get("a.md")?.content).toBe("A original");
    expect(workspace.files.get("b.md")?.content).toBe("B new");
  });

  test("merges parked run rollbacks into the target run for cumulative undo", async () => {
    const changes = new InMemoryChangeSetStore();
    const older = changes.add("chat-1", "run-old", {
      kind: "file",
      relativePath: "a.md",
      targetLabel: "a.md",
      before: "A original",
      after: "A new",
      expectedSha256: "a-hash",
    });
    const newer = changes.add("chat-1", "run-new", {
      kind: "file",
      relativePath: "b.md",
      targetLabel: "b.md",
      before: "B original",
      after: "B new",
      expectedSha256: "b-hash",
    });
    const workspace = new FakeFileWorkspace();
    workspace.files.clear();
    workspace.files.set("a.md", snapshot("a.md", "A original", "a-hash"));
    workspace.files.set("b.md", snapshot("b.md", "B original", "b-hash"));
    const rollbacks = new InMemoryRollbackStore();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(workspace),
      rollbacks,
    );
    const oldSet = changes.getByRun("run-old");
    const newSet = changes.getByRun("run-new");
    if (!oldSet || !newSet) throw new Error("Expected change sets");

    await applier.apply(oldSet.id, [older.id], {
      chatId: "chat-1",
      runId: "run-old",
    });
    await applier.apply(newSet.id, [newer.id], {
      chatId: "chat-1",
      runId: "run-new",
    });
    const merge = await applier.mergeRollbacks("run-new", "chat-1", "run-old");
    await merge.rollback();

    expect((await rollbacks.get("run-new"))?.items).toHaveLength(1);
    expect((await rollbacks.get("run-old"))?.items).toHaveLength(1);
    const committed = await applier.mergeRollbacks(
      "run-new",
      "chat-1",
      "run-old",
    );
    await committed.commit();
    expect((await rollbacks.get("run-new"))?.items).toHaveLength(2);
    expect((await rollbacks.get("run-old"))?.items).toHaveLength(0);
    await applier.undo("run-new", "chat-1", [older.id]);

    expect(workspace.files.get("a.md")?.content).toBe("A original");
    expect(workspace.files.get("b.md")?.content).toBe("B new");
  });

  test("keeps merged ownership after chat save when journal commit fails", async () => {
    const rollbacks = new RejectingMergeCommitOnce();
    await rollbacks.save(rollbackRecord("run-target", "change-target"));
    await rollbacks.save(rollbackRecord("run-source", "change-source"));
    const applier = mergeOnlyApplier(rollbacks);
    const receipt = await applier.mergeRollbacks(
      "run-target",
      "chat-1",
      "run-source",
    );

    await expect(receipt.commit()).rejects.toThrow(
      "Merge journal removal unavailable",
    );
    await expect(rollbacks.get("run-target")).rejects.toThrow(
      "is pending; expected lifecycle recovery",
    );
    await applier.resolvePendingRollbackMerge("chat-1", null);

    expect((await rollbacks.get("run-target"))?.items).toHaveLength(2);
    expect((await rollbacks.get("run-source"))?.items).toHaveLength(0);
  });

  test("restores pre-merge ownership after chat save and rollback fail", async () => {
    const rollbacks = new RejectingMergeRollbackOnce();
    const target = rollbackRecord("run-target", "change-target");
    const source = rollbackRecord("run-source", "change-source");
    await rollbacks.save(target);
    await rollbacks.save(source);
    const applier = mergeOnlyApplier(rollbacks);
    const receipt = await applier.mergeRollbacks(
      target.runId,
      target.chatId,
      source.runId,
    );

    await expect(receipt.rollback()).rejects.toThrow(
      "Merge rollback unavailable",
    );
    await applier.resolvePendingRollbackMerge("chat-1", source.runId);

    expect(await rollbacks.get(target.runId)).toEqual(target);
    expect(await rollbacks.get(source.runId)).toEqual(source);
  });
});

function mergeOnlyApplier(rollbacks: RollbackStore): ChangeApplier {
  return new ChangeApplier(
    new InMemoryChangeSetStore(),
    new UnusedNoteRepository(),
    new FakeFileWorkspaceResolver(new FakeFileWorkspace()),
    rollbacks,
  );
}

function rollbackRecord(runId: string, changeId: string): RollbackRecord {
  return {
    runId,
    chatId: "chat-1",
    createdAt: Date.now(),
    items: [
      {
        kind: "note",
        changeId,
        noteId: `note-${changeId}`,
        originalBody: "Old",
        expectedAppliedUpdatedTime: 2,
      },
    ],
  };
}
