import type {
  CreateNoteInput,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NotebookRecord,
  UpdateNoteBodyInput,
} from "../../src/notes/retriever";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { registerNoteTools } from "../../src/tools/noteTools";
import { ToolRegistry } from "../../src/tools/toolRegistry";
import { toolContext } from "../helpers/toolContext";

class FakeNoteRepository implements NoteRepository {
  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [{ id: "note-2", title: "Other", updatedTime: 1 }];
  }

  public async readNote(noteId: string): Promise<NoteRecord> {
    return {
      id: noteId,
      parentId: noteId === "note-secret" ? "nb-secret" : "folder-1",
      title: noteId === "note-1" ? "Allowed" : "Other",
      body: noteId === "note-1" ? "same and same" : "content",
      updatedTime: 10,
    };
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [
      { id: "nb-1", title: "Inbox", parentId: "" },
      { id: "nb-secret", title: "Secret", parentId: "" },
    ];
  }

  public async createNote(_input: CreateNoteInput): Promise<NoteRecord> {
    throw new Error("Proposal tools must not write");
  }

  public async updateNoteBody(
    _input: UpdateNoteBodyInput,
  ): Promise<NoteRecord> {
    throw new Error("Proposal tools must not write");
  }
}

describe("note tool privacy allowlist", () => {
  test("always exposes vault-wide search and notebook listing", () => {
    const registry = new ToolRegistry();
    registerNoteTools(registry, new FakeNoteRepository(), new InMemoryChangeSetStore());

    const definitions = registry.providerDefinitions(
      toolContext({ vault: false, readableNoteIds: new Set(["note-1"]) }),
    );
    expect(definitions.map((tool) => tool.name)).toContain("search_notes");
    expect(definitions.map((tool) => tool.name)).toContain("list_notebooks");
  });

  test("allows read_note only for active or attached note IDs", async () => {
    const registry = new ToolRegistry();
    registerNoteTools(registry, new FakeNoteRepository(), new InMemoryChangeSetStore());
    const context = toolContext({
      vault: false,
      readableNoteIds: new Set(["note-1"]),
    });

    await expect(
      registry.execute(
        { id: "call-1", name: "read_note", arguments: { note_id: "note-2" } },
        context,
      ),
    ).rejects.toThrow("outside the enabled context allowlist");

    const allowed = await registry.execute(
      { id: "call-2", name: "read_note", arguments: { note_id: "note-1" } },
      context,
    );
    expect(allowed.output).toMatchObject({ id: "note-1" });
  });

  test("filters secret notebooks from search and list results", async () => {
    const registry = new ToolRegistry();
    const repository = new FakeNoteRepository();
    registerNoteTools(registry, repository, new InMemoryChangeSetStore());
    const context = toolContext({ secretNotebookIds: new Set(["nb-secret"]) });

    const search = await registry.execute(
      { id: "call-search", name: "search_notes", arguments: { query: "Other" } },
      context,
    );
    expect(search.output).toEqual({
      notes: [{ id: "note-2", title: "Other", updated_time: 1 }],
    });

    repository.searchNotes = async () => [
      { id: "note-secret", title: "Secret", updatedTime: 2 },
    ];
    const secretSearch = await registry.execute(
      {
        id: "call-secret-search",
        name: "search_notes",
        arguments: { query: "Secret" },
      },
      toolContext({ secretNotebookIds: new Set(["nb-secret"]) }),
    );
    expect(secretSearch.output).toEqual({ notes: [] });

    const notebooks = await registry.execute(
      { id: "call-list", name: "list_notebooks", arguments: {} },
      context,
    );
    expect(notebooks.output).toEqual({
      notebooks: [{ id: "nb-1", title: "Inbox", parent_id: "" }],
    });
  });

  test("rejects creating notes in secret notebooks", async () => {
    const registry = new ToolRegistry();
    registerNoteTools(
      registry,
      new FakeNoteRepository(),
      new InMemoryChangeSetStore(),
    );

    await expect(
      registry.execute(
        {
          id: "call-create",
          name: "create_note",
          arguments: {
            parent_id: "nb-secret",
            title: "Hidden",
            body: "Secret",
          },
        },
        toolContext({ secretNotebookIds: new Set(["nb-secret"]) }),
      ),
    ).rejects.toThrow("marked secret");
  });
});

describe("note proposal tools", () => {
  test("rejects an ambiguous exact replacement unless replace_all is declared", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerNoteTools(registry, new FakeNoteRepository(), changes);

    await expect(
      registry.execute(
        {
          id: "call-1",
          name: "replace_note_text",
          arguments: {
            note_id: "note-1",
            expected_updated_time: 10,
            search: "same",
            replacement: "clear",
          },
        },
        toolContext({ readableNoteIds: new Set(["note-1"]) }),
      ),
    ).rejects.toThrow("found 2 matches");
    expect(changes.getByRun("run-1")).toBeNull();
  });
});
