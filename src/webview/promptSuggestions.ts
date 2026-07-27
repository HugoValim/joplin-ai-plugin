import type { ActiveNoteSummary, SidebarSnapshot } from "./sidebarState";

/**
 * Builds short suggestions from enabled, visible context only.
 *
 * @example promptSuggestions(chat, activeNote)
 */
export function promptSuggestions(
  chat: NonNullable<SidebarSnapshot["activeChat"]>,
  activeNote: ActiveNoteSummary,
): readonly string[] {
  const suggestions: string[] = [];
  if (chat.context.activeNote && activeNote) {
    suggestions.push(`Summarise ${activeNote.title}`);
  }
  if (chat.context.attachedNoteIds.length > 1) {
    suggestions.push("Compare my attached notes");
  }
  if (chat.context.vault) suggestions.push("Find related notes in my vault");
  if (chat.externalRoot) suggestions.push("Review files in my selected folder");
  suggestions.push("Draft clear next steps");
  return suggestions.slice(0, 3);
}
