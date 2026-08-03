import {
  searchMentionHits,
  type MentionSearchPort,
} from "../../src/plugin/mentionSearch";
import type {
  NoteRecord,
  NoteSearchHit,
  NotebookRecord,
  NoteMetadataRecord,
} from "../../src/notes/retriever";

class FakeMentionSearch implements MentionSearchPort {
  public constructor(
    private readonly notes: readonly NoteRecord[],
    private readonly notebooks: readonly NotebookRecord[],
  ) {}

  public async searchNotes(
    query: string,
    limit: number,
  ): Promise<readonly NoteSearchHit[]> {
    const needle = query.toLowerCase();
    return this.notes
      .filter((note) => note.title.toLowerCase().includes(needle))
      .slice(0, limit);
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return this.notebooks;
  }

  public async listNotebookNotes(
    notebookId: string,
    limit: number,
  ): Promise<readonly NoteMetadataRecord[]> {
    return this.notes
      .filter((note) => note.parentId === notebookId)
      .slice(0, limit)
      .map((note) => ({
        id: note.id,
        title: note.title,
        updatedTime: note.updatedTime,
        parentId: note.parentId,
        order: 0,
      }));
  }

  public async readNote(noteId: string): Promise<NoteRecord> {
    const note = this.notes.find((item) => item.id === noteId);
    if (!note) throw new Error(`missing note ${noteId}`);
    return note;
  }
}

describe("searchMentionHits", () => {
  const notebooks: NotebookRecord[] = [
    { id: "nb-public", title: "Public", parentId: "" },
    { id: "nb-secret", title: "Secrets", parentId: "" },
  ];
  const notes: NoteRecord[] = [
    {
      id: "note-guide",
      title: "Guide",
      parentId: "nb-public",
      body: "body",
      updatedTime: 1,
    },
    {
      id: "note-secret",
      title: "Guide secret",
      parentId: "nb-secret",
      body: "secret",
      updatedTime: 1,
    },
  ];

  test("returns matching notes and notebooks while excluding secrets", async () => {
    const port = new FakeMentionSearch(notes, notebooks);
    const hits = await searchMentionHits(
      port,
      "gui",
      new Set(["nb-secret"]),
      10,
    );
    expect(hits).toEqual([{ kind: "note", id: "note-guide", title: "Guide" }]);
  });

  test("includes notebooks when the query matches their title", async () => {
    const port = new FakeMentionSearch(notes, notebooks);
    const hits = await searchMentionHits(port, "pub", new Set(), 10);
    expect(hits).toEqual([
      { kind: "notebook", id: "nb-public", title: "Public" },
    ]);
  });
});
