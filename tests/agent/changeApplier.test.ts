import {
  ChangeApplier,
  type FileWorkspaceWritePort,
  type FileWorkspaceWriteResolver,
  InMemoryRollbackStore,
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
  TrashNoteInput,
  TrashNotebookInput,
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

class RecordingNoteOrganizationRepository implements NoteOrganizationRepository {
  public readonly createdNotebooks: CreateNotebookInput[] = [];
  public readonly noteMetadataUpdates: UpdateNoteMetadataInput[] = [];
  public readonly trashedNotes: TrashNoteInput[] = [];
  public readonly notebookMetadataUpdates: UpdateNotebookMetadataInput[] = [];
  public readonly trashedNotebooks: TrashNotebookInput[] = [];
  public readonly note: NoteMetadataRecord = {
    id: "note-1",
    parentId: "folder-1",
    title: "Draft",
    updatedTime: 10,
    order: 100,
  };
  public readonly notebook: NotebookMetadataRecord = {
    id: "folder-1",
    parentId: "",
    title: "Projects",
    updatedTime: 40,
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
  public async trashNote(input: TrashNoteInput): Promise<void> {
    this.trashedNotes.push(input);
  }
  public async trashNotebook(input: TrashNotebookInput): Promise<void> {
    this.trashedNotebooks.push(input);
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
    expect(organizations.createdNotebooks).toEqual([
      { parentId: "folder-1", title: "Archive" },
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
});
