import {
  JoplinNoteRepository,
  type JoplinDataPort,
} from "../../src/notes/joplinNoteRepository";

class FakeJoplinDataPort implements JoplinDataPort {
  public putCount = 0;

  public async get(): Promise<unknown> {
    return {
      id: "note-1",
      parent_id: "folder-1",
      title: "Concurrent note",
      body: "Changed elsewhere",
      updated_time: 20,
    };
  }

  public async post(): Promise<unknown> {
    throw new Error("Not used");
  }

  public async put(): Promise<unknown> {
    this.putCount += 1;
    throw new Error("Unexpected write");
  }
}

describe("JoplinNoteRepository", () => {
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
