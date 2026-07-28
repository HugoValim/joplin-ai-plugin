import {
  assertNoteOrgAllowed,
  assertNotebookAllowed,
  assertNoteReadable,
  filterAllowedNotebooks,
  filterAllowedNotes,
  noteScopedToolsEnabled,
  vaultOrgToolsEnabled,
} from "../../src/tools/noteAccessPolicy";
import { toolContext } from "../helpers/toolContext";

describe("noteAccessPolicy model B", () => {
  test("always enables vault-wide organization tools", () => {
    expect(vaultOrgToolsEnabled()).toBe(true);
  });

  test("enables note-scoped tools only for allowlisted notes", () => {
    expect(
      noteScopedToolsEnabled(
        toolContext({ readableNoteIds: new Set(["note-1"]) }),
      ),
    ).toBe(true);
    expect(noteScopedToolsEnabled(toolContext())).toBe(false);
  });

  test("filters secret notebooks and notes", () => {
    const context = toolContext({ secretNotebookIds: new Set(["nb-secret"]) });
    expect(
      filterAllowedNotebooks(context, [
        { id: "nb-open", title: "Open" },
        { id: "nb-secret", title: "Secret" },
      ]).map((notebook) => notebook.id),
    ).toEqual(["nb-open"]);
    expect(
      filterAllowedNotes(context, [
        { id: "note-1", parentId: "nb-open" },
        { id: "note-2", parent_id: "nb-secret" },
      ]).map((note) => note.id),
    ).toEqual(["note-1"]);
  });

  test("rejects secret notebook operations and attached notes in secret notebooks", () => {
    const context = toolContext({
      readableNoteIds: new Set(["note-attached"]),
      secretNotebookIds: new Set(["nb-secret"]),
    });

    expect(() => assertNotebookAllowed(context, "nb-secret")).toThrow(
      "marked secret",
    );
    expect(() =>
      assertNoteReadable(context, "note-attached", "nb-secret"),
    ).toThrow("marked secret");
  });

  test("allows organization on non-secret notes without active or attached allowlist", () => {
    const context = toolContext({ readableNoteIds: new Set() });
    expect(() => assertNoteOrgAllowed(context, "nb-open")).not.toThrow();
    expect(() =>
      assertNoteOrgAllowed(
        toolContext({ secretNotebookIds: new Set(["nb-secret"]) }),
        "nb-secret",
      ),
    ).toThrow("marked secret");
  });
});
