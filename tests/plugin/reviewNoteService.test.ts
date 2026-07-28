import type {
  CreateNoteInput,
  CreateNotebookInput,
  NoteRecord,
  NoteSearchHit,
  NotebookMetadataRecord,
  NotebookRecord,
  TrashNoteInput,
  UpdateNoteBodyInput,
} from "../../src/notes/retriever";
import type { ChangeSet } from "../../src/persistence/changeSetStore";
import { SecretNotebookStore } from "../../src/persistence/secretNotebookStore";
import {
  AI_REVIEWS_NOTEBOOK_TITLE,
  ReviewNoteService,
} from "../../src/plugin/reviewNoteService";

class MemorySecretJsonPort {
  public readonly files = new Map<string, string>();

  public async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  public async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

function createSecretNotebookStore(): SecretNotebookStore {
  return new SecretNotebookStore(new MemorySecretJsonPort());
}

class MutableReviewNoteRepository {
  public readonly notebooks: NotebookRecord[] = [];
  public readonly notes = new Map<string, NoteRecord>();
  public readonly trashed: string[] = [];
  public openNoteIds: string[] = [];

  public constructor() {
    this.notebooks.push({
      id: "nb-reviews",
      title: AI_REVIEWS_NOTEBOOK_TITLE,
      parentId: "",
    });
    this.notes.set("nb-reviews-note", {
      id: "nb-reviews-note",
      parentId: "nb-reviews",
      title: "Existing review",
      body: "Old review body",
      updatedTime: 5,
    });
  }

  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [];
  }

  public async readNote(noteId: string): Promise<NoteRecord> {
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`Missing note ${noteId}`);
    return note;
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return this.notebooks;
  }

  public async createNotebook(
    input: CreateNotebookInput,
  ): Promise<NotebookMetadataRecord> {
    const created = {
      id: `nb-${this.notebooks.length + 1}`,
      title: input.title,
      parentId: input.parentId,
      updatedTime: 1,
    };
    this.notebooks.push(created);
    return created;
  }

  public async createNote(input: CreateNoteInput): Promise<NoteRecord> {
    const created = {
      id: `note-${this.notes.size + 1}`,
      parentId: input.parentId,
      title: input.title,
      body: input.body,
      updatedTime: 1,
    };
    this.notes.set(created.id, created);
    return created;
  }

  public async updateNoteBody(input: UpdateNoteBodyInput): Promise<NoteRecord> {
    const current = await this.readNote(input.noteId);
    const updated = {
      ...current,
      body: input.body,
      updatedTime: current.updatedTime + 1,
    };
    this.notes.set(updated.id, updated);
    return updated;
  }

  public async trashNote(input: TrashNoteInput): Promise<void> {
    this.trashed.push(input.noteId);
    this.notes.delete(input.noteId);
  }
}

class RecordingCommands {
  public openNoteIds: string[] = [];

  public async execute(commandName: string, ...args: unknown[]): Promise<unknown> {
    if (commandName === "openNote") {
      this.openNoteIds.push(String(args[0]));
    }
    return undefined;
  }
}

function sampleChangeSet(reviewNoteId?: string): ChangeSet {
  return {
    id: "changes-1",
    chatId: "chat-1",
    runId: "run-1",
    createdAt: 1,
    status: "proposed",
    ...(reviewNoteId ? { reviewNoteId } : {}),
    changes: [
      {
        id: "change-1",
        kind: "note",
        operation: "update",
        noteId: "note-1",
        expectedUpdatedTime: 10,
        targetLabel: "Guide",
        before: "Old",
        after: "New",
        diff: "-Old\n+New",
        status: "proposed",
      },
    ],
  };
}

describe("ReviewNoteService", () => {
  test("creates a review note in the secret AI Reviews notebook", async () => {
    const notes = new MutableReviewNoteRepository();
    const commands = new RecordingCommands();
    const secrets = createSecretNotebookStore();
    const service = new ReviewNoteService(notes, secrets, commands);

    const noteId = await service.openForChangeSet(sampleChangeSet(), "Draft chat");

    const note = notes.notes.get(noteId);
    expect(note?.parentId).toBe("nb-reviews");
    expect(note?.body).toContain("View-only review document");
    expect(note?.title).toContain("[AI Review] Draft chat");
    expect([...(await secrets.list())]).toEqual(["nb-reviews"]);
    expect(commands.openNoteIds).toEqual([noteId]);
  });

  test("updates an existing review note when reviewNoteId is still present", async () => {
    const notes = new MutableReviewNoteRepository();
    const commands = new RecordingCommands();
    const secrets = createSecretNotebookStore();
    const service = new ReviewNoteService(notes, secrets, commands);

    const noteId = await service.openForChangeSet(
      sampleChangeSet("nb-reviews-note"),
      "Draft chat",
    );

    expect(noteId).toBe("nb-reviews-note");
    expect(notes.notes.get(noteId)?.body).toContain("View-only review document");
    expect(notes.notes.size).toBe(1);
  });

  test("recreates a missing review note on ensureOpen", async () => {
    const notes = new MutableReviewNoteRepository();
    notes.notes.delete("nb-reviews-note");
    const commands = new RecordingCommands();
    const secrets = createSecretNotebookStore();
    const service = new ReviewNoteService(notes, secrets, commands);

    const noteId = await service.ensureOpen(
      sampleChangeSet("nb-reviews-note"),
      "Draft chat",
    );

    expect(noteId).not.toBe("nb-reviews-note");
    expect(notes.notes.has(noteId)).toBe(true);
    expect(commands.openNoteIds).toEqual([noteId]);
  });

  test("disposes review notes best-effort", async () => {
    const notes = new MutableReviewNoteRepository();
    const service = new ReviewNoteService(
      notes,
      createSecretNotebookStore(),
      new RecordingCommands(),
    );

    await service.dispose("nb-reviews-note");

    expect(notes.trashed).toEqual(["nb-reviews-note"]);
    await expect(service.dispose("missing-note")).resolves.toBeUndefined();
  });
});
