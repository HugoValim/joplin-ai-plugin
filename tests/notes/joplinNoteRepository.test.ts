import {
  JoplinNoteRepository,
  type JoplinDataPort,
} from "../../src/notes/joplinNoteRepository";

class FakeJoplinDataPort implements JoplinDataPort {
  public putCount = 0;
  public readonly putCalls: {
    readonly path: string[];
    readonly body?: Record<string, unknown>;
  }[] = [];
  public readonly deleteCalls: {
    readonly path: string[];
    readonly query?: Record<string, unknown>;
  }[] = [];
  public readonly getCalls: {
    readonly path: string[];
    readonly query?: Record<string, unknown>;
  }[] = [];

  public constructor(
    private readonly getResponse: unknown = {
      id: "note-1",
      parent_id: "folder-1",
      title: "Concurrent note",
      body: "Changed elsewhere",
      updated_time: 20,
      order: 7,
    },
    private readonly postResponse?: unknown,
  ) {}

  public async get(
    path: string[],
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    this.getCalls.push({ path, ...(query ? { query } : {}) });
    return this.getResponse;
  }

  public readonly postCalls: {
    readonly path: string[];
    readonly body?: Record<string, unknown>;
  }[] = [];

  public async post(
    path: string[],
    _query?: Record<string, unknown> | null,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    this.postCalls.push({ path, ...(body ? { body } : {}) });
    if (this.postResponse !== undefined) return this.postResponse;
    throw new Error("Not used");
  }

  public async put(
    path: string[],
    _query?: Record<string, unknown> | null,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    this.putCount += 1;
    this.putCalls.push({ path, ...(body ? { body } : {}) });
    return {};
  }

  public async delete(
    path: string[],
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    this.deleteCalls.push({ path, ...(query ? { query } : {}) });
    return {};
  }
}

describe("JoplinNoteRepository", () => {
  test("reads note organization metadata needed for moves and ordering", async () => {
    const repository = new JoplinNoteRepository(new FakeJoplinDataPort());

    await expect(repository.readNoteMetadata("note-1")).resolves.toEqual({
      id: "note-1",
      parentId: "folder-1",
      title: "Concurrent note",
      updatedTime: 20,
      order: 7,
    });
  });

  test("lists notes in one notebook by manual order", async () => {
    const dataPort = new FakeJoplinDataPort({
      items: [
        {
          id: "note-2",
          parent_id: "folder-1",
          title: "Second",
          updated_time: 30,
          order: 200,
        },
      ],
      has_more: false,
    });
    const repository = new JoplinNoteRepository(dataPort);

    await expect(repository.listNotebookNotes("folder-1", 25)).resolves.toEqual(
      [
        {
          id: "note-2",
          parentId: "folder-1",
          title: "Second",
          updatedTime: 30,
          order: 200,
        },
      ],
    );
    expect(dataPort.getCalls).toEqual([
      {
        path: ["folders", "folder-1", "notes"],
        query: {
          fields: ["id", "parent_id", "title", "updated_time", "order"],
          limit: 25,
          order_by: "order",
          order_dir: "ASC",
        },
      },
    ]);
  });

  test("reads versioned notebook metadata", async () => {
    const repository = new JoplinNoteRepository(
      new FakeJoplinDataPort({
        id: "folder-1",
        parent_id: "",
        title: "Projects",
        updated_time: 40,
      }),
    );

    await expect(repository.readNotebook("folder-1")).resolves.toEqual({
      id: "folder-1",
      parentId: "",
      title: "Projects",
      updatedTime: 40,
    });
  });

  test("creates a root or nested notebook", async () => {
    const dataPort = new FakeJoplinDataPort(
      {},
      {
        id: "folder-2",
        parent_id: "folder-1",
        title: "Archive",
        updated_time: 50,
      },
    );
    const repository = new JoplinNoteRepository(dataPort);

    await expect(
      repository.createNotebook({
        parentId: "folder-1",
        title: "Archive",
      }),
    ).resolves.toMatchObject({
      id: "folder-2",
      parentId: "folder-1",
      title: "Archive",
    });
    expect(dataPort.postCalls).toEqual([
      {
        path: ["folders"],
        body: { parent_id: "folder-1", title: "Archive" },
      },
    ]);
  });

  test("updates note organization metadata after a version check", async () => {
    const dataPort = new FakeJoplinDataPort();
    const repository = new JoplinNoteRepository(dataPort);

    await repository.updateNoteMetadata({
      noteId: "note-1",
      expectedUpdatedTime: 20,
      title: "Renamed",
      parentId: "folder-2",
      order: 100,
    });

    expect(dataPort.putCalls).toEqual([
      {
        path: ["notes", "note-1"],
        body: { title: "Renamed", parent_id: "folder-2", order: 100 },
      },
    ]);
  });

  test("renames or moves a notebook after a version check", async () => {
    const dataPort = new FakeJoplinDataPort({
      id: "folder-1",
      parent_id: "",
      title: "Projects",
      updated_time: 40,
    });
    const repository = new JoplinNoteRepository(dataPort);

    await repository.updateNotebookMetadata({
      notebookId: "folder-1",
      expectedUpdatedTime: 40,
      title: "Active projects",
      parentId: "folder-2",
    });

    expect(dataPort.putCalls).toEqual([
      {
        path: ["folders", "folder-1"],
        body: { title: "Active projects", parent_id: "folder-2" },
      },
    ]);
  });

  test("moves a versioned note to Joplin Trash without permanent deletion", async () => {
    const dataPort = new FakeJoplinDataPort();
    const repository = new JoplinNoteRepository(dataPort);

    await repository.trashNote({
      noteId: "note-1",
      expectedUpdatedTime: 20,
    });

    expect(dataPort.deleteCalls).toEqual([{ path: ["notes", "note-1"] }]);
  });

  test("moves a versioned notebook to Joplin Trash without permanent deletion", async () => {
    const dataPort = new FakeJoplinDataPort({
      id: "folder-1",
      parent_id: "",
      title: "Archive",
      updated_time: 40,
    });
    const repository = new JoplinNoteRepository(dataPort);

    await repository.trashNotebook({
      notebookId: "folder-1",
      expectedUpdatedTime: 40,
    });

    expect(dataPort.deleteCalls).toEqual([{ path: ["folders", "folder-1"] }]);
  });

  test("does not overwrite a note changed after it was read", async () => {
    const dataPort = new FakeJoplinDataPort();
    const repository = new JoplinNoteRepository(dataPort);

    await expect(
      repository.updateNoteBody({
        noteId: "note-1",
        body: "Proposed body",
        expectedUpdatedTime: 10,
      }),
    ).rejects.toThrow("expected updated_time 10");
    expect(dataPort.putCount).toBe(0);
  });
});
