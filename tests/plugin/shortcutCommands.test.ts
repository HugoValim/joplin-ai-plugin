import { MenuItemLocation } from "../../api/types";
import {
  registerNewChatWithSelectionShortcut,
  registerSelectionToChatShortcut,
  registerToggleSidebarShortcut,
  type SelectionShortcutNote,
  type SelectionShortcutSource,
} from "../../src/plugin/shortcutCommands";
import type { EditorSelectionQuery } from "../../src/plugin/editorSelectionRange";
import type { EditorSelectionLineRange } from "../../src/shared/editorSelectionRange";
import type { PluginEvent } from "../../src/shared/protocol";
import type { SelectionRefInput } from "../../src/shared/selectionRef";

interface RegisteredCommand {
  readonly name: string;
  readonly label: string;
  readonly execute: () => Promise<void>;
}

class RecordingCommandRegistry {
  public readonly commands: RegisteredCommand[] = [];

  public async register(command: RegisteredCommand): Promise<void> {
    this.commands.push(command);
  }
}

interface RecordedMenuItem {
  readonly id: string;
  readonly commandName: string;
  readonly location: MenuItemLocation;
  readonly accelerator: string;
}

class RecordingMenuItemRegistry {
  public readonly items: RecordedMenuItem[] = [];

  public async create(
    id: string,
    commandName: string,
    location: MenuItemLocation,
    options: { readonly accelerator: string },
  ): Promise<void> {
    this.items.push({ id, commandName, location, ...options });
  }
}

class RecordingShortcutPanel {
  public readonly events: PluginEvent[] = [];
  public toggleCount = 0;
  public showCount = 0;

  public async toggleVisibility(): Promise<void> {
    this.toggleCount += 1;
  }

  public async show(): Promise<void> {
    this.showCount += 1;
  }

  public post(event: PluginEvent): void {
    this.events.push(event);
  }
}

class FakeSelectionSource implements SelectionShortcutSource {
  public constructor(
    private readonly text: string,
    private readonly note: SelectionShortcutNote | null,
  ) {}

  public async activeNote(): Promise<SelectionShortcutNote | null> {
    return this.note;
  }

  public async selectedText(): Promise<string> {
    return this.text;
  }
}

class FakeEditorSelectionQuery implements EditorSelectionQuery {
  public constructor(private readonly range: EditorSelectionLineRange | null) {}

  public async lineRange(): Promise<EditorSelectionLineRange | null> {
    return this.range;
  }
}

const richTextEditor = new FakeEditorSelectionQuery(null);

const sampleNote: SelectionShortcutNote = {
  id: "note-1",
  title: "Guide",
  body: "line1\nselected note text\nline3",
};

describe("shortcut commands", () => {
  test("registers Ctrl+Alt+B and toggles the AI sidebar", async () => {
    const commands = new RecordingCommandRegistry();
    const menuItems = new RecordingMenuItemRegistry();
    const panel = new RecordingShortcutPanel();

    await registerToggleSidebarShortcut(commands, menuItems, panel);
    expect(menuItems.items).toEqual([
      {
        id: "joplinAiAgent.toggleSidebarMenuItem",
        commandName: "joplinAiAgent.toggleSidebar",
        location: MenuItemLocation.Tools,
        accelerator: "Ctrl+Alt+B",
      },
    ]);

    await commands.commands[0]?.execute();
    expect(panel.toggleCount).toBe(1);
  });

  test("registers Ctrl+L and attaches a selection ref for the active note", async () => {
    const commands = new RecordingCommandRegistry();
    const menuItems = new RecordingMenuItemRegistry();
    const panel = new RecordingShortcutPanel();
    const lifecycle = {
      attachSelectionRef: jest.fn(
        async (_input: SelectionRefInput) => undefined,
      ),
    };

    await registerSelectionToChatShortcut(
      commands,
      menuItems,
      panel,
      new FakeSelectionSource("selected note text", sampleNote),
      richTextEditor,
      lifecycle,
    );
    expect(menuItems.items[0]).toEqual({
      id: "joplinAiAgent.addSelectionToChatMenuItem",
      commandName: "joplinAiAgent.addSelectionToChat",
      location: MenuItemLocation.Tools,
      accelerator: "Ctrl+L",
    });

    await commands.commands[0]?.execute();
    expect(panel.showCount).toBe(1);
    expect(lifecycle.attachSelectionRef).toHaveBeenCalledWith({
      noteId: "note-1",
      title: "Guide",
      body: sampleNote.body,
      selection: "selected note text",
    });
    expect(panel.events).toEqual([]);
  });

  test("opens the chat without attaching when the editor selection is empty", async () => {
    const commands = new RecordingCommandRegistry();
    const panel = new RecordingShortcutPanel();
    const lifecycle = {
      attachSelectionRef: jest.fn(
        async (_input: SelectionRefInput) => undefined,
      ),
    };
    await registerSelectionToChatShortcut(
      commands,
      new RecordingMenuItemRegistry(),
      panel,
      new FakeSelectionSource("", sampleNote),
      richTextEditor,
      lifecycle,
    );

    await commands.commands[0]?.execute();

    expect(panel.showCount).toBe(1);
    expect(lifecycle.attachSelectionRef).not.toHaveBeenCalled();
    expect(panel.events).toEqual([]);
  });

  test("falls back to text prefill when selection has no active note", async () => {
    const commands = new RecordingCommandRegistry();
    const panel = new RecordingShortcutPanel();
    const lifecycle = {
      attachSelectionRef: jest.fn(
        async (_input: SelectionRefInput) => undefined,
      ),
    };
    await registerSelectionToChatShortcut(
      commands,
      new RecordingMenuItemRegistry(),
      panel,
      new FakeSelectionSource("orphan selection", null),
      richTextEditor,
      lifecycle,
    );

    await commands.commands[0]?.execute();
    expect(lifecycle.attachSelectionRef).not.toHaveBeenCalled();
    expect(panel.events[0]).toMatchObject({
      type: "composer.prefill",
      payload: { text: "orphan selection" },
    });
  });

  test("registers Ctrl+Shift+L to start a new chat with a selection ref", async () => {
    const commands = new RecordingCommandRegistry();
    const menuItems = new RecordingMenuItemRegistry();
    const panel = new RecordingShortcutPanel();
    const lifecycle = {
      attachSelectionRef: jest.fn(
        async (_input: SelectionRefInput) => undefined,
      ),
      startNewChatWithSelection: jest.fn(
        async (_input: SelectionRefInput | null) => undefined,
      ),
    };

    await registerNewChatWithSelectionShortcut(
      commands,
      menuItems,
      panel,
      new FakeSelectionSource("selected for new chat", sampleNote),
      richTextEditor,
      lifecycle,
    );
    expect(menuItems.items[0]).toEqual({
      id: "joplinAiAgent.newChatWithSelectionMenuItem",
      commandName: "joplinAiAgent.newChatWithSelection",
      location: MenuItemLocation.Tools,
      accelerator: "Ctrl+Shift+L",
    });

    await commands.commands[0]?.execute();
    expect(panel.showCount).toBe(1);
    expect(lifecycle.startNewChatWithSelection).toHaveBeenCalledWith({
      noteId: "note-1",
      title: "Guide",
      body: sampleNote.body,
      selection: "selected for new chat",
    });
  });

  test("Ctrl+Shift+L still opens a new chat when selection is empty", async () => {
    const commands = new RecordingCommandRegistry();
    const panel = new RecordingShortcutPanel();
    const lifecycle = {
      attachSelectionRef: jest.fn(
        async (_input: SelectionRefInput) => undefined,
      ),
      startNewChatWithSelection: jest.fn(
        async (_input: SelectionRefInput | null) => undefined,
      ),
    };
    await registerNewChatWithSelectionShortcut(
      commands,
      new RecordingMenuItemRegistry(),
      panel,
      new FakeSelectionSource("", sampleNote),
      richTextEditor,
      lifecycle,
    );

    await commands.commands[0]?.execute();
    expect(panel.showCount).toBe(1);
    expect(lifecycle.startNewChatWithSelection).toHaveBeenCalledWith(null);
  });

  test("Ctrl+L prefers the Markdown editor line range over body matching", async () => {
    const commands = new RecordingCommandRegistry();
    const lifecycle = {
      attachSelectionRef: jest.fn(
        async (_input: SelectionRefInput) => undefined,
      ),
    };
    await registerSelectionToChatShortcut(
      commands,
      new RecordingMenuItemRegistry(),
      new RecordingShortcutPanel(),
      new FakeSelectionSource("stale editor text", sampleNote),
      new FakeEditorSelectionQuery({
        selection: "selected note text",
        startLine: 7,
        endLine: 25,
      }),
      lifecycle,
    );

    await commands.commands[0]?.execute();

    expect(lifecycle.attachSelectionRef).toHaveBeenCalledWith({
      noteId: "note-1",
      title: "Guide",
      body: sampleNote.body,
      selection: "selected note text",
      startLine: 7,
      endLine: 25,
    });
  });

  test("Ctrl+Shift+L carries Markdown editor line numbers into the new chat", async () => {
    const commands = new RecordingCommandRegistry();
    const lifecycle = {
      attachSelectionRef: jest.fn(
        async (_input: SelectionRefInput) => undefined,
      ),
      startNewChatWithSelection: jest.fn(
        async (_input: SelectionRefInput | null) => undefined,
      ),
    };
    await registerNewChatWithSelectionShortcut(
      commands,
      new RecordingMenuItemRegistry(),
      new RecordingShortcutPanel(),
      new FakeSelectionSource("", sampleNote),
      new FakeEditorSelectionQuery({
        selection: "line1\nselected note text",
        startLine: 1,
        endLine: 2,
      }),
      lifecycle,
    );

    await commands.commands[0]?.execute();

    expect(lifecycle.startNewChatWithSelection).toHaveBeenCalledWith({
      noteId: "note-1",
      title: "Guide",
      body: sampleNote.body,
      selection: "line1\nselected note text",
      startLine: 1,
      endLine: 2,
    });
  });
});
