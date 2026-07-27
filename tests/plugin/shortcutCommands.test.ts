import { MenuItemLocation } from "../../api/types";
import {
  registerSelectionToChatShortcut,
  registerToggleSidebarShortcut,
} from "../../src/plugin/shortcutCommands";
import type { PluginEvent } from "../../src/shared/protocol";

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

class SelectedTextSource {
  public constructor(private readonly text: string) {}

  public async selectedText(): Promise<string> {
    return this.text;
  }
}

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

  test("registers Ctrl+L and copies the editor selection into the chat", async () => {
    const commands = new RecordingCommandRegistry();
    const menuItems = new RecordingMenuItemRegistry();
    const panel = new RecordingShortcutPanel();

    await registerSelectionToChatShortcut(
      commands,
      menuItems,
      panel,
      new SelectedTextSource("selected note text"),
    );
    expect(menuItems.items[0]).toEqual({
      id: "joplinAiAgent.addSelectionToChatMenuItem",
      commandName: "joplinAiAgent.addSelectionToChat",
      location: MenuItemLocation.Tools,
      accelerator: "Ctrl+L",
    });

    await commands.commands[0]?.execute();
    expect(panel.showCount).toBe(1);
    expect(panel.events[0]).toMatchObject({
      version: 2,
      chatId: "bootstrap",
      type: "composer.prefill",
      payload: { text: "selected note text" },
    });
  });

  test("opens the chat without posting when the editor selection is empty", async () => {
    const commands = new RecordingCommandRegistry();
    const panel = new RecordingShortcutPanel();
    await registerSelectionToChatShortcut(
      commands,
      new RecordingMenuItemRegistry(),
      panel,
      new SelectedTextSource(""),
    );

    await commands.commands[0]?.execute();

    expect(panel.showCount).toBe(1);
    expect(panel.events).toEqual([]);
  });
});
