/** @jest-environment jsdom */

import {
  canAcceptNoteDrop,
  dropKindFromDataTransfer,
  mentionHitFromDataTransfer,
  parseNoteDropPayload,
} from "../../src/webview/noteDrop";

function fakeDataTransfer(
  values: Record<string, string>,
  types: readonly string[] = Object.keys(values),
): DataTransfer {
  return {
    types,
    getData: (type: string) => values[type] ?? "",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

describe("canAcceptNoteDrop", () => {
  test("accepts dragover when Joplin MIME types are present but getData is empty", () => {
    const data = fakeDataTransfer({}, ["text/x-jop-note-ids"]);
    expect(canAcceptNoteDrop(data)).toBe(true);
  });

  test("accepts notebook dragover MIME types without payload", () => {
    const data = fakeDataTransfer({}, ["text/x-jop-folder-ids"]);
    expect(canAcceptNoteDrop(data)).toBe(true);
  });

  test("accepts empty types so isolated iframes can still drop", () => {
    expect(canAcceptNoteDrop(fakeDataTransfer({}, []))).toBe(true);
  });

  test("rejects dragover with unrelated MIME types and empty payload", () => {
    const data = fakeDataTransfer({}, ["text/plain", "Files"]);
    expect(canAcceptNoteDrop(data)).toBe(false);
  });
});

describe("dropKindFromDataTransfer", () => {
  test("returns note when note MIME is present", () => {
    expect(
      dropKindFromDataTransfer(fakeDataTransfer({}, ["text/x-jop-note-ids"])),
    ).toBe("note");
  });

  test("returns notebook when folder MIME is present", () => {
    expect(
      dropKindFromDataTransfer(fakeDataTransfer({}, ["text/x-jop-folder-ids"])),
    ).toBe("notebook");
  });

  test("returns auto when types are empty", () => {
    expect(dropKindFromDataTransfer(fakeDataTransfer({}, []))).toBe("auto");
  });
});

describe("parseNoteDropPayload", () => {
  test("parses all dragged note ids", () => {
    const data = fakeDataTransfer({
      "text/x-jop-note-ids": JSON.stringify(["note-1", "note-2"]),
    });
    expect(parseNoteDropPayload(data)).toEqual({
      kind: "note",
      ids: ["note-1", "note-2"],
    });
  });

  test("parses notebook ids", () => {
    const data = fakeDataTransfer({
      "text/x-jop-folder-ids": JSON.stringify(["notebook-9"]),
    });
    expect(parseNoteDropPayload(data)).toEqual({
      kind: "notebook",
      ids: ["notebook-9"],
    });
  });
});

describe("mentionHitFromDataTransfer", () => {
  test("parses a dragged note id into a note mention hit", () => {
    const data = fakeDataTransfer({
      "text/x-jop-note-ids": JSON.stringify(["note-123"]),
    });
    expect(mentionHitFromDataTransfer(data)).toEqual({
      kind: "note",
      id: "note-123",
      title: "note-123",
    });
  });

  test("parses a dragged notebook id into a notebook mention hit", () => {
    const data = fakeDataTransfer({
      "text/x-jop-folder-ids": JSON.stringify(["notebook-9"]),
    });
    expect(mentionHitFromDataTransfer(data)).toEqual({
      kind: "notebook",
      id: "notebook-9",
      title: "notebook-9",
    });
  });

  test("returns null when there is no recognizable payload", () => {
    expect(mentionHitFromDataTransfer(fakeDataTransfer({}))).toBeNull();
  });
});
