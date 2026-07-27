import type { ActiveNoteContextSource } from "../../src/agent/contextBuilder";
import type {
  CreateNoteInput,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NotebookRecord,
  UpdateNoteBodyInput,
} from "../../src/notes/retriever";
import { ChatStore } from "../../src/persistence/chatStore";
import { AssistantOutputActions } from "../../src/plugin/assistantOutputActions";
import type { CommandPort } from "../../src/plugin/types";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

const ACTIVE_NOTE: NoteRecord = {
  id: "note-1",
  parentId: "folder-1",
  title: "Active",
  body: "Existing",
  updatedTime: 10,
};

class FakeActiveNoteSource implements ActiveNoteContextSource {
  public async activeNote(): Promise<NoteRecord> {
    return ACTIVE_NOTE;
  }

  public async selectedText(): Promise<string> {
    return "";
  }
}

class RecordingNoteRepository implements NoteRepository {
  public readonly created: CreateNoteInput[] = [];
  public readonly updated: UpdateNoteBodyInput[] = [];

  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [];
  }

  public async readNote(): Promise<NoteRecord> {
    return ACTIVE_NOTE;
  }

  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [];
  }

  public async createNote(input: CreateNoteInput): Promise<NoteRecord> {
    this.created.push(input);
    return { ...ACTIVE_NOTE, title: input.title, body: input.body };
  }

  public async updateNoteBody(input: UpdateNoteBodyInput): Promise<NoteRecord> {
    this.updated.push(input);
    return { ...ACTIVE_NOTE, body: input.body, updatedTime: 11 };
  }
}

class RecordingCommandPort implements CommandPort {
  public readonly calls: { name: string; args: readonly unknown[] }[] = [];

  public async execute(name: string, ...args: unknown[]): Promise<void> {
    this.calls.push({ name, args });
  }
}

async function createFixture(): Promise<{
  actions: AssistantOutputActions;
  chatId: string;
  notes: RecordingNoteRepository;
  commands: RecordingCommandPort;
}> {
  const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
  const chat = await chats.create("Actions");
  await chats.save({
    ...chat,
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Suggested text",
        createdAt: 1,
      },
    ],
  });
  const notes = new RecordingNoteRepository();
  const commands = new RecordingCommandPort();
  return {
    actions: new AssistantOutputActions(
      chats,
      new FakeActiveNoteSource(),
      notes,
      commands,
    ),
    chatId: chat.id,
    notes,
    commands,
  };
}

describe("AssistantOutputActions", () => {
  test.each([
    ["insert-at-cursor", "insertText"],
    ["replace-selection", "replaceSelection"],
  ] as const)("executes explicit %s editor action", async (action, command) => {
    const fixture = await createFixture();

    await fixture.actions.execute(fixture.chatId, {
      messageId: "assistant-1",
      action,
    });

    expect(fixture.commands.calls).toEqual([
      { name: command, args: ["Suggested text"] },
    ]);
  });

  test("appends through optimistic note update", async () => {
    const fixture = await createFixture();

    await fixture.actions.execute(fixture.chatId, {
      messageId: "assistant-1",
      action: "append-to-note",
    });

    expect(fixture.notes.updated).toEqual([
      {
        noteId: "note-1",
        body: "Existing\n\nSuggested text",
        expectedUpdatedTime: 10,
      },
    ]);
  });

  test("creates in the active note notebook", async () => {
    const fixture = await createFixture();

    await fixture.actions.execute(fixture.chatId, {
      messageId: "assistant-1",
      action: "create-note",
      title: "New note",
    });

    expect(fixture.notes.created).toEqual([
      {
        parentId: "folder-1",
        title: "New note",
        body: "Suggested text",
      },
    ]);
  });
});
