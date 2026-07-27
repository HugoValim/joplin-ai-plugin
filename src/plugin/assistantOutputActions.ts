import type { ActiveNoteContextSource } from "../agent/contextBuilder";
import type { NoteRepository } from "../notes/retriever";
import type { ChatStore, PersistedChatMessage } from "../persistence/chatStore";
import { DomainError, safeValue } from "../shared/errors";
import type { PanelRequest } from "../shared/protocol";
import type { CommandPort } from "./types";

type ActionRequest = Extract<
  PanelRequest,
  { type: "assistant.action" }
>["payload"];

export class AssistantOutputActions {
  public constructor(
    private readonly chats: ChatStore,
    private readonly activeSource: ActiveNoteContextSource,
    private readonly notes: NoteRepository,
    private readonly commands: CommandPort,
  ) {}

  /**
   * Applies one explicitly clicked assistant-output action to the active editor/note.
   *
   * @example await actions.execute(chatId, { messageId, action: 'insert-at-cursor' })
   */
  public async execute(
    chatId: string,
    request: ActionRequest,
  ): Promise<string> {
    const message = await this.requireAssistantMessage(
      chatId,
      request.messageId,
    );
    if (request.action === "insert-at-cursor") {
      await this.commands.execute("insertText", message.content);
      return "Inserted assistant output at cursor";
    }
    if (request.action === "replace-selection") {
      await this.commands.execute("replaceSelection", message.content);
      return "Replaced selection with assistant output";
    }
    const activeNote = await this.activeSource.activeNote();
    if (!activeNote) throw noActiveNote(request.action);
    if (request.action === "append-to-note") {
      await this.notes.updateNoteBody({
        noteId: activeNote.id,
        body: appendMarkdown(activeNote.body, message.content),
        expectedUpdatedTime: activeNote.updatedTime,
      });
      return "Appended assistant output to active note";
    }
    const title = request.title?.trim();
    if (!title) {
      throw new DomainError(
        "VALIDATION",
        `Invalid note title ${safeValue(request.title)}; expected non-empty text`,
      );
    }
    await this.notes.createNote({
      parentId: activeNote.parentId,
      title,
      body: message.content,
    });
    return `Created note ${title}`;
  }

  private async requireAssistantMessage(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage> {
    const chat = await this.chats.get(chatId);
    const message = chat?.messages.find((item) => item.id === messageId);
    if (message?.role === "assistant") return message;
    throw new DomainError(
      "NOT_AVAILABLE",
      `Message ${safeValue(messageId)} is unavailable in chat ${safeValue(chatId)}; expected a persisted assistant message`,
    );
  }
}

function appendMarkdown(body: string, addition: string): string {
  if (!body) return addition;
  if (body.endsWith("\n\n")) return `${body}${addition}`;
  if (body.endsWith("\n")) return `${body}\n${addition}`;
  return `${body}\n\n${addition}`;
}

function noActiveNote(action: ActionRequest["action"]): DomainError {
  return new DomainError(
    "NOT_AVAILABLE",
    `Assistant action ${action} has no active note; expected an editable selected note`,
  );
}
