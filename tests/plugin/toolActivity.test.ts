import { summarizeToolResult } from "../../src/plugin/toolActivity";

describe("summarizeToolResult", () => {
  test("shows bounded bulk scan preflight counts", () => {
    expect(
      summarizeToolResult({
        toolCallId: "call-1",
        name: "review_text_files",
        risk: "propose-write",
        output: { file_count: 3, total_bytes: 2048, change_ids: [] },
      }),
    ).toBe("Preflight: 3 files, 2048 bytes");
  });

  test("does not expose arbitrary read-tool output", () => {
    expect(
      summarizeToolResult({
        toolCallId: "call-1",
        name: "read_note",
        risk: "read",
        output: { body: "private note contents" },
      }),
    ).toBe("Completed");
  });

  test("labels writes as proposals without claiming review mode", () => {
    expect(
      summarizeToolResult({
        toolCallId: "call-write",
        name: "create_note",
        risk: "propose-write",
        output: { change_id: "change-1" },
      }),
    ).toBe("Added to proposed batch");
  });

  test("summarizes subagent completion with a short findings preview", () => {
    expect(
      summarizeToolResult({
        toolCallId: "spawn-1",
        name: "start_subagent",
        risk: "meta",
        output: {
          subagent_id: "sub-a",
          status: "completed",
          message: "finished",
          result_text: "Notebook A has three notes about travel.",
          active_count: 0,
        },
      }),
    ).toBe("Subagent sub-a: completed: Notebook A has three notes about travel.");
  });
});
