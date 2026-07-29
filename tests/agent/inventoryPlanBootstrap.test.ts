import {
  bootstrapPlanFromInventory,
  buildPlanItemsFromInventory,
  INVENTORY_PLAN_NOTES_PER_ITEM,
  planBootstrappedNudge,
} from "../../src/agent/inventoryPlanBootstrap";
import type { ProviderMessage } from "../../src/providers/types";

describe("inventoryPlanBootstrap", () => {
  test("builds plan items grouped by notebook in batches of five notes", () => {
    const messages = inventoryMessages([
      {
        notebookId: "nb-1",
        notebookTitle: "RF",
        notes: [
          "A",
          "B",
          "C",
          "D",
          "E",
          "F",
        ],
      },
    ]);

    const items = buildPlanItemsFromInventory(messages);
    expect(items).toHaveLength(2);
    expect(items[0]?.content).toContain("RF");
    expect(items[0]?.content).toContain("5 notes");
    expect(items[1]?.content).toContain("1 notes");
    expect(INVENTORY_PLAN_NOTES_PER_ITEM).toBe(5);
  });

  test("returns a validated plan or null when inventory is empty", () => {
    expect(bootstrapPlanFromInventory([])).toBeNull();
    const plan = bootstrapPlanFromInventory(
      inventoryMessages([
        { notebookId: "nb-1", notebookTitle: "Tools", notes: ["Phoebus"] },
      ]),
    );
    expect(plan?.items).toHaveLength(1);
    expect(plan?.items[0]?.status).toBe("pending");
  });

  test("planBootstrappedNudge names the checklist size", () => {
    expect(planBootstrappedNudge(9).content).toContain("9 checklist items");
  });
});

function inventoryMessages(
  notebooks: readonly {
    readonly notebookId: string;
    readonly notebookTitle: string;
    readonly notes: readonly string[];
  }[],
): ProviderMessage[] {
  const listNotebooksId = "list-nb";
  const noteCalls = notebooks.map((notebook, index) => ({
    id: `notes-${index + 1}`,
    name: "list_notebook_notes" as const,
    arguments: { notebook_id: notebook.notebookId },
  }));
  const messages: ProviderMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: listNotebooksId, name: "list_notebooks", arguments: {} },
        ...noteCalls,
      ],
    },
    {
      role: "tool",
      toolCallId: listNotebooksId,
      content: JSON.stringify({
        notebooks: notebooks.map((notebook) => ({
          id: notebook.notebookId,
          title: notebook.notebookTitle,
          parent_id: "",
        })),
      }),
    },
  ];
  for (const [index, notebook] of notebooks.entries()) {
    messages.push({
      role: "tool",
      toolCallId: `notes-${index + 1}`,
      content: JSON.stringify({
        notes: notebook.notes.map((title, noteIndex) => ({
          id: `${notebook.notebookId}-note-${noteIndex + 1}`,
          title,
          updated_time: 1,
          order: noteIndex,
        })),
      }),
    });
  }
  return messages;
}
