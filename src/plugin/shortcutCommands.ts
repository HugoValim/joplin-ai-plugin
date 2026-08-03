import { MenuItemLocation } from "api/types";
import { randomUUID } from "crypto";
import {
  PROTOCOL_VERSION,
  parsePluginEvent,
  type PluginEvent,
} from "../shared/protocol";
import type { EditorSelectionLineRange } from "../shared/editorSelectionRange";
import type { SelectionRefInput } from "../shared/selectionRef";
import type { EditorSelectionQuery } from "./editorSelectionRange";

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

export interface SelectionShortcutNote {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface SelectionShortcutSource {
  activeNote(): Promise<SelectionShortcutNote | null>;
  selectedText(): Promise<string>;
}

interface SelectionChatLifecycle {
  attachSelectionRef(input: SelectionRefInput): Promise<void>;
  startNewChatWithSelection(input: SelectionRefInput | null): Promise<void>;
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
 * Registers Ctrl+L to attach a line-range ref for the editor selection.
 *
 * @example await registerSelectionToChatShortcut(commands, menuItems, panel, source, editorSelection, lifecycle)
 */
export async function registerSelectionToChatShortcut(
  commands: ShortcutCommandRegistry,
  menuItems: ShortcutMenuRegistry,
  panel: SelectionPanel,
  source: SelectionShortcutSource,
  editorSelection: EditorSelectionQuery,
  lifecycle: Pick<SelectionChatLifecycle, "attachSelectionRef">,
): Promise<void> {
  const commandName = "joplinAiAgent.addSelectionToChat";
  await commands.register({
    name: commandName,
    label: "Add selection to AI chat",
    execute: async () => {
      const input = await resolveSelectionRefInput(source, editorSelection);
      await panel.show();
      if (!input) return;
      if (input.kind === "text") {
        panel.post(selectionPrefillEvent(input.text));
        return;
      }
      await lifecycle.attachSelectionRef(input.ref);
    },
  });
  await menuItems.create(
    "joplinAiAgent.addSelectionToChatMenuItem",
    commandName,
    MenuItemLocation.Tools,
    { accelerator: "Ctrl+L" },
  );
}

/**
 * Registers Ctrl+Shift+L to open a new AI chat with a selection line-range ref.
 *
 * @example await registerNewChatWithSelectionShortcut(commands, menuItems, panel, source, editorSelection, lifecycle)
 */
export async function registerNewChatWithSelectionShortcut(
  commands: ShortcutCommandRegistry,
  menuItems: ShortcutMenuRegistry,
  panel: SelectionPanel,
  source: SelectionShortcutSource,
  editorSelection: EditorSelectionQuery,
  lifecycle: SelectionChatLifecycle,
): Promise<void> {
  const commandName = "joplinAiAgent.newChatWithSelection";
  await commands.register({
    name: commandName,
    label: "New AI chat with selection",
    execute: async () => {
      const input = await resolveSelectionRefInput(source, editorSelection);
      await panel.show();
      if (!input) {
        await lifecycle.startNewChatWithSelection(null);
        return;
      }
      if (input.kind === "text") {
        await lifecycle.startNewChatWithSelection(null);
        panel.post(selectionPrefillEvent(input.text));
        return;
      }
      await lifecycle.startNewChatWithSelection(input.ref);
    },
  });
  await menuItems.create(
    "joplinAiAgent.newChatWithSelectionMenuItem",
    commandName,
    MenuItemLocation.Tools,
    { accelerator: "Ctrl+Shift+L" },
  );
}

type ResolvedSelection =
  | { readonly kind: "ref"; readonly ref: SelectionRefInput }
  | { readonly kind: "text"; readonly text: string }
  | null;

async function resolveSelectionRefInput(
  source: SelectionShortcutSource,
  editorSelection: EditorSelectionQuery,
): Promise<ResolvedSelection> {
  const editorRange = await editorSelection.lineRange();
  const selection = editorRange?.selection ?? (await source.selectedText());
  if (!selection.trim()) return null;
  const note = await source.activeNote();
  if (!note) return { kind: "text", text: selection };
  return {
    kind: "ref",
    ref: {
      noteId: note.id,
      title: note.title,
      body: note.body,
      selection,
      ...lineNumbers(editorRange),
    },
  };
}

function lineNumbers(
  range: EditorSelectionLineRange | null,
): Pick<SelectionRefInput, "startLine" | "endLine"> {
  if (!range) return {};
  return { startLine: range.startLine, endLine: range.endLine };
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
