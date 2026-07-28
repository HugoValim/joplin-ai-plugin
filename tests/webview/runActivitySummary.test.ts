import { formatRunActivitySummary } from "../../src/webview/runActivitySummary";
import type { ToolActivity } from "../../src/webview/sidebarState";

function tool(
  id: string,
  name: string,
  status: ToolActivity["status"] = "completed",
): ToolActivity {
  return { id, name, status };
}

describe("formatRunActivitySummary", () => {
  test("returns progress only when no tools ran yet", () => {
    expect(formatRunActivitySummary("Model step 3 of 200", [])).toBe(
      "Model step 3 of 200",
    );
  });

  test("returns empty text when there is no activity", () => {
    expect(formatRunActivitySummary("", [])).toBe("");
  });

  test("shows latest running tool and aggregate counts", () => {
    const tools = [
      ...Array.from({ length: 9 }, (_, index) =>
        tool(`search-${index}`, "search_notes"),
      ),
      tool("read-1", "read_note"),
      tool("read-2", "read_note"),
      tool("read-3", "read_note", "running"),
    ];
    expect(
      formatRunActivitySummary("Model step 61 of 200", tools),
    ).toBe("Model step 61 of 200 · read_note · 9×search_notes, 3×read_note");
  });

  test("uses last completed tool when none are running", () => {
    const tools = [tool("a", "search_notes"), tool("b", "read_note")];
    expect(formatRunActivitySummary("Thinking", tools)).toBe(
      "Thinking · read_note · search_notes, read_note",
    );
  });

  test("omits duplicate count for a single tool call", () => {
    const tools = [tool("a", "search_notes", "running")];
    expect(formatRunActivitySummary("Model step 1 of 200", tools)).toBe(
      "Model step 1 of 200 · search_notes · search_notes",
    );
  });
});
