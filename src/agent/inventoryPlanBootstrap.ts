import type { ProviderMessage } from "../providers/types";
import {
  AGENT_PLAN_ITEM_CONTENT_MAX,
  AGENT_PLAN_MAX_ITEMS,
  setAgentPlan,
  type AgentPlan,
  type AgentPlanItemInput,
} from "./agentPlan";

/** Notes per auto-generated plan item (matches FIXED RULES batch size). */
export const INVENTORY_PLAN_NOTES_PER_ITEM = 5;

interface NotebookRef {
  readonly id: string;
  readonly title: string;
}

interface NoteRef {
  readonly id: string;
  readonly title: string;
  readonly notebookId: string;
}

/**
 * Builds an agent plan from prior list_notebooks / list_notebook_notes tool
 * results when the model fails to call set_agent_plan after inventory.
 *
 * @example const plan = bootstrapPlanFromInventory(messages)
 */
export function bootstrapPlanFromInventory(
  messages: readonly ProviderMessage[],
): AgentPlan | null {
  const items = buildPlanItemsFromInventory(messages);
  if (!items.length) return null;
  return setAgentPlan(items);
}

/**
 * Derives checklist items from inventory tool outputs in the message history.
 *
 * @example buildPlanItemsFromInventory(messages)
 */
export function buildPlanItemsFromInventory(
  messages: readonly ProviderMessage[],
): AgentPlanItemInput[] {
  const notebooks = new Map<string, string>();
  const notesByNotebook = new Map<string, NoteRef[]>();
  const toolResults = indexToolResults(messages);

  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      const raw = toolResults.get(call.id);
      if (!raw) continue;
      if (call.name === "list_notebooks") {
        for (const notebook of parseNotebooks(raw)) {
          notebooks.set(notebook.id, notebook.title);
        }
        continue;
      }
      if (call.name !== "list_notebook_notes") continue;
      const notebookId = stringArg(call.arguments, "notebook_id");
      if (!notebookId) continue;
      const existing = notesByNotebook.get(notebookId) ?? [];
      for (const note of parseNotes(raw, notebookId)) {
        if (existing.some((item) => item.id === note.id)) continue;
        existing.push(note);
      }
      notesByNotebook.set(notebookId, existing);
    }
  }

  return planItemsFromNotes(notebooks, notesByNotebook);
}

function planItemsFromNotes(
  notebooks: ReadonlyMap<string, string>,
  notesByNotebook: ReadonlyMap<string, readonly NoteRef[]>,
): AgentPlanItemInput[] {
  const items: AgentPlanItemInput[] = [];
  let itemIndex = 1;
  for (const [notebookId, notes] of notesByNotebook) {
    if (!notes.length) continue;
    const notebookTitle = notebooks.get(notebookId) ?? "Notebook";
    for (let offset = 0; offset < notes.length; offset += INVENTORY_PLAN_NOTES_PER_ITEM) {
      if (items.length >= AGENT_PLAN_MAX_ITEMS) return items;
      const batch = notes.slice(offset, offset + INVENTORY_PLAN_NOTES_PER_ITEM);
      const titles = batch.map((note) => note.title).join(", ");
      const content = truncateContent(
        `Read & propose readability: ${notebookTitle} (${batch.length} notes — ${titles})`,
      );
      items.push({ id: String(itemIndex), content });
      itemIndex += 1;
    }
  }
  return items;
}

/**
 * System nudge after the plugin bootstraps a plan from inventory.
 *
 * @example messages.push(planBootstrappedNudge(plan.items.length))
 */
export function planBootstrappedNudge(itemCount: number): ProviderMessage {
  return {
    role: "system",
    content: [
      `PLAN BOOTSTRAPPED: The plugin set an agent plan with ${itemCount} checklist items from inventory because chat-only replies blocked progress.`,
      "Do not re-inventory. Mark the first item in_progress, read at most 5 note bodies from that item, and call propose-write tools for that batch now.",
    ].join(" "),
  };
}

function indexToolResults(
  messages: readonly ProviderMessage[],
): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue;
    results.set(message.toolCallId, message.content);
  }
  return results;
}

function parseNotebooks(raw: string): NotebookRef[] {
  const parsed = parseJsonObject(raw);
  const notebooks = parsed?.["notebooks"];
  if (!Array.isArray(notebooks)) return [];
  const result: NotebookRef[] = [];
  for (const entry of notebooks) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"] : "";
    const title = typeof record["title"] === "string" ? record["title"] : "";
    if (id && title) result.push({ id, title });
  }
  return result;
}

function parseNotes(raw: string, notebookId: string): NoteRef[] {
  const parsed = parseJsonObject(raw);
  const notes = parsed?.["notes"];
  if (!Array.isArray(notes)) return [];
  const result: NoteRef[] = [];
  for (const entry of notes) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"] : "";
    const title = typeof record["title"] === "string" ? record["title"] : "";
    if (id && title) result.push({ id, title, notebookId });
  }
  return result;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncateContent(content: string): string {
  if (content.length <= AGENT_PLAN_ITEM_CONTENT_MAX) return content;
  return `${content.slice(0, AGENT_PLAN_ITEM_CONTENT_MAX - 1)}…`;
}
