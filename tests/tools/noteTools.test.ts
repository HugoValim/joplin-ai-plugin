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

class FakeNoteRepository implements NoteRepository {
  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [];
  }

  public async readNote(): Promise<NoteRecord> {
    return {
      id: "note-1",
      parentId: "folder-1",
      title: "Repeated text",
      body: "same and same",
      updatedTime: 10,
    };
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [];
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
        { chatId: "chat-1", runId: "run-1", hasFileWorkspace: false },
      ),
    ).rejects.toThrow("found 2 matches");
    expect(changes.getByRun("run-1")).toBeNull();
  });
});
