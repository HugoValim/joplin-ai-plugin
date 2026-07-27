import type {
  CreateNotebookInput,
  NoteMetadataRecord,
  NoteOrganizationRepository,
  NotebookMetadataRecord,
  TrashNoteInput,
  TrashNotebookInput,
  UpdateNoteMetadataInput,
  UpdateNotebookMetadataInput,
} from "../../src/notes/retriever";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { registerNoteOrganizationTools } from "../../src/tools/noteOrganizationTools";
import { ToolRegistry } from "../../src/tools/toolRegistry";

class FakeNoteOrganizationRepository implements NoteOrganizationRepository {
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

  public async trashNote(_input: TrashNoteInput): Promise<void> {
    throw new Error("Proposal tools must not write");
  }

  public async trashNotebook(_input: TrashNotebookInput): Promise<void> {
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
      { chatId: "chat-1", runId: "run-read", hasFileWorkspace: false },
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
      { chatId: "chat-1", runId: "run-list", hasFileWorkspace: false },
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
      { chatId: "chat-1", runId: "run-1", hasFileWorkspace: false },
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
      { chatId: "chat-1", runId: "run-rename", hasFileWorkspace: false },
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
      { chatId: "chat-1", runId: "run-move", hasFileWorkspace: false },
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
      { chatId: "chat-1", runId: "run-reorder", hasFileWorkspace: false },
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
      { chatId: "chat-1", runId: "run-delete", hasFileWorkspace: false },
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
      {
        chatId: "chat-1",
        runId: "run-rename-notebook",
        hasFileWorkspace: false,
      },
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
      {
        chatId: "chat-1",
        runId: "run-delete-notebook",
        hasFileWorkspace: false,
      },
    );

    expect(changes.getByRun("run-delete-notebook")?.changes).toEqual([
      expect.objectContaining({
        kind: "notebook",
        operation: "delete",
        notebookId: "folder-1",
      }),
    ]);
  });
});
