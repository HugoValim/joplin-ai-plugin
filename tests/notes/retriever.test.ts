import {
  NoteRetriever,
  type NoteRecord,
  type NoteRepository,
  type NoteSearchHit,
  type NotebookRecord,
  type SemanticNoteSearch,
} from "../../src/notes/retriever";

class FakeNoteRepository implements NoteRepository {
  public searchCount = 0;
  public searchHits: readonly NoteSearchHit[] = [];
  public notes = new Map<string, NoteRecord>();

  public async searchNotes(
    _query: string,
    _limit: number,
  ): Promise<readonly NoteSearchHit[]> {
    this.searchCount += 1;
    return this.searchHits;
  }

  public async readNote(noteId: string): Promise<NoteRecord> {
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`No note configured for ${noteId}`);
    return note;
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [];
  }

  public async createNote(): Promise<NoteRecord> {
    throw new Error("Not used");
  }

  public async updateNoteBody(): Promise<NoteRecord> {
    throw new Error("Not used");
  }
}

class FailingSemanticNoteSearch implements SemanticNoteSearch {
  public async search(): Promise<never> {
    throw new Error("Native semantic index unavailable");
  }
}

describe("NoteRetriever", () => {
  test("does not inspect the vault when retrieval is disabled", async () => {
    const repository = new FakeNoteRepository();
    const retriever = new NoteRetriever(repository);

    const snippets = await retriever.retrieve("private topic", false);

    expect(snippets).toEqual([]);
    expect(repository.searchCount).toBe(0);
  });

  test("returns ranked Markdown chunks with citation metadata", async () => {
    const repository = new FakeNoteRepository();
    const note: NoteRecord = {
      id: "note-1",
      parentId: "folder-1",
      title: "Deployment guide",
      body: [
        "# Overview",
        "Routine background.",
        "",
        "## Blue-green deployment",
        "Blue-green deployment keeps the old service ready during rollout.",
      ].join("\n"),
      updatedTime: 10,
    };
    repository.searchHits = [note];
    repository.notes.set(note.id, note);

    const snippets = await new NoteRetriever(repository).retrieve(
      "blue green deployment",
      true,
    );

    expect(snippets[0]).toMatchObject({
      noteId: "note-1",
      title: "Deployment guide",
      heading: "Blue-green deployment",
      lineStart: 4,
      lineEnd: 5,
    });
    expect(snippets[0]?.text).toContain("old service");
    expect(snippets).toHaveLength(2);
  });

  test("falls back to keyword retrieval when native semantic search fails", async () => {
    const repository = new FakeNoteRepository();
    const note: NoteRecord = {
      id: "note-2",
      parentId: "folder-1",
      title: "Incident notes",
      body: "# Recovery\nRestore the database from a tested backup.",
      updatedTime: 20,
    };
    repository.searchHits = [note];
    repository.notes.set(note.id, note);
    const retriever = new NoteRetriever(
      repository,
      new FailingSemanticNoteSearch(),
    );

    const snippets = await retriever.retrieve("database recovery", true);

    expect(snippets[0]?.noteId).toBe("note-2");
  });
});
