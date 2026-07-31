import { MenuItemLocation } from "api/types";
import { randomUUID } from "crypto";
import {
  PROTOCOL_VERSION,
  parsePluginEvent,
  type PluginEvent,
} from "../shared/protocol";

interface ShortcutCommand {
  readonly name: string;
  readonly label: string;
  readonly execute: () => Promise<void>;
}

interface ShortcutCommandRegistry {
  register(command: ShortcutCommand): Promise<void>;
}

interface ShortcutMenuRegistry {
  create(
    id: string,
    commandName: string,
    location: MenuItemLocation,
    options: { readonly accelerator: string },
  ): Promise<void>;
}

interface VisibilityPanel {
  toggleVisibility(): Promise<void>;
}

interface SelectionPanel {
  show(): Promise<void>;
  post(event: PluginEvent): void;
}

interface SelectedTextSource {
  selectedText(): Promise<string>;
}

/**
 * Registers the global shortcut that shows or hides the AI sidebar.
 *
 * @example await registerToggleSidebarShortcut(commands, menuItems, panel)
 */
export async function registerToggleSidebarShortcut(
  commands: ShortcutCommandRegistry,
  menuItems: ShortcutMenuRegistry,
  panel: VisibilityPanel,
): Promise<void> {
  const commandName = "joplinAiAgent.toggleSidebar";
  await commands.register({
    name: commandName,
    label: "Toggle AI sidebar",
    execute: () => panel.toggleVisibility(),
  });
  await menuItems.create(
    "joplinAiAgent.toggleSidebarMenuItem",
    commandName,
    MenuItemLocation.Tools,
    { accelerator: "Ctrl+Alt+B" },
  );
}

/**
 * Registers the shortcut that appends editor selection to the chat composer.
 *
 * @example await registerSelectionToChatShortcut(commands, menuItems, panel, source)
 */
export async function registerSelectionToChatShortcut(
  commands: ShortcutCommandRegistry,
  menuItems: ShortcutMenuRegistry,
  panel: SelectionPanel,
  source: SelectedTextSource,
): Promise<void> {
  const command = selectionShortcutCommand(panel, source);
  await commands.register(command);
  await menuItems.create(
    "joplinAiAgent.addSelectionToChatMenuItem",
    command.name,
    MenuItemLocation.Tools,
    { accelerator: "Ctrl+L" },
  );
}

function selectionShortcutCommand(
  panel: SelectionPanel,
  source: SelectedTextSource,
): ShortcutCommand {
  return {
    name: "joplinAiAgent.addSelectionToChat",
    label: "Add selection to AI chat",
    execute: async () => {
      const text = await source.selectedText();
      await panel.show();
      if (text) panel.post(selectionPrefillEvent(text));
    },
  };
}

function selectionPrefillEvent(text: string): PluginEvent {
  return parsePluginEvent({
    version: PROTOCOL_VERSION,
    messageId: randomUUID(),
    chatId: "bootstrap",
    type: "composer.prefill",
    payload: { text },
  });
}

interface NewChatFactory {
  createNewChat(): Promise<string>;
}

/**
 * Registers the shortcut that opens a new AI chat and pastes the editor
 * selection into its composer. Distinct from `Ctrl+L`, which appends to the
 * current chat.
 *
 * @example await registerNewChatSelectionShortcut(commands, menuItems, panel, source, factory)
 */
export async function registerNewChatSelectionShortcut(
  commands: ShortcutCommandRegistry,
  menuItems: ShortcutMenuRegistry,
  panel: SelectionPanel,
  source: SelectedTextSource,
  factory: NewChatFactory,
): Promise<void> {
  const command = newChatSelectionShortcutCommand(panel, source, factory);
  await commands.register(command);
  await menuItems.create(
    "joplinAiAgent.newChatSelectionMenuItem",
    command.name,
    MenuItemLocation.Tools,
    { accelerator: "Ctrl+Shift+L" },
  );
}

function newChatSelectionShortcutCommand(
  panel: SelectionPanel,
  source: SelectedTextSource,
  factory: NewChatFactory,
): ShortcutCommand {
  return {
    name: "joplinAiAgent.newChatSelection",
    label: "New AI chat with selection",
    execute: async () => {
      const text = await source.selectedText();
      const chatId = await factory.createNewChat();
      await panel.show();
      if (text) panel.post(selectionPrefillEventForChat(text, chatId));
    },
  };
}

function selectionPrefillEventForChat(
  text: string,
  chatId: string,
): PluginEvent {
  return parsePluginEvent({
    version: PROTOCOL_VERSION,
    messageId: randomUUID(),
    chatId,
    type: "composer.prefill",
    payload: { text, replace: true },
  });
}
