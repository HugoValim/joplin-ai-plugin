import type {
  CreateNotebookInput,
  NoteRecord,
  NoteRepository,
  NotebookMetadataRecord,
  NotebookRecord,
  TrashNoteInput,
} from "../notes/retriever";
import type { ChangeSet } from "../persistence/changeSetStore";
import type { SecretNotebookStore } from "../persistence/secretNotebookStore";
import type { CommandPort } from "./types";
import { renderReviewDiffDocument } from "./reviewDiffDocument";

export const AI_REVIEWS_NOTEBOOK_TITLE = "AI Reviews";

export interface ReviewNoteRepositoryPort extends NoteRepository {
  createNotebook(input: CreateNotebookInput): Promise<NotebookMetadataRecord>;
  trashNote(input: TrashNoteInput): Promise<unknown>;
}

export interface ReviewNotePort {
  openForChangeSet(changeSet: ChangeSet, chatTitle: string): Promise<string>;
  ensureOpen(changeSet: ChangeSet, chatTitle: string): Promise<string>;
  dispose(noteId: string): Promise<void>;
}

/**
 * Creates view-only Review Notes in a secret system notebook.
 *
 * @example await service.openForChangeSet(changeSet, chat.title)
 */
export class ReviewNoteService implements ReviewNotePort {
  private reviewsNotebookId: string | null = null;

  public constructor(
    private readonly notes: ReviewNoteRepositoryPort,
    private readonly secrets: SecretNotebookStore,
    private readonly commands: CommandPort,
  ) {}

  public async openForChangeSet(
    changeSet: ChangeSet,
    chatTitle: string,
  ): Promise<string> {
    const noteId = await this.writeReviewNote(changeSet, chatTitle);
    await this.commands.execute("openNote", noteId);
    return noteId;
  }

  public async ensureOpen(
    changeSet: ChangeSet,
    chatTitle: string,
  ): Promise<string> {
    if (changeSet.reviewNoteId) {
      const existing = await this.tryReadNote(changeSet.reviewNoteId);
      if (existing) {
        await this.commands.execute("openNote", existing.id);
        return existing.id;
      }
    }
    return this.openForChangeSet(changeSet, chatTitle);
  }

  public async dispose(noteId: string): Promise<void> {
    try {
      const note = await this.notes.readNote(noteId);
      await this.notes.trashNote({
        noteId,
        expectedUpdatedTime: note.updatedTime,
      });
    } catch {
      return;
    }
  }

  private async writeReviewNote(
    changeSet: ChangeSet,
    chatTitle: string,
  ): Promise<string> {
    const parentId = await this.ensureReviewsNotebook();
    const body = renderReviewDiffDocument({ chatTitle, changeSet });
    const title = reviewNoteTitle(chatTitle, changeSet.changes.length);

    if (changeSet.reviewNoteId) {
      const existing = await this.tryReadNote(changeSet.reviewNoteId);
      if (existing) {
        const updated = await this.notes.updateNoteBody({
          noteId: existing.id,
          body,
          expectedUpdatedTime: existing.updatedTime,
        });
        return updated.id;
      }
    }

    const created = await this.notes.createNote({ parentId, title, body });
    return created.id;
  }

  private async ensureReviewsNotebook(): Promise<string> {
    if (this.reviewsNotebookId) return this.reviewsNotebookId;

    const notebooks = await this.notes.listNotebooks();
    const existing = notebooks.find(
      (notebook) => notebook.title === AI_REVIEWS_NOTEBOOK_TITLE,
    );
    if (existing) {
      this.reviewsNotebookId = existing.id;
      await this.secrets.mark(existing.id);
      return existing.id;
    }

    const created = await this.createReviewsNotebook();
    this.reviewsNotebookId = created.id;
    await this.secrets.mark(created.id);
    return created.id;
  }

  private async createReviewsNotebook(): Promise<NotebookRecord> {
    const input: CreateNotebookInput = {
      parentId: "",
      title: AI_REVIEWS_NOTEBOOK_TITLE,
    };
    const created = await this.notes.createNotebook(input);
    return {
      id: created.id,
      title: created.title,
      parentId: created.parentId,
    };
  }

  private async tryReadNote(noteId: string): Promise<NoteRecord | null> {
    try {
      return await this.notes.readNote(noteId);
    } catch {
      return null;
    }
  }
}

function reviewNoteTitle(chatTitle: string, changeCount: number): string {
  const trimmed = chatTitle.trim() || "Chat";
  return `[AI Review] ${trimmed} · ${changeCount} changes`;
}

/**
 * No-op Review Note port for tests that do not exercise review notes.
 */
export class NoOpReviewNotePort implements ReviewNotePort {
  public openForChangeSet(
    changeSet: ChangeSet,
    _chatTitle: string,
  ): Promise<string> {
    return Promise.resolve(changeSet.reviewNoteId ?? "review-note-noop");
  }

  public ensureOpen(changeSet: ChangeSet, _chatTitle: string): Promise<string> {
    return Promise.resolve(changeSet.reviewNoteId ?? "review-note-noop");
  }

  public dispose(_noteId: string): Promise<void> {
    return Promise.resolve();
  }
}
