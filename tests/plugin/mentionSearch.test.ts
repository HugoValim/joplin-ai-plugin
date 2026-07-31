import { searchMentions } from "../../src/plugin/mentionSearch";
import type { NoteRepository } from "../../src/notes/retriever";
import type {
  NoteSearchHit,
  NotebookRecord,
  NoteRecord,
} from "../../src/notes/retriever";

class StubNoteRepository implements NoteRepository {
  public constructor(
    private readonly hits: readonly NoteSearchHit[],
    private readonly notebooks: readonly NotebookRecord[],
  ) {}

  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return this.hits;
  }

  public async readNote(): Promise<NoteRecord> {
    throw new Error("Unexpected note read");
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return this.notebooks;
  }

  public async createNote(): Promise<NoteRecord> {
    throw new Error("Unexpected note create");
  }

  public async updateNoteBody(): Promise<NoteRecord> {
    throw new Error("Unexpected note update");
  }
}

describe("searchMentions", () => {
  test("returns note hits and matching notebooks for a query", async () => {
    const notes = new StubNoteRepository(
      [{ id: "note-1", title: "Deploy guide", updatedTime: 1 }],
      [
        { id: "nb-1", title: "Deploy", parentId: "nb-0" },
        { id: "nb-2", title: "Recipes", parentId: "nb-0" },
      ],
    );

    const candidates = await searchMentions(notes, "deploy");

    expect(candidates).toEqual([
      { kind: "note", id: "note-1", title: "Deploy guide" },
      { kind: "notebook", id: "nb-1", title: "Deploy", parentId: "nb-0" },
    ]);
  });

  test("returns all notebooks when the query is empty", async () => {
    const notes = new StubNoteRepository(
      [{ id: "note-1", title: "Anything", updatedTime: 1 }],
      [
        { id: "nb-1", title: "Projects", parentId: "nb-0" },
        { id: "nb-2", title: "Inbox", parentId: "nb-0" },
      ],
    );

    const candidates = await searchMentions(notes, "");

    expect(candidates.map((c) => c.kind)).toEqual([
      "note",
      "notebook",
      "notebook",
    ]);
  });
});
