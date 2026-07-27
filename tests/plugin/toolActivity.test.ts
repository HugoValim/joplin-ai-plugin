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
});
