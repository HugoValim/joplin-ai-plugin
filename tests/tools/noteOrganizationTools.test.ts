import type {
  CreateNotebookInput,
  NoteMetadataRecord,
  NoteOrganizationRepository,
  NotebookMetadataRecord,
  RestoreNoteInput,
  RestoreNotebookInput,
  TrashListing,
  TrashNoteInput,
  TrashNotebookInput,
  TrashedNoteRecord,
  TrashedNotebookRecord,
  UpdateNoteMetadataInput,
  UpdateNotebookMetadataInput,
} from "../../src/notes/retriever";
import { toolContext } from "../helpers/toolContext";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { registerNoteOrganizationTools } from "../../src/tools/noteOrganizationTools";
import { ToolRegistry } from "../../src/tools/toolRegistry";

class FakeNoteOrganizationRepository implements NoteOrganizationRepository {
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

  public async readNoteMetadata(): Promise<NoteMetadataRecord> {
    return this.note;
  }

  public async listNotebookNotes(): Promise<readonly NoteMetadataRecord[]> {
    return [
      {
        id: "note-1",
        parentId: "folder-1",
        title: "First",
        updatedTime: 10,
        order: 100,
      },
    ];
  }

  public async readNotebook(): Promise<NotebookMetadataRecord> {
    return this.notebook;
  }

  public async createNotebook(
    _input: CreateNotebookInput,
  ): Promise<NotebookMetadataRecord> {
    throw new Error("Proposal tools must not write");
  }

  public async updateNoteMetadata(
    _input: UpdateNoteMetadataInput,
  ): Promise<NoteMetadataRecord> {
    throw new Error("Proposal tools must not write");
  }

  public async updateNotebookMetadata(
    _input: UpdateNotebookMetadataInput,
  ): Promise<NotebookMetadataRecord> {
    throw new Error("Proposal tools must not write");
  }

  public async trashNote(_input: TrashNoteInput): Promise<TrashedNoteRecord> {
    throw new Error("Proposal tools must not write");
  }

  public async trashNotebook(
    _input: TrashNotebookInput,
  ): Promise<TrashedNotebookRecord> {
    throw new Error("Proposal tools must not write");
  }

  public async listTrash(): Promise<TrashListing> {
    return {
      notes: [
        {
          ...this.note,
          deletedTime: 99,
        },
      ],
      notebooks: [
        {
          ...this.notebook,
          deletedTime: 99,
        },
      ],
    };
  }

  public async readTrashedNote(): Promise<TrashedNoteRecord> {
    return {
      ...this.note,
      deletedTime: 99,
    };
  }

  public async readTrashedNotebook(): Promise<TrashedNotebookRecord> {
    return {
      ...this.notebook,
      deletedTime: 99,
    };
  }

  public async restoreNote(
    _input: RestoreNoteInput,
  ): Promise<NoteMetadataRecord> {
    throw new Error("Proposal tools must not write");
  }

  public async restoreNotebook(
    _input: RestoreNotebookInput,
  ): Promise<NotebookMetadataRecord> {
    throw new Error("Proposal tools must not write");
  }
}

describe("note organization proposal tools", () => {
  test("reads versioned notebook metadata", async () => {
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      new InMemoryChangeSetStore(),
    );

    const result = await registry.execute(
      {
        id: "call-read-notebook",
        name: "read_notebook",
        arguments: { notebook_id: "folder-1" },
      },
      toolContext({ runId: "run-read" }),
    );

    expect(result.output).toEqual({
      id: "folder-1",
      parent_id: "",
      title: "Projects",
      updated_time: 40,
    });
  });

  test("lists note order and versions in one notebook", async () => {
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      new InMemoryChangeSetStore(),
    );

    const result = await registry.execute(
      {
        id: "call-list-notes",
        name: "list_notebook_notes",
        arguments: { notebook_id: "folder-1", limit: 25 },
      },
      toolContext({ runId: "run-list" }),
    );

    expect(result.output).toEqual({
      notes: [
        {
          id: "note-1",
          title: "First",
          updated_time: 10,
          order: 100,
        },
      ],
    });
  });

  test("proposes creating a nested notebook without writing", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    const result = await registry.execute(
      {
        id: "call-1",
        name: "create_notebook",
        arguments: { title: "Archive", parent_id: "folder-1" },
      },
      toolContext({ runId: "run-1" }),
    );

    expect(result.risk).toBe("propose-write");
    expect(changes.getByRun("run-1")?.changes).toEqual([
      expect.objectContaining({
        kind: "notebook",
        operation: "create",
        parentId: "folder-1",
        title: "Archive",
      }),
    ]);
  });

  test("proposes renaming a versioned note without writing", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-rename-note",
        name: "rename_note",
        arguments: {
          note_id: "note-1",
          expected_updated_time: 10,
          title: "Published",
        },
      },
      toolContext({
        runId: "run-rename",
        readableNoteIds: new Set(["note-1"]),
      }),
    );

    expect(changes.getByRun("run-rename")?.changes).toEqual([
      expect.objectContaining({
        kind: "note",
        operation: "rename",
        noteId: "note-1",
        expectedUpdatedTime: 10,
        title: "Published",
      }),
    ]);
  });

  test("proposes moving a versioned note to another notebook", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-move-note",
        name: "move_note",
        arguments: {
          note_id: "note-1",
          expected_updated_time: 10,
          parent_id: "folder-2",
        },
      },
      toolContext({ runId: "run-move", readableNoteIds: new Set(["note-1"]) }),
    );

    expect(changes.getByRun("run-move")?.changes).toEqual([
      expect.objectContaining({
        kind: "note",
        operation: "move",
        noteId: "note-1",
        parentId: "folder-2",
      }),
    ]);
  });

  test("moves notes without active or attached allowlist when notebook is not secret", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-move-note-open",
        name: "move_note",
        arguments: {
          note_id: "note-1",
          expected_updated_time: 10,
          parent_id: "folder-2",
        },
      },
      toolContext({ runId: "run-move-open", readableNoteIds: new Set() }),
    );

    expect(changes.getByRun("run-move-open")?.changes).toHaveLength(1);
  });

  test("proposes changing a note's manual order", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-reorder-note",
        name: "reorder_note",
        arguments: {
          note_id: "note-1",
          expected_updated_time: 10,
          order: 250,
        },
      },
      toolContext({
        runId: "run-reorder",
        readableNoteIds: new Set(["note-1"]),
      }),
    );

    expect(changes.getByRun("run-reorder")?.changes).toEqual([
      expect.objectContaining({
        kind: "note",
        operation: "reorder",
        noteId: "note-1",
        order: 250,
      }),
    ]);
  });

  test("proposes moving a versioned note to Joplin Trash", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-delete-note",
        name: "delete_note",
        arguments: { note_id: "note-1", expected_updated_time: 10 },
      },
      toolContext({
        runId: "run-delete",
        readableNoteIds: new Set(["note-1"]),
      }),
    );

    expect(changes.getByRun("run-delete")?.changes).toEqual([
      expect.objectContaining({
        kind: "note",
        operation: "delete",
        noteId: "note-1",
      }),
    ]);
  });

  test("proposes renaming a versioned notebook", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-rename-notebook",
        name: "rename_notebook",
        arguments: {
          notebook_id: "folder-1",
          expected_updated_time: 40,
          title: "Active projects",
        },
      },
      toolContext({ runId: "run-rename-notebook" }),
    );

    expect(changes.getByRun("run-rename-notebook")?.changes).toEqual([
      expect.objectContaining({
        kind: "notebook",
        operation: "rename",
        notebookId: "folder-1",
        title: "Active projects",
      }),
    ]);
  });

  test("proposes moving a versioned notebook to the vault root", async () => {
    const changes = new InMemoryChangeSetStore();
    const repository = new FakeNoteOrganizationRepository();
    repository.notebook = {
      id: "folder-nested",
      parentId: "folder-parent",
      title: "test",
      updatedTime: 40,
    };
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(registry, repository, changes);

    await registry.execute(
      {
        id: "call-move-notebook",
        name: "move_notebook",
        arguments: {
          notebook_id: "folder-nested",
          expected_updated_time: 40,
          parent_id: "",
        },
      },
      toolContext({ runId: "run-move-notebook-root" }),
    );

    expect(changes.getByRun("run-move-notebook-root")?.changes).toEqual([
      expect.objectContaining({
        kind: "notebook",
        operation: "move",
        notebookId: "folder-nested",
        parentId: "",
      }),
    ]);
  });

  test("treats omitted notebook parent_id as the vault root", async () => {
    const changes = new InMemoryChangeSetStore();
    const repository = new FakeNoteOrganizationRepository();
    repository.notebook = {
      id: "folder-nested",
      parentId: "folder-parent",
      title: "test",
      updatedTime: 40,
    };
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(registry, repository, changes);

    await registry.execute(
      {
        id: "call-move-notebook-omit",
        name: "move_notebook",
        arguments: {
          notebook_id: "folder-nested",
          expected_updated_time: 40,
        },
      },
      toolContext({ runId: "run-move-notebook-omit" }),
    );

    expect(changes.getByRun("run-move-notebook-omit")?.changes).toEqual([
      expect.objectContaining({
        kind: "notebook",
        operation: "move",
        parentId: "",
      }),
    ]);
  });

  test("rejects moving a notebook under itself", async () => {
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      new InMemoryChangeSetStore(),
    );

    await expect(
      registry.execute(
        {
          id: "call-move-self",
          name: "move_notebook",
          arguments: {
            notebook_id: "folder-1",
            expected_updated_time: 40,
            parent_id: "folder-1",
          },
        },
        toolContext({ runId: "run-move-self" }),
      ),
    ).rejects.toThrow("expected a different notebook ID or root");
  });

  test("rejects moving a note to the vault root", async () => {
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      new InMemoryChangeSetStore(),
    );

    await expect(
      registry.execute(
        {
          id: "call-move-note-root",
          name: "move_note",
          arguments: {
            note_id: "note-1",
            expected_updated_time: 10,
            parent_id: "",
          },
        },
        toolContext({
          runId: "run-move-note-root",
          readableNoteIds: new Set(["note-1"]),
        }),
      ),
    ).rejects.toThrow("expected schema for tool move_note");
  });

  test("accepts numeric timestamps encoded as strings", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-move-note-string-time",
        name: "move_note",
        arguments: {
          note_id: "note-1",
          expected_updated_time: "10",
          parent_id: "folder-2",
        },
      },
      toolContext({
        runId: "run-move-string-time",
        readableNoteIds: new Set(["note-1"]),
      }),
    );

    expect(changes.getByRun("run-move-string-time")?.changes).toEqual([
      expect.objectContaining({
        kind: "note",
        operation: "move",
        noteId: "note-1",
        parentId: "folder-2",
      }),
    ]);
  });

  test("rejects stale note versions before proposing a move", async () => {
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      new InMemoryChangeSetStore(),
    );

    await expect(
      registry.execute(
        {
          id: "call-stale-move",
          name: "move_note",
          arguments: {
            note_id: "note-1",
            expected_updated_time: 999,
            parent_id: "folder-2",
          },
        },
        toolContext({
          runId: "run-stale-move",
          readableNoteIds: new Set(["note-1"]),
        }),
      ),
    ).rejects.toThrow("expected updated_time 999");
  });

  test("proposes moving a versioned notebook and its contents to Trash", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-delete-notebook",
        name: "delete_notebook",
        arguments: {
          notebook_id: "folder-1",
          expected_updated_time: 40,
        },
      },
      toolContext({ runId: "run-delete-notebook" }),
    );

    expect(changes.getByRun("run-delete-notebook")?.changes).toEqual([
      expect.objectContaining({
        kind: "notebook",
        operation: "delete",
        notebookId: "folder-1",
      }),
    ]);
  });

  test("lists trashed notes and notebooks for restore targeting", async () => {
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      new InMemoryChangeSetStore(),
    );

    const result = await registry.execute(
      {
        id: "call-list-trash",
        name: "list_trash",
        arguments: { limit: 25 },
      },
      toolContext({ runId: "run-list-trash" }),
    );

    expect(result.output).toEqual({
      notes: [
        {
          id: "note-1",
          title: "Draft",
          parent_id: "folder-1",
          updated_time: 10,
          deleted_time: 99,
        },
      ],
      notebooks: [
        {
          id: "folder-1",
          title: "Projects",
          parent_id: "",
          updated_time: 40,
          deleted_time: 99,
        },
      ],
    });
  });

  test("proposes restoring a trashed note to a chosen notebook", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-restore-note",
        name: "restore_note",
        arguments: {
          note_id: "note-1",
          expected_updated_time: 10,
          parent_id: "folder-2",
        },
      },
      toolContext({ runId: "run-restore-note" }),
    );

    expect(changes.getByRun("run-restore-note")?.changes).toEqual([
      expect.objectContaining({
        kind: "note",
        operation: "restore",
        noteId: "note-1",
        parentId: "folder-2",
      }),
    ]);
  });

  test("proposes restoring a trashed notebook and its contents", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      changes,
    );

    await registry.execute(
      {
        id: "call-restore-notebook",
        name: "restore_notebook",
        arguments: {
          notebook_id: "folder-1",
          expected_updated_time: 40,
        },
      },
      toolContext({ runId: "run-restore-notebook" }),
    );

    expect(changes.getByRun("run-restore-notebook")?.changes).toEqual([
      expect.objectContaining({
        kind: "notebook",
        operation: "restore",
        notebookId: "folder-1",
      }),
    ]);
  });
});

describe("note organization secret notebooks", () => {
  test("rejects reading a secret notebook", async () => {
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      new InMemoryChangeSetStore(),
    );

    await expect(
      registry.execute(
        {
          id: "call-secret-notebook",
          name: "read_notebook",
          arguments: { notebook_id: "folder-1" },
        },
        toolContext({ secretNotebookIds: new Set(["folder-1"]) }),
      ),
    ).rejects.toThrow("marked secret");
  });

  test("rejects restoring a note into a secret notebook", async () => {
    const registry = new ToolRegistry();
    registerNoteOrganizationTools(
      registry,
      new FakeNoteOrganizationRepository(),
      new InMemoryChangeSetStore(),
    );

    await expect(
      registry.execute(
        {
          id: "call-restore-secret",
          name: "restore_note",
          arguments: {
            note_id: "note-1",
            expected_updated_time: 10,
            parent_id: "folder-secret",
          },
        },
        toolContext({
          runId: "run-restore-secret",
          secretNotebookIds: new Set(["folder-secret"]),
        }),
      ),
    ).rejects.toThrow("marked secret");
  });
});
